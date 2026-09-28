use crate::api::{ApiError, ApiResult, AppState, authorized_tx, claims, tenant_tx};
use aws_sdk_s3::presigning::PresigningConfig;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/campaigns/{id}/reviews", post(create).get(list))
        .route("/v1/reviews/{id}/revoke", post(revoke))
        .route("/v1/review-access", post(access))
        .route("/v1/review-decision", post(decide))
        .route("/v1/campaigns/{id}/assets", get(assets))
}
fn db(e: sqlx::Error) -> ApiError {
    ApiError::internal(e.to_string())
}
fn rejected() -> ApiError {
    ApiError::forbidden(
        "review_link_invalid",
        "Review link expired, revoked or invalid",
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateReview {
    revision: u32,
    expires_in_seconds: u32,
}
async fn create(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CreateReview>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    let mut tx = authorized_tx(&app.pool, &identity, true).await?;
    if body.expires_in_seconds == 0 || body.expires_in_seconds > 604800 {
        return Err(ApiError::bad_request(
            "review_expiry_limit",
            "Expiry must be within seven days",
        ));
    }
    let hash:String=sqlx::query_scalar("SELECT snapshot_sha256 FROM sync_heads WHERE tenant_id=$1 AND campaign_id=$2 AND revision=$3 FOR UPDATE").bind(&identity.tenant_id).bind(&id).bind(body.revision as i32).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(||ApiError::bad_request("sync_revision_first","Sync this revision before review"))?;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM export_artifacts a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id JOIN render_batches b ON b.tenant_id=j.tenant_id AND b.id=j.batch_id WHERE b.tenant_id=$1 AND b.campaign_id=$2 AND b.campaign_revision=$3").bind(&identity.tenant_id).bind(&id).bind(body.revision as i32).fetch_one(&mut *tx).await.map_err(db)?;
    if count == 0 {
        return Err(ApiError::bad_request(
            "review_preview_required",
            "Render this revision before creating review",
        ));
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let review_id = Uuid::new_v4();
    sqlx::query("INSERT INTO review_links(tenant_id,id,campaign_id,revision,snapshot_sha256,token_sha256,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second')").bind(&identity.tenant_id).bind(review_id).bind(&id).bind(body.revision as i32).bind(hash).bind(token_hash).bind(body.expires_in_seconds as i32).execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(
        json!({"id":review_id,"token":token,"revision":body.revision,"expires_in_seconds":body.expires_in_seconds}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    token: String,
}
async fn review_context<'a>(
    app: &'a AppState,
    token: &str,
) -> ApiResult<(Transaction<'a, Postgres>, sqlx::postgres::PgRow)> {
    if token.len() != 64 || !token.bytes().all(|v| v.is_ascii_hexdigit()) {
        return Err(rejected());
    }
    let digest = hex::encode(Sha256::digest(token.as_bytes()));
    let tenant: Option<String> = sqlx::query_scalar("SELECT variantlab_review_tenant($1)")
        .bind(&digest)
        .fetch_one(&app.pool)
        .await
        .map_err(db)?;
    let mut tx = tenant_tx(&app.pool, &tenant.ok_or_else(rejected)?).await?;
    let row=sqlx::query("SELECT l.tenant_id,l.id,l.campaign_id,l.revision,l.snapshot_sha256,c.name,h.snapshot_sha256 AS head_sha256 FROM review_links l JOIN campaigns c ON c.tenant_id=l.tenant_id AND c.id=l.campaign_id JOIN sync_heads h ON h.tenant_id=l.tenant_id AND h.campaign_id=l.campaign_id WHERE l.token_sha256=$1 AND l.revoked_at IS NULL AND l.expires_at>now() FOR UPDATE OF l,h").bind(&digest).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(rejected)?;
    Ok((tx, row))
}
async fn access(State(app): State<AppState>, Json(token): Json<Token>) -> ApiResult<Json<Value>> {
    let (mut tx, row) = review_context(&app, &token.token).await?;
    let tenant: String = row.get("tenant_id");
    let id: Uuid = row.get("id");
    let campaign: String = row.get("campaign_id");
    let revision: i32 = row.get("revision");
    let latest:Option<String>=sqlx::query_scalar("SELECT decision FROM review_decisions WHERE tenant_id=$1 AND review_id=$2 ORDER BY created_at DESC,request_id DESC LIMIT 1").bind(&tenant).bind(id).fetch_optional(&mut *tx).await.map_err(db)?;
    let artifacts=sqlx::query("SELECT DISTINCT ON(j.cell_id) j.cell_id,a.object_key,a.sha256 FROM export_artifacts a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id JOIN render_batches b ON b.tenant_id=j.tenant_id AND b.id=j.batch_id WHERE b.tenant_id=$1 AND b.campaign_id=$2 AND b.campaign_revision=$3 ORDER BY j.cell_id,a.created_at DESC LIMIT 100").bind(&tenant).bind(&campaign).bind(revision).fetch_all(&mut *tx).await.map_err(db)?;
    let mut previews = Vec::new();
    for artifact in artifacts {
        previews.push(json!({"cell_id":artifact.get::<String,_>("cell_id"),"sha256":artifact.get::<String,_>("sha256"),"url":signed(&app,artifact.get("object_key")).await?}));
    }
    let snapshot:Value=sqlx::query_scalar("SELECT snapshot FROM campaign_revisions WHERE tenant_id=$1 AND campaign_id=$2 AND revision=$3").bind(&tenant).bind(&campaign).bind(revision).fetch_one(&mut *tx).await.map_err(db)?;
    let frozen: studio_model::StudioState =
        serde_json::from_value(snapshot).map_err(|_| ApiError::internal("snapshot"))?;
    let diagnostics = variant_engine::projection_page(&frozen, 0, 100)
        .map_err(|_| ApiError::internal("diagnostics"))?;
    let stale = row.get::<String, _>("snapshot_sha256") != row.get::<String, _>("head_sha256");
    Ok(Json(
        json!({"id":id,"name":row.get::<String,_>("name"),"revision":revision,"snapshot_sha256":row.get::<String,_>("snapshot_sha256"),"decision":latest,"stale":stale,"previews":previews,"diagnostics":diagnostics.items.iter().flat_map(|item|item.diagnostics.iter()).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    token: String,
    request_id: Uuid,
    decision: String,
}
async fn decide(State(app): State<AppState>, Json(body): Json<Decision>) -> ApiResult<Json<Value>> {
    if !["approved", "rejected"].contains(&body.decision.as_str()) {
        return Err(ApiError::bad_request(
            "invalid_review_decision",
            "Choose approve or reject",
        ));
    }
    let (mut tx, row) = review_context(&app, &body.token).await?;
    if row.get::<String, _>("snapshot_sha256") != row.get::<String, _>("head_sha256") {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            code: "stale_review_revision",
            message: "A newer revision exists; request a new review link".into(),
        });
    }
    let written=sqlx::query("INSERT INTO review_decisions(tenant_id,review_id,request_id,decision,snapshot_sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,review_id,request_id) DO UPDATE SET decision=review_decisions.decision WHERE review_decisions.decision=EXCLUDED.decision RETURNING request_id").bind(row.get::<String,_>("tenant_id")).bind(row.get::<Uuid,_>("id")).bind(body.request_id).bind(&body.decision).bind(row.get::<String,_>("snapshot_sha256")).fetch_optional(&mut *tx).await.map_err(db)?;
    if written.is_none() {
        return Err(ApiError::bad_request(
            "review_idempotency_mismatch",
            "Request ID already has another decision",
        ));
    }
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"decision":body.decision})))
}
async fn revoke(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    let mut tx = authorized_tx(&app.pool, &identity, true).await?;
    let changed=sqlx::query("UPDATE review_links SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND id=$2").bind(&identity.tenant_id).bind(id).execute(&mut *tx).await.map_err(db)?.rows_affected();
    if changed == 0 {
        return Err(ApiError::not_found("review_missing", "Review missing"));
    }
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"revoked":true})))
}
async fn list(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    let mut tx = authorized_tx(&app.pool, &identity, false).await?;
    let rows=sqlx::query("SELECT l.id,l.revision,l.revoked_at IS NOT NULL AS revoked,l.expires_at<now() AS expired,l.snapshot_sha256<>h.snapshot_sha256 AS stale,(SELECT decision FROM review_decisions d WHERE d.tenant_id=l.tenant_id AND d.review_id=l.id ORDER BY d.created_at DESC,d.request_id DESC LIMIT 1) AS decision FROM review_links l JOIN sync_heads h ON h.tenant_id=l.tenant_id AND h.campaign_id=l.campaign_id WHERE l.tenant_id=$1 AND l.campaign_id=$2 ORDER BY l.created_at DESC LIMIT 50").bind(&identity.tenant_id).bind(id).fetch_all(&mut *tx).await.map_err(db)?;
    Ok(Json(
        json!({"reviews":rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"revision":r.get::<i32,_>("revision"),"revoked":r.get::<bool,_>("revoked"),"expired":r.get::<bool,_>("expired"),"stale":r.get::<bool,_>("stale"),"decision":r.get::<Option<String>,_>("decision")})).collect::<Vec<_>>()}),
    ))
}
async fn signed(app: &AppState, key: String) -> ApiResult<String> {
    let request = app
        .config
        .public_s3()
        .await
        .get_object()
        .bucket(&app.config.s3_bucket)
        .key(key)
        .presigned(
            PresigningConfig::expires_in(std::time::Duration::from_secs(60))
                .map_err(|_| ApiError::internal("presign"))?,
        )
        .await
        .map_err(|_| ApiError::internal("presign"))?;
    Ok(request.uri().to_string())
}
#[derive(Deserialize)]
struct AssetRevision {
    revision: i32,
    snapshot_sha256: String,
}
async fn assets(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(version): axum::extract::Query<AssetRevision>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    let mut tx = authorized_tx(&app.pool, &identity, false).await?;
    let snapshot: Value =
        sqlx::query_scalar("SELECT snapshot FROM campaign_revisions WHERE tenant_id=$1 AND campaign_id=$2 AND revision=$3 AND snapshot_sha256=$4")
            .bind(&identity.tenant_id)
            .bind(&id)
            .bind(version.revision).bind(&version.snapshot_sha256)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or_else(|| ApiError::not_found("campaign_missing", "Campaign missing"))?;
    let state: studio_model::StudioState =
        serde_json::from_value(snapshot).map_err(|_| ApiError::internal("snapshot"))?;
    let hashes = edit_engine::campaign_original_hashes(&state);
    let rows=sqlx::query("SELECT asset_hash,object_key,byte_length,content_type FROM media_assets WHERE tenant_id=$1 AND asset_hash=ANY($2::text[])").bind(&identity.tenant_id).bind(hashes.iter().cloned().collect::<Vec<_>>()).fetch_all(&mut *tx).await.map_err(db)?;
    if rows.len() != hashes.len() {
        return Err(ApiError::bad_request(
            "cloud_originals_missing",
            "Upload originals through cloud batch before continuing on another device",
        ));
    }
    let mut items = Vec::new();
    for row in rows {
        items.push(json!({"asset_hash":row.get::<String,_>("asset_hash"),"byte_length":row.get::<i64,_>("byte_length"),"content_type":row.get::<String,_>("content_type"),"url":signed(&app,row.get("object_key")).await?}));
    }
    Ok(Json(json!({"assets":items})))
}
