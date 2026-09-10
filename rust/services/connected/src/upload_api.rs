use aws_sdk_s3::{
    primitives::ByteStream,
    types::{CompletedMultipartUpload, CompletedPart},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post, put},
};
use chrono::{Duration, Utc};
use job_contracts::{
    CONNECTED_SCHEMA_VERSION, MultipartUploadSession, UploadPartReceipt, validate_upload_session,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::api::{ApiError, ApiResult, AppState, authorized_tx, claims};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/uploads", post(create_upload))
        .route("/v1/uploads/{upload_id}", get(upload_status))
        .route(
            "/v1/uploads/{upload_id}/parts/{part_number}",
            put(upload_part),
        )
        .route("/v1/uploads/{upload_id}/complete", post(complete_upload))
}

#[derive(Deserialize)]
struct CreateUploadRequest {
    campaign_id: String,
    asset_hash: String,
    content_type: String,
    total_bytes: u64,
}

async fn create_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateUploadRequest>,
) -> ApiResult<Json<MultipartUploadSession>> {
    let identity = claims(&headers, &state)?;
    if request.asset_hash.len() != 64
        || !request
            .asset_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.total_bytes == 0
        || request.total_bytes > 20 * 1024 * 1024 * 1024
        || !matches!(
            request.content_type.as_str(),
            "video/webm" | "audio/webm" | "image/png"
        )
        || (request.content_type == "image/png"
            && request.total_bytes > render_plan::MAX_LOGO_BYTES as u64)
    {
        return Err(ApiError::bad_request(
            "invalid_upload",
            "upload hash, media type or byte length is invalid",
        ));
    }
    let mut tx = authorized_tx(&state.pool, &identity, true).await?;
    let existing = sqlx::query("SELECT id,provider_upload_id,total_bytes,part_size_bytes,completed_parts,expires_at,object_key FROM upload_sessions WHERE tenant_id=$1 AND campaign_id=$2 AND asset_hash=$3 AND state='uploading' AND expires_at>now() ORDER BY created_at DESC LIMIT 1")
        .bind(&identity.tenant_id)
        .bind(&request.campaign_id)
        .bind(&request.asset_hash)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if let Some(row) = existing {
        let session = session_from_row(
            &identity.tenant_id,
            &request.campaign_id,
            &request.asset_hash,
            &row,
        )?;
        tx.commit()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        return Ok(Json(session));
    }
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let object_key = format!(
        "tenants/{}/originals/{}/{}/{}",
        identity.tenant_id,
        &request.asset_hash[..2],
        request.asset_hash,
        Uuid::new_v4()
    );
    let response = state
        .s3
        .create_multipart_upload()
        .bucket(&state.config.s3_bucket)
        .key(&object_key)
        .content_type(&request.content_type)
        .send()
        .await
        .map_err(|error| ApiError::internal(format!("object storage: {error}")))?;
    let provider_upload_id = response
        .upload_id()
        .ok_or_else(|| ApiError::internal("object storage omitted multipart upload id"))?
        .to_owned();
    let upload_id = Uuid::new_v4();
    let part_size_bytes = 8 * 1024 * 1024_u64;
    let expires_at = Utc::now() + Duration::hours(24);
    let mut tx = authorized_tx(&state.pool, &identity, true).await?;
    sqlx::query("INSERT INTO upload_sessions (tenant_id,id,campaign_id,asset_hash,object_key,provider_upload_id,total_bytes,part_size_bytes,expires_at,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'uploading')")
        .bind(&identity.tenant_id)
        .bind(upload_id)
        .bind(&request.campaign_id)
        .bind(&request.asset_hash)
        .bind(&object_key)
        .bind(&provider_upload_id)
        .bind(request.total_bytes as i64)
        .bind(part_size_bytes as i64)
        .bind(expires_at)
        .execute(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(MultipartUploadSession {
        schema_version: CONNECTED_SCHEMA_VERSION,
        upload_id: upload_id.to_string(),
        tenant_id: identity.tenant_id,
        campaign_id: request.campaign_id,
        asset_hash: request.asset_hash,
        object_key,
        total_bytes: request.total_bytes,
        part_size_bytes,
        completed_parts: Vec::new(),
        expires_at: expires_at.to_rfc3339(),
    }))
}

fn session_from_row(
    tenant_id: &str,
    campaign_id: &str,
    asset_hash: &str,
    row: &sqlx::postgres::PgRow,
) -> ApiResult<MultipartUploadSession> {
    let session = MultipartUploadSession {
        schema_version: CONNECTED_SCHEMA_VERSION,
        upload_id: row.get::<Uuid, _>("id").to_string(),
        tenant_id: tenant_id.to_owned(),
        campaign_id: campaign_id.to_owned(),
        asset_hash: asset_hash.to_owned(),
        object_key: row.get("object_key"),
        total_bytes: row.get::<i64, _>("total_bytes") as u64,
        part_size_bytes: row.get::<i64, _>("part_size_bytes") as u64,
        completed_parts: serde_json::from_value(row.get("completed_parts"))
            .map_err(|error| ApiError::internal(error.to_string()))?,
        expires_at: row
            .get::<chrono::DateTime<Utc>, _>("expires_at")
            .to_rfc3339(),
    };
    validate_upload_session(&session).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(session)
}

async fn load_upload(
    state: &AppState,
    identity: &crate::identity::IdentityClaims,
    upload_id: Uuid,
) -> ApiResult<(MultipartUploadSession, String)> {
    let mut tx = authorized_tx(&state.pool, identity, false).await?;
    let row = sqlx::query("SELECT id,campaign_id,asset_hash,object_key,provider_upload_id,total_bytes,part_size_bytes,completed_parts,expires_at FROM upload_sessions WHERE tenant_id=$1 AND id=$2 AND state='uploading' AND expires_at>now()")
        .bind(&identity.tenant_id)
        .bind(upload_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("upload_not_found", "upload session is unavailable"))?;
    let campaign_id: String = row.get("campaign_id");
    let asset_hash: String = row.get("asset_hash");
    let provider_upload_id: String = row.get("provider_upload_id");
    let session = session_from_row(&identity.tenant_id, &campaign_id, &asset_hash, &row)?;
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok((session, provider_upload_id))
}

async fn upload_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(upload_id): Path<Uuid>,
) -> ApiResult<Json<MultipartUploadSession>> {
    let identity = claims(&headers, &state)?;
    Ok(Json(load_upload(&state, &identity, upload_id).await?.0))
}

async fn upload_part(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((upload_id, part_number)): Path<(Uuid, u16)>,
    body: Bytes,
) -> ApiResult<Json<UploadPartReceipt>> {
    let identity = claims(&headers, &state)?;
    let (session, provider_upload_id) = load_upload(&state, &identity, upload_id).await?;
    if part_number == 0 || body.is_empty() || body.len() as u64 > session.part_size_bytes {
        return Err(ApiError::bad_request(
            "invalid_part",
            "multipart chunk is empty or exceeds the bounded part size",
        ));
    }
    let sha256 = hex::encode(Sha256::digest(&body));
    let expected = headers
        .get("x-content-sha256")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::bad_request("checksum_required", "multipart chunk checksum is required")
        })?;
    if expected != sha256 {
        return Err(ApiError::bad_request(
            "checksum_mismatch",
            "multipart chunk checksum does not match",
        ));
    }
    let result = state
        .s3
        .upload_part()
        .bucket(&state.config.s3_bucket)
        .key(&session.object_key)
        .upload_id(provider_upload_id)
        .part_number(i32::from(part_number))
        .body(ByteStream::from(body.to_vec()))
        .send()
        .await
        .map_err(|error| ApiError::internal(format!("object storage: {error}")))?;
    let receipt = UploadPartReceipt {
        part_number,
        etag: result.e_tag().unwrap_or_default().to_owned(),
        byte_length: body.len() as u64,
        sha256,
    };
    let mut tx = authorized_tx(&state.pool, &identity, true).await?;
    let saved = sqlx::query(include_str!("upload_part_receipt.sql"))
        .bind(&identity.tenant_id)
        .bind(upload_id)
        .bind(
            serde_json::to_value(&receipt)
                .map_err(|error| ApiError::internal(error.to_string()))?,
        )
        .execute(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if saved.rows_affected() != 1 {
        return Err(ApiError::not_found(
            "upload_not_found",
            "upload session is unavailable",
        ));
    }
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(receipt))
}

async fn complete_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(upload_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let identity = claims(&headers, &state)?;
    let (session, provider_upload_id) = load_upload(&state, &identity, upload_id).await?;
    if session.completed_parts.is_empty() {
        return Err(ApiError::bad_request(
            "missing_parts",
            "no multipart chunks were uploaded",
        ));
    }
    let uploaded_bytes: u64 = session
        .completed_parts
        .iter()
        .map(|part| part.byte_length)
        .sum();
    if uploaded_bytes != session.total_bytes {
        return Err(ApiError::bad_request(
            "size_mismatch",
            "uploaded byte count does not match the immutable source",
        ));
    }
    let completed = session
        .completed_parts
        .iter()
        .map(|part| {
            CompletedPart::builder()
                .part_number(i32::from(part.part_number))
                .e_tag(&part.etag)
                .build()
        })
        .collect::<Vec<_>>();
    state
        .s3
        .complete_multipart_upload()
        .bucket(&state.config.s3_bucket)
        .key(&session.object_key)
        .upload_id(provider_upload_id)
        .multipart_upload(
            CompletedMultipartUpload::builder()
                .set_parts(Some(completed))
                .build(),
        )
        .send()
        .await
        .map_err(|error| ApiError::internal(format!("object storage: {error}")))?;
    let object = state
        .s3
        .get_object()
        .bucket(&state.config.s3_bucket)
        .key(&session.object_key)
        .send()
        .await
        .map_err(|_| ApiError::internal("uploaded object verification failed"))?;
    let content_type = object.content_type().unwrap_or("").to_owned();
    let mut logo_bytes = Vec::new();
    let mut stream = object.body;
    let mut digest = Sha256::new();
    let mut verified_bytes = 0u64;
    let mut prefix = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|_| ApiError::internal("uploaded object verification failed"))?;
        verified_bytes += bytes.len() as u64;
        if verified_bytes > session.total_bytes {
            return Err(ApiError::bad_request(
                "size_mismatch",
                "uploaded object exceeds declared length",
            ));
        }
        for byte in bytes.iter().take(4_usize.saturating_sub(prefix.len())) {
            prefix.push(*byte);
        }
        digest.update(&bytes);
        if content_type == "image/png" {
            if verified_bytes > render_plan::MAX_LOGO_BYTES as u64 {
                return Err(ApiError::bad_request(
                    "logo_byte_limit",
                    "PNG exceeds the bounded logo limit",
                ));
            }
            logo_bytes.extend_from_slice(&bytes);
        }
    }
    if hex::encode(digest.finalize()) != session.asset_hash
        || verified_bytes != session.total_bytes
        || (if content_type == "image/png" {
            render_plan::probe_logo_png(&logo_bytes).is_err()
        } else {
            !matches!(content_type.as_str(), "video/webm" | "audio/webm")
                || prefix != [0x1a, 0x45, 0xdf, 0xa3]
        })
    {
        let mut tx = authorized_tx(&state.pool, &identity, true).await?;
        sqlx::query("UPDATE upload_sessions SET state='aborted',updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(&identity.tenant_id).bind(upload_id).execute(&mut *tx).await.map_err(|_| ApiError::internal("upload verification state failed"))?;
        tx.commit()
            .await
            .map_err(|_| ApiError::internal("upload verification state failed"))?;
        return Err(ApiError::bad_request(
            "source_checksum_mismatch",
            "complete media checksum, length or supported media contents do not match",
        ));
    }
    let mut tx = authorized_tx(&state.pool, &identity, true).await?;
    sqlx::query("INSERT INTO media_assets (tenant_id,asset_hash,object_key,byte_length,content_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,asset_hash) DO NOTHING")
        .bind(&identity.tenant_id)
        .bind(&session.asset_hash)
        .bind(&session.object_key)
        .bind(session.total_bytes as i64)
        .bind(&content_type)
        .execute(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    sqlx::query("UPDATE upload_sessions SET state='completed',updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(&identity.tenant_id)
        .bind(upload_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    tx.commit()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(
        json!({ "asset_hash": session.asset_hash, "uploaded": true }),
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn immutable_object_key_does_not_contain_original_filename() {
        let tenant = "tenant-a";
        let hash = "a".repeat(64);
        let key = format!("tenants/{tenant}/originals/{}/{}", &hash[..2], hash);
        assert!(!key.contains("final-campaign.webm"));
    }
}
