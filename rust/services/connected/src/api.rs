use std::time::Duration;

use aws_sdk_s3::Client as S3Client;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use job_contracts::CONNECTED_SCHEMA_VERSION;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use tower_http::{
    catch_panic::CatchPanicLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};

use crate::{
    config::Config,
    identity::{IdentityClaims, personal_tenant_id, verify},
    job_api, upload_api,
};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) pool: PgPool,
    pub(crate) redis: redis::Client,
    pub(crate) s3: S3Client,
    pub(crate) config: Config,
}

#[derive(Debug)]
pub(crate) struct ApiError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ApiError {
    pub(crate) fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn internal(_message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error",
            message: "The operation could not be completed. Retry using the request ID.".into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

pub(crate) type ApiResult<T> = Result<T, ApiError>;

pub(crate) fn claims(headers: &HeaderMap, state: &AppState) -> ApiResult<IdentityClaims> {
    verify(headers, state.config.bff_secret.as_bytes()).map_err(|error| ApiError {
        status: StatusCode::UNAUTHORIZED,
        code: "invalid_identity",
        message: error.to_string(),
    })
}

pub(crate) async fn tenant_tx<'a>(
    pool: &'a PgPool,
    tenant_id: &str,
) -> ApiResult<Transaction<'a, Postgres>> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    sqlx::query("SELECT set_config('variantlab.tenant_id', $1, true)")
        .bind(tenant_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(tx)
}

pub(crate) async fn authorized_tx<'a>(
    pool: &'a PgPool,
    identity: &IdentityClaims,
    write: bool,
) -> ApiResult<Transaction<'a, Postgres>> {
    let mut tx = tenant_tx(pool, &identity.tenant_id).await?;
    let row = sqlx::query("SELECT role FROM memberships WHERE tenant_id=$1 AND actor_id=$2")
        .bind(&identity.tenant_id)
        .bind(&identity.actor_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| {
            ApiError::forbidden("membership_required", "workspace membership is required")
        })?;
    let stored_role: String = row.get("role");
    if stored_role != identity.role {
        return Err(ApiError::forbidden(
            "role_mismatch",
            "signed role no longer matches durable membership",
        ));
    }
    if write && stored_role == "reviewer" {
        return Err(ApiError::forbidden(
            "write_forbidden",
            "reviewer membership cannot mutate connected jobs",
        ));
    }
    Ok(tx)
}

pub async fn serve(config: Config) -> Result<(), String> {
    let pool = config.pool().await.map_err(|error| error.to_string())?;
    let state = AppState {
        pool,
        redis: redis::Client::open(config.redis_url.clone()).map_err(|error| error.to_string())?,
        s3: config.s3().await,
        config: config.clone(),
    };
    let request_id = header::HeaderName::from_static("x-request-id");
    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/v1/workspace", get(workspace))
        .merge(upload_api::routes())
        .merge(job_api::routes())
        .merge(crate::sync_api::routes())
        .merge(crate::review_api::routes())
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
        ))
        .layer(PropagateRequestIdLayer::new(request_id.clone()))
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid))
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .map_err(|error| error.to_string())?;
    tracing::info!(bind = %config.bind, "VariantLab connected API ready");
    axum::serve(listener, app)
        .await
        .map_err(|error| error.to_string())
}

async fn live() -> Json<Value> {
    Json(json!({ "status": "live", "service": "variantlab-connected" }))
}

async fn ready(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1")
        .execute(&state.pool)
        .await
        .map_err(|error| ApiError::internal(format!("postgres: {error}")))?;
    let mut redis = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| ApiError::internal(format!("redis: {error}")))?;
    let pong: String = redis::cmd("PING")
        .query_async(&mut redis)
        .await
        .map_err(|error| ApiError::internal(format!("redis: {error}")))?;
    state
        .s3
        .head_bucket()
        .bucket(&state.config.s3_bucket)
        .send()
        .await
        .map_err(|error| ApiError::internal(format!("object_storage: {error}")))?;
    Ok(Json(json!({
        "status": "ready",
        "postgres": "ready",
        "redis": pong,
        "object_storage": "ready",
        "codec": "ffmpeg-7.1.1-lgpl-vp9-opus",
        "public_api_url": state.config.public_api_url
    })))
}

async fn workspace(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &state)?;
    if identity.tenant_id != personal_tenant_id(&identity.actor_id) || identity.role != "owner" {
        return Err(ApiError::forbidden(
            "invalid_workspace_bootstrap",
            "only the signed owner may bootstrap their deterministic personal workspace",
        ));
    }
    let mut tx = tenant_tx(&state.pool, &identity.tenant_id).await?;
    sqlx::query("INSERT INTO tenants (id,name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING")
        .bind(&identity.tenant_id)
        .bind("VariantLab connected workspace")
        .execute(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    sqlx::query("INSERT INTO memberships (tenant_id,actor_id,role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING")
        .bind(&identity.tenant_id)
        .bind(&identity.actor_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(json!({
        "schema_version": CONNECTED_SCHEMA_VERSION,
        "tenant_id": identity.tenant_id,
        "workspace_name": "VariantLab connected workspace",
        "connected": true,
        "max_batch_cells": 50,
        "job_progress_budget_ms": Duration::from_secs(2).as_millis()
    })))
}

#[cfg(test)]
mod privacy_tests {
    #[test]
    fn internal_error_never_exposes_provider_secrets() {
        let error = super::ApiError::internal(
            "postgresql://secret:password@host/db?X-Amz-Signature=private",
        );
        assert_eq!(
            error.message,
            "The operation could not be completed. Retry using the request ID."
        );
    }
}
