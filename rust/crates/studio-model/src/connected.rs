use crate::{CommandEnvelope, StudioState};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConnectedSnapshot {
    pub snapshot: StudioState,
    pub snapshot_sha256: String,
    pub revision: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConnectedCampaignSummary {
    pub id: String,
    pub name: String,
    pub revision: u32,
    pub snapshot_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConnectedSyncReceipt {
    pub status: String,
    pub revision: u32,
    pub snapshot_sha256: String,
    pub branch_id: Option<String>,
    pub server_revision: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConnectedSyncOutbox {
    pub campaign_id: String,
    pub base_revision: u32,
    pub base_sha256: String,
    pub commands: Vec<CommandEnvelope>,
    pub pending_request_id: Option<String>,
    pub pending_commands_count: u32,
    pub branch_id: Option<String>,
    pub overflow: bool,
    pub initial_snapshot: Option<StudioState>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConnectedAsset {
    pub asset_hash: String,
    pub byte_length: u32,
    pub content_type: String,
    pub url: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConnectedBranch {
    pub id: String,
    pub base_revision: u32,
    pub server_revision: u32,
    pub snapshot_sha256: String,
    pub name: String,
    pub scene_names: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReviewSummary {
    pub id: String,
    pub revision: u32,
    pub revoked: bool,
    pub expired: bool,
    pub stale: bool,
    pub decision: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReviewPreview {
    pub cell_id: String,
    pub sha256: String,
    pub url: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReviewView {
    pub id: String,
    pub name: String,
    pub revision: u32,
    pub snapshot_sha256: String,
    pub decision: Option<String>,
    pub stale: bool,
    pub previews: Vec<ReviewPreview>,
}
