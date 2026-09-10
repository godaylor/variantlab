use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

pub const CONNECTED_SCHEMA_VERSION: u32 = 1;
pub const UPLOAD_PART_MIN_BYTES: u64 = 5 * 1024 * 1024;
pub const UPLOAD_PART_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ConnectedWorkspace {
    pub schema_version: u32,
    pub tenant_id: String,
    pub workspace_name: String,
    pub connected: bool,
    pub max_batch_cells: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct UploadPartReceipt {
    pub part_number: u16,
    pub etag: String,
    #[ts(type = "number")]
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct MultipartUploadSession {
    pub schema_version: u32,
    pub upload_id: String,
    pub tenant_id: String,
    pub campaign_id: String,
    pub asset_hash: String,
    pub object_key: String,
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub part_size_bytes: u64,
    pub completed_parts: Vec<UploadPartReceipt>,
    pub expires_at: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConnectedContractError {
    #[error("connected contract has an unsupported schema version")]
    UnsupportedSchema,
    #[error("connected contract identity is empty")]
    EmptyIdentity,
    #[error("multipart part size is outside the allowed range")]
    InvalidPartSize,
    #[error("multipart receipts are not unique and sorted")]
    InvalidPartOrder,
    #[error("multipart receipt checksum is invalid")]
    InvalidChecksum,
}

pub fn validate_upload_session(
    session: &MultipartUploadSession,
) -> Result<(), ConnectedContractError> {
    if session.schema_version != CONNECTED_SCHEMA_VERSION {
        return Err(ConnectedContractError::UnsupportedSchema);
    }
    if session.upload_id.trim().is_empty()
        || session.tenant_id.trim().is_empty()
        || session.campaign_id.trim().is_empty()
        || session.asset_hash.trim().is_empty()
        || session.object_key.trim().is_empty()
    {
        return Err(ConnectedContractError::EmptyIdentity);
    }
    if !(UPLOAD_PART_MIN_BYTES..=UPLOAD_PART_MAX_BYTES).contains(&session.part_size_bytes) {
        return Err(ConnectedContractError::InvalidPartSize);
    }
    let mut previous = 0;
    for part in &session.completed_parts {
        if part.part_number <= previous {
            return Err(ConnectedContractError::InvalidPartOrder);
        }
        if part.sha256.len() != 64 || part.etag.trim().is_empty() {
            return Err(ConnectedContractError::InvalidChecksum);
        }
        previous = part.part_number;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> MultipartUploadSession {
        MultipartUploadSession {
            schema_version: CONNECTED_SCHEMA_VERSION,
            upload_id: "upload-1".into(),
            tenant_id: "tenant-1".into(),
            campaign_id: "campaign-1".into(),
            asset_hash: "a".repeat(64),
            object_key: "tenant-1/originals/aa/hash".into(),
            total_bytes: 10 * 1024 * 1024,
            part_size_bytes: UPLOAD_PART_MIN_BYTES,
            completed_parts: vec![UploadPartReceipt {
                part_number: 1,
                etag: "etag-1".into(),
                byte_length: UPLOAD_PART_MIN_BYTES,
                sha256: "b".repeat(64),
            }],
            expires_at: "2026-09-04T00:00:00Z".into(),
        }
    }

    #[test]
    fn validates_bounded_sorted_multipart_receipts() {
        assert_eq!(validate_upload_session(&session()), Ok(()));
        let mut invalid = session();
        invalid
            .completed_parts
            .push(invalid.completed_parts[0].clone());
        assert_eq!(
            validate_upload_session(&invalid),
            Err(ConnectedContractError::InvalidPartOrder)
        );
    }
}
