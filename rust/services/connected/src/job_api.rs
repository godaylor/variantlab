use std::{collections::BTreeSet, convert::Infallible, time::Duration};

use aws_sdk_s3::presigning::PresigningConfig;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
};
use chrono::Utc;
use futures_util::Stream;
use job_contracts::{RenderJobSpec, create_connected_render_batch};
use render_plan::RenderManifest;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use studio_model::{StudioState, snapshot_hash};
use uuid::Uuid;

use crate::api::{ApiError, ApiResult, AppState, authorized_tx, claims};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/batches", post(create_batch).get(list_batches))
        .route("/v1/batches/{batch_id}/jobs", get(list_jobs))
        .route("/v1/batches/{batch_id}/events", get(job_events))
        .route(
            "/v1/batches/{batch_id}/retry-failed",
            post(retry_failed_batch),
        )
        .route("/v1/jobs/{job_id}/cancel", post(cancel_job))
        .route("/v1/jobs/{job_id}/retry", post(retry_job))
        .route("/v1/jobs/{job_id}/artifact", get(artifact_link))
}

async fn list_batches(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &state)?;
    let mut tx = authorized_tx(&state.pool, &identity, false).await?;
    let rows = sqlx::query("SELECT id,campaign_id,campaign_revision FROM render_batches WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50")
        .bind(&identity.tenant_id).fetch_all(&mut *tx).await.map_err(|error| ApiError::internal(error.to_string()))?;
    let batches = rows.into_iter().map(|row| json!({"id":row.get::<Uuid,_>("id"),"campaign_id":row.get::<String,_>("campaign_id"),"revision":row.get::<i32,_>("campaign_revision")})).collect::<Vec<_>>();
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(json!({"batches":batches})))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBatchRequest {
    campaign_id: String,
    campaign_revision: u32,
    snapshot_sha256: String,
    snapshot: Value,
    source_asset_sha256: String,
    jobs: Vec<CreateJobRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateJobRequest {
    spec: RenderJobSpec,
    render_manifest: Value,
}

#[derive(Debug, Serialize)]
struct JobView {
    id: String,
    cell_id: String,
    state: String,
    phase: String,
    progress_milli: i32,
    attempt: i32,
    failure: Option<Value>,
    artifact_ready: bool,
    updated_at: String,
}

async fn create_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateBatchRequest>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &state)?;
    if request.snapshot_sha256.len() != 64
        || request.source_asset_sha256.len() != 64
        || request.campaign_revision > i32::MAX as u32
    {
        return Err(ApiError::bad_request(
            "invalid_sha256",
            "snapshot and source hashes must be SHA-256",
        ));
    }
    let frozen_state: StudioState = serde_json::from_value(request.snapshot.clone())
        .map_err(|error| ApiError::bad_request("invalid_snapshot", error.to_string()))?;
    let actual_snapshot_hash = snapshot_hash(&frozen_state)
        .map_err(|error| ApiError::bad_request("invalid_snapshot", error.to_string()))?;
    if actual_snapshot_hash != request.snapshot_sha256
        || frozen_state.campaign.id != request.campaign_id
        || frozen_state.campaign.revision != request.campaign_revision
    {
        return Err(ApiError::bad_request(
            "snapshot_mismatch",
            "campaign snapshot identity or checksum does not match",
        ));
    }
    let mut required_assets = BTreeSet::new();
    for job in &request.jobs {
        let manifest: RenderManifest = serde_json::from_value(job.render_manifest.clone())
            .map_err(|error| ApiError::bad_request("invalid_manifest", error.to_string()))?;
        required_assets.extend(
            render_plan::validate_connected_manifest(&frozen_state, &job.spec, &manifest)
                .map_err(|code| ApiError::bad_request(code, code))?,
        );
    }
    let mut tx = authorized_tx(&state.pool, &identity, true).await?;
    let required_assets = required_assets.into_iter().collect::<Vec<_>>();
    let available: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM media_assets WHERE tenant_id=$1 AND asset_hash=ANY($2::text[])",
    )
    .bind(&identity.tenant_id)
    .bind(&required_assets)
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;
    if available != required_assets.len() as i64 {
        return Err(ApiError::bad_request(
            "manifest_assets_missing",
            "upload every explicitly required original before submitting the batch",
        ));
    }
    let source =
        sqlx::query("SELECT object_key FROM media_assets WHERE tenant_id=$1 AND asset_hash=$2")
            .bind(&identity.tenant_id)
            .bind(&request.source_asset_sha256)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| {
                ApiError::not_found(
                    "source_asset_missing",
                    "source asset must be uploaded first",
                )
            })?;
    let source_object_key: String = source.get("object_key");

    let succeeded =
        sqlx::query("SELECT idempotency_key FROM jobs WHERE tenant_id=$1 AND state='succeeded'")
            .bind(&identity.tenant_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .into_iter()
            .map(|row| row.get::<String, _>("idempotency_key"))
            .collect::<BTreeSet<_>>();
    let manifests = request
        .jobs
        .iter()
        .map(|job| {
            (
                job.spec.idempotency_key.clone(),
                job.render_manifest.clone(),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let batch_id = Uuid::new_v4();
    let batch = create_connected_render_batch(
        identity.tenant_id.clone(),
        batch_id.to_string(),
        request.jobs.into_iter().map(|job| job.spec).collect(),
        &succeeded,
        Utc::now().to_rfc3339(),
    )
    .map_err(|error| ApiError::bad_request("invalid_batch", error.to_string()))?;

    sqlx::query(
        "INSERT INTO campaigns (tenant_id,id,name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    )
    .bind(&identity.tenant_id)
    .bind(&request.campaign_id)
    .bind(&request.campaign_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;
    sqlx::query("SELECT id FROM campaigns WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(&identity.tenant_id)
        .bind(&request.campaign_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let connected_head: Option<String> = sqlx::query_scalar(
        "SELECT snapshot_sha256 FROM sync_heads WHERE tenant_id=$1 AND campaign_id=$2",
    )
    .bind(&identity.tenant_id)
    .bind(&request.campaign_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;
    if connected_head.is_some_and(|hash| hash != request.snapshot_sha256) {
        return Err(ApiError {
            status: axum::http::StatusCode::CONFLICT,
            code: "sync_revision_first",
            message: "Sync this revision before cloud rendering".into(),
        });
    }
    let persisted_revision = sqlx::query(include_str!("revision_snapshot.sql"))
        .bind(&identity.tenant_id)
        .bind(&request.campaign_id)
        .bind(request.campaign_revision as i32)
        .bind(&request.snapshot_sha256)
        .bind(&request.snapshot)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if persisted_revision.is_none() {
        return Err(ApiError {
            status: axum::http::StatusCode::CONFLICT,
            code: "revision_snapshot_conflict",
            message: "this campaign revision already contains a different snapshot".into(),
        });
    }
    sqlx::query("INSERT INTO render_batches (tenant_id,id,campaign_id,campaign_revision,requested_by) VALUES ($1,$2,$3,$4,$5)")
        .bind(&identity.tenant_id)
        .bind(batch_id)
        .bind(&request.campaign_id)
        .bind(request.campaign_revision as i32)
        .bind(&identity.actor_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;

    for job in &batch.jobs {
        let manifest = manifests
            .get(&job.spec.idempotency_key)
            .ok_or_else(|| ApiError::internal("validated manifest disappeared"))?;
        sqlx::query("INSERT INTO jobs (tenant_id,id,batch_id,cell_id,idempotency_key,spec,render_manifest,source_object_key,state,phase) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued','preflight')")
            .bind(&identity.tenant_id)
            .bind(&job.spec.job_id)
            .bind(batch_id)
            .bind(&job.spec.cell_id)
            .bind(&job.spec.idempotency_key)
            .bind(serde_json::to_value(&job.spec).map_err(|error| ApiError::internal(error.to_string()))?)
            .bind(manifest)
            .bind(&source_object_key)
            .execute(&mut *tx)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        sqlx::query("INSERT INTO job_attempts (tenant_id,job_id,attempt) VALUES ($1,$2,1)")
            .bind(&identity.tenant_id)
            .bind(&job.spec.job_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        sqlx::query("INSERT INTO outbox_events (tenant_id,aggregate_id,event_type,payload) VALUES ($1,$2,'render_job_queued',$3)")
            .bind(&identity.tenant_id)
            .bind(&job.spec.job_id)
            .bind(json!({"tenant_id": identity.tenant_id, "job_id": job.spec.job_id}))
            .execute(&mut *tx)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
    }
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(json!({
        "batch_id": batch.batch_id,
        "job_count": batch.jobs.len(),
        "skipped_succeeded_idempotency_keys": batch.skipped_succeeded_idempotency_keys
    })))
}

async fn fetch_jobs(
    state: &AppState,
    headers: &HeaderMap,
    batch_id: Uuid,
) -> ApiResult<Vec<JobView>> {
    let identity = claims(headers, state)?;
    let mut tx = authorized_tx(&state.pool, &identity, false).await?;
    let rows = sqlx::query(
        "SELECT j.id,j.cell_id,j.state,j.phase,j.progress_milli,j.attempt,j.failure,j.updated_at, EXISTS(SELECT 1 FROM export_artifacts a WHERE a.tenant_id=j.tenant_id AND a.job_id=j.id) AS artifact_ready FROM jobs j WHERE j.tenant_id=$1 AND j.batch_id=$2 ORDER BY j.created_at,j.id",
    )
    .bind(&identity.tenant_id)
    .bind(batch_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(rows
        .into_iter()
        .map(|row| JobView {
            id: row.get("id"),
            cell_id: row.get("cell_id"),
            state: row.get("state"),
            phase: row.get("phase"),
            progress_milli: row.get("progress_milli"),
            attempt: row.get("attempt"),
            failure: row.try_get("failure").ok(),
            artifact_ready: row.get("artifact_ready"),
            updated_at: row
                .get::<chrono::DateTime<Utc>, _>("updated_at")
                .to_rfc3339(),
        })
        .collect())
}

async fn list_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(batch_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({"jobs": fetch_jobs(&state, &headers, batch_id).await?}),
    ))
}

async fn job_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(batch_id): Path<Uuid>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    claims(&headers, &state)?;
    let stream = async_stream::stream! {
        let mut ticker = tokio::time::interval(Duration::from_millis(750));
        loop {
            ticker.tick().await;
            match fetch_jobs(&state, &headers, batch_id).await {
                Ok(jobs) => {
                    let terminal = jobs.iter().all(|job| matches!(job.state.as_str(), "succeeded" | "failed" | "cancelled"));
                    yield Ok(Event::default().event("jobs").json_data(json!({"jobs": jobs})).unwrap());
                    if terminal { break; }
                }
                Err(error) => {
                    yield Ok(Event::default().event("error").data(error.message));
                    break;
                }
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(10))))
}

async fn cancel_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &state)?;
    let mut tx = authorized_tx(&state.pool, &identity, true).await?;
    let result = sqlx::query("UPDATE jobs SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancelling' END, phase='cancelling', updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state IN ('queued','preparing','running','pausing','paused') RETURNING state")
        .bind(&identity.tenant_id).bind(&job_id).fetch_optional(&mut *tx).await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::bad_request("job_not_cancellable", "job is already terminal or missing"))?;
    let state_name: String = result.get("state");
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(json!({"job_id": job_id, "state": state_name})))
}

async fn retry_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &state)?;
    let mut tx = authorized_tx(&state.pool, &identity, true).await?;
    let row = sqlx::query("UPDATE jobs SET state='queued',phase='preflight',progress_milli=0,attempt=attempt+1,failure=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='failed' AND COALESCE((failure->>'retryable')::boolean,false)=true RETURNING attempt")
        .bind(&identity.tenant_id).bind(&job_id).fetch_optional(&mut *tx).await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::bad_request("job_not_retryable", "only retryable failed jobs may be retried"))?;
    let attempt: i32 = row.get("attempt");
    sqlx::query("INSERT INTO job_attempts (tenant_id,job_id,attempt) VALUES ($1,$2,$3)")
        .bind(&identity.tenant_id)
        .bind(&job_id)
        .bind(attempt)
        .execute(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    sqlx::query("INSERT INTO outbox_events (tenant_id,aggregate_id,event_type,payload) VALUES ($1,$2,'render_job_retried',$3)")
        .bind(&identity.tenant_id).bind(&job_id).bind(json!({"tenant_id": identity.tenant_id, "job_id": job_id}))
        .execute(&mut *tx).await.map_err(|error| ApiError::internal(error.to_string()))?;
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(
        json!({"job_id": job_id, "state": "queued", "attempt": attempt}),
    ))
}

async fn retry_failed_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(batch_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &state)?;
    let mut tx = authorized_tx(&state.pool, &identity, true).await?;
    let rows = sqlx::query("UPDATE jobs SET state='queued',phase='preflight',progress_milli=0,attempt=attempt+1,failure=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND batch_id=$2 AND state='failed' AND COALESCE((failure->>'retryable')::boolean,false)=true RETURNING id,attempt")
        .bind(&identity.tenant_id).bind(batch_id).fetch_all(&mut *tx).await.map_err(|error| ApiError::internal(error.to_string()))?;
    for row in &rows {
        let id: String = row.get("id");
        let attempt: i32 = row.get("attempt");
        sqlx::query("INSERT INTO job_attempts (tenant_id,job_id,attempt) VALUES ($1,$2,$3)")
            .bind(&identity.tenant_id)
            .bind(&id)
            .bind(attempt)
            .execute(&mut *tx)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        sqlx::query("INSERT INTO outbox_events (tenant_id,aggregate_id,event_type,payload) VALUES ($1,$2,'render_job_retried',$3)")
            .bind(&identity.tenant_id).bind(&id).bind(json!({"tenant_id":identity.tenant_id,"job_id":id})).execute(&mut *tx).await.map_err(|error| ApiError::internal(error.to_string()))?;
    }
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(json!({"retried": rows.len()})))
}

async fn artifact_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &state)?;
    let mut tx = authorized_tx(&state.pool, &identity, false).await?;
    let row = sqlx::query("SELECT object_key,sha256,byte_length FROM export_artifacts WHERE tenant_id=$1 AND job_id=$2")
        .bind(&identity.tenant_id).bind(&job_id).fetch_optional(&mut *tx).await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("artifact_missing", "artifact is not ready"))?;
    let object_key: String = row.get("object_key");
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let presigned = state
        .config
        .public_s3()
        .await
        .get_object()
        .bucket(&state.config.s3_bucket)
        .key(&object_key)
        .response_content_disposition("attachment")
        .presigned(
            PresigningConfig::expires_in(Duration::from_secs(300))
                .map_err(|error| ApiError::internal(error.to_string()))?,
        )
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(
        json!({"url": presigned.uri().to_string(), "expires_in_seconds": 300, "sha256": row.get::<String,_>("sha256"), "byte_length": row.get::<i64,_>("byte_length")}),
    ))
}
