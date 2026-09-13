use crate::api::{ApiError, ApiResult, AppState, authorized_tx, claims};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use studio_model::{CommandEnvelope, StudioState, snapshot_hash};
use uuid::Uuid;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/campaigns", get(list))
        .route("/v1/campaigns/{id}/sync", post(sync))
        .route("/v1/campaigns/{id}/snapshot", get(snapshot))
        .route("/v1/campaigns/{id}/release-writer", post(release_writer))
        .route("/v1/campaigns/{id}/branches", get(branches))
        .route("/v1/branches/{id}/continue", post(continue_branch))
}

fn db(error: sqlx::Error) -> ApiError {
    ApiError::internal(error.to_string())
}
fn conflict(code: &'static str) -> ApiError {
    ApiError {
        status: StatusCode::CONFLICT,
        code,
        message: code.into(),
    }
}
fn parse_snapshot(value: Value) -> ApiResult<StudioState> {
    edit_engine::parse_sync_snapshot(value)
        .map_err(|code| ApiError::bad_request("invalid_snapshot", code))
}
fn hash(state: &StudioState) -> ApiResult<String> {
    snapshot_hash(state)
        .map_err(|_| ApiError::bad_request("invalid_snapshot", "Cannot hash snapshot"))
}

pub(crate) async fn checkpoint(
    tx: &mut Transaction<'_, Postgres>,
    tenant: &str,
    state: &StudioState,
) -> ApiResult<String> {
    let hash = hash(state)?;
    let revision = i32::try_from(state.campaign.revision)
        .map_err(|_| ApiError::bad_request("revision_limit", "Revision limit"))?;
    let row = sqlx::query(include_str!("revision_snapshot.sql"))
        .bind(tenant)
        .bind(&state.campaign.id)
        .bind(revision)
        .bind(&hash)
        .bind(serde_json::to_value(state).map_err(|_| ApiError::internal("serialize"))?)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?;
    if row.is_none() {
        return Err(conflict("immutable_revision_conflict"));
    }
    sqlx::query("UPDATE campaigns SET name=$3,head_revision=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(&state.campaign.id).bind(&state.campaign.name).bind(revision).execute(&mut **tx).await.map_err(db)?;
    Ok(hash)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncRequest {
    schema_version: u32,
    request_id: Uuid,
    device_id: Uuid,
    base_revision: u32,
    base_sha256: String,
    initial_snapshot: Option<Value>,
    commands: Vec<CommandEnvelope>,
}

async fn sync(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<SyncRequest>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    if request.schema_version != 1
        || request.base_sha256.len() != 64
        || request.base_revision > i32::MAX as u32
    {
        return Err(ApiError::bad_request(
            "invalid_sync_contract",
            "Invalid sync contract",
        ));
    }
    let request_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(&request).map_err(|_| ApiError::internal("serialize"))?,
    ));
    let mut tx = authorized_tx(&app.pool, &identity, true).await?;
    // Lock the campaign before idempotency lookup: simultaneous deliveries serialize.
    if let Some(initial) = &request.initial_snapshot {
        let state = parse_snapshot(initial.clone())?;
        if state.campaign.id != id
            || state.campaign.revision != request.base_revision
            || hash(&state)? != request.base_sha256
            || !request.commands.is_empty()
        {
            return Err(ApiError::bad_request(
                "initial_snapshot_mismatch",
                "Initial snapshot identity/hash mismatch",
            ));
        }
        sqlx::query(
            "INSERT INTO campaigns(tenant_id,id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        )
        .bind(&identity.tenant_id)
        .bind(&id)
        .bind(&state.campaign.name)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    }
    sqlx::query("SELECT id FROM campaigns WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(&identity.tenant_id)
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or_else(|| ApiError::not_found("campaign_missing", "Campaign missing"))?;
    if let Some(row)=sqlx::query("SELECT request_sha256,receipt FROM sync_receipts WHERE tenant_id=$1 AND campaign_id=$2 AND request_id=$3").bind(&identity.tenant_id).bind(&id).bind(request.request_id).fetch_optional(&mut *tx).await.map_err(db)? {
        if row.get::<String,_>("request_sha256") != request_hash { return Err(conflict("idempotency_payload_mismatch")); }
        return Ok(Json(row.get("receipt")));
    }
    let head=sqlx::query("SELECT revision,snapshot_sha256,snapshot,writer_device,lease_until>now() AS leased FROM sync_heads WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE").bind(&identity.tenant_id).bind(&id).fetch_optional(&mut *tx).await.map_err(db)?;
    let (base, head_value, foreign_lease) = if let Some(head) = head {
        let base = sqlx::query("SELECT snapshot FROM campaign_revisions WHERE tenant_id=$1 AND campaign_id=$2 AND revision=$3")
            .bind(&identity.tenant_id).bind(&id).bind(request.base_revision as i32)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let foreign = head.get::<Option<bool>, _>("leased").unwrap_or(false)
            && head.get::<Option<String>, _>("writer_device").as_deref()
                != Some(&request.device_id.to_string());
        (
            base.map(|row| row.get::<Value, _>("snapshot"))
                .unwrap_or(Value::Null),
            json!({"revision":head.get::<i32,_>("revision"),"snapshot_sha256":head.get::<String,_>("snapshot_sha256")}),
            foreign,
        )
    } else {
        (Value::Null, Value::Null, false)
    };
    let plan = edit_engine::plan_connected_sync(
        &id,
        &serde_json::to_string(&request).map_err(|_| ApiError::internal("serialize"))?,
        &base.to_string(),
        &head_value.to_string(),
        foreign_lease,
    )
    .map_err(|code| match code.as_str() {
        "writer_lease_held" => conflict("writer_lease_held"),
        "sync_already_enabled" => conflict("sync_already_enabled"),
        "sync_base_checksum" => conflict("sync_base_checksum"),
        "sync_not_enabled" => conflict("sync_not_enabled"),
        _ => ApiError::bad_request("sync_command_rejected", code),
    })?;
    let plan: Value = serde_json::from_str(&plan).map_err(|_| ApiError::internal("serialize"))?;
    let next = parse_snapshot(plan["snapshot"].clone())?;
    let conflict_head = plan["server_revision"].as_i64().map(|value| value as i32);
    let next_hash = hash(&next)?;
    let receipt = if let Some(server_revision) = conflict_head {
        let branch = Uuid::new_v4();
        sqlx::query("INSERT INTO recovered_branches(tenant_id,campaign_id,id,base_revision,server_revision,snapshot_sha256,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(&identity.tenant_id).bind(&id).bind(branch).bind(request.base_revision as i32).bind(server_revision).bind(&next_hash).bind(serde_json::to_value(&next).map_err(|_|ApiError::internal("serialize"))?).execute(&mut *tx).await.map_err(db)?;
        json!({"status":"recovered_branch","branch_id":branch,"revision":next.campaign.revision,"snapshot_sha256":next_hash,"server_revision":server_revision})
    } else {
        checkpoint(&mut tx, &identity.tenant_id, &next).await?;
        sqlx::query("INSERT INTO sync_heads(tenant_id,campaign_id,revision,snapshot_sha256,snapshot,writer_device,lease_until) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 seconds') ON CONFLICT(tenant_id,campaign_id) DO UPDATE SET revision=EXCLUDED.revision,snapshot_sha256=EXCLUDED.snapshot_sha256,snapshot=EXCLUDED.snapshot,writer_device=EXCLUDED.writer_device,lease_until=EXCLUDED.lease_until").bind(&identity.tenant_id).bind(&id).bind(next.campaign.revision as i32).bind(&next_hash).bind(serde_json::to_value(&next).map_err(|_|ApiError::internal("serialize"))?).bind(request.device_id.to_string()).execute(&mut *tx).await.map_err(db)?;
        json!({"status":"synced","revision":next.campaign.revision,"snapshot_sha256":next_hash})
    };
    sqlx::query("INSERT INTO sync_receipts(tenant_id,campaign_id,request_id,request_sha256,receipt) VALUES($1,$2,$3,$4,$5)").bind(&identity.tenant_id).bind(&id).bind(request.request_id).bind(&request_hash).bind(&receipt).execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(receipt))
}

async fn list(State(app): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    let mut tx = authorized_tx(&app.pool, &identity, false).await?;
    let rows=sqlx::query("SELECT c.id,c.name,h.revision,h.snapshot_sha256 FROM campaigns c JOIN sync_heads h ON h.tenant_id=c.tenant_id AND h.campaign_id=c.id WHERE c.tenant_id=$1 ORDER BY c.updated_at DESC,c.id LIMIT 100").bind(&identity.tenant_id).fetch_all(&mut *tx).await.map_err(db)?;
    Ok(Json(
        json!({"campaigns":rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"revision":r.get::<i32,_>("revision"),"snapshot_sha256":r.get::<String,_>("snapshot_sha256")})).collect::<Vec<_>>()}),
    ))
}
async fn snapshot(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    let mut tx = authorized_tx(&app.pool, &identity, false).await?;
    let row=sqlx::query("SELECT snapshot,snapshot_sha256,revision FROM sync_heads WHERE tenant_id=$1 AND campaign_id=$2").bind(&identity.tenant_id).bind(&id).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(||ApiError::not_found("campaign_missing","Campaign missing"))?;
    let state = parse_snapshot(row.get("snapshot"))?;
    if hash(&state)? != row.get::<String, _>("snapshot_sha256") {
        return Err(conflict("remote_snapshot_corrupt"));
    }
    Ok(Json(
        json!({"snapshot":state,"snapshot_sha256":row.get::<String,_>("snapshot_sha256"),"revision":row.get::<i32,_>("revision")}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Device {
    device_id: Uuid,
}
async fn release_writer(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(device): Json<Device>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    let mut tx = authorized_tx(&app.pool, &identity, true).await?;
    sqlx::query("UPDATE sync_heads SET writer_device=NULL,lease_until=NULL WHERE tenant_id=$1 AND campaign_id=$2 AND writer_device=$3").bind(&identity.tenant_id).bind(&id).bind(device.device_id.to_string()).execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"released":true})))
}
async fn branches(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    let mut tx = authorized_tx(&app.pool, &identity, false).await?;
    let rows=sqlx::query("SELECT id,base_revision,server_revision,snapshot_sha256,snapshot FROM recovered_branches WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY created_at DESC LIMIT 50").bind(&identity.tenant_id).bind(&id).fetch_all(&mut *tx).await.map_err(db)?;
    Ok(Json(
        json!({"branches":rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"base_revision":r.get::<i32,_>("base_revision"),"server_revision":r.get::<i32,_>("server_revision"),"snapshot_sha256":r.get::<String,_>("snapshot_sha256"),"name":r.get::<Value,_>("snapshot")["campaign"]["name"],"scene_names":r.get::<Value,_>("snapshot")["campaign"]["master_sequence"]["scenes"].as_array().map(|scenes|scenes.iter().map(|s|s["name"].clone()).collect::<Vec<_>>())})).collect::<Vec<_>>()}),
    ))
}
async fn continue_branch(
    State(app): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &app)?;
    let mut tx = authorized_tx(&app.pool, &identity, true).await?;
    let row = sqlx::query(
        "SELECT snapshot,snapshot_sha256 FROM recovered_branches WHERE tenant_id=$1 AND id=$2",
    )
    .bind(&identity.tenant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| ApiError::not_found("branch_missing", "Branch missing"))?;
    let original = parse_snapshot(row.get("snapshot"))?;
    if hash(&original)? != row.get::<String, _>("snapshot_sha256") {
        return Err(conflict("remote_snapshot_corrupt"));
    }
    let next = edit_engine::fork_recovered(
        original,
        Uuid::new_v4().to_string(),
        "Recovered branch".into(),
        chrono::Utc::now().to_rfc3339(),
    )
    .map_err(|_| ApiError::bad_request("recovery_failed", "Recovery failed"))?;
    Ok(Json(
        json!({"snapshot_sha256":hash(&next)?,"snapshot":next}),
    ))
}
