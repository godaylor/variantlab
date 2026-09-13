use studio_model::{CommandEnvelope, PrepareResult, StudioState};

pub const MAX_SYNC_COMMANDS: usize = 200;
pub const MAX_SYNC_BYTES: usize = 2 * 1024 * 1024;

/// Includes originals referenced by disabled variants and excluded scenes too:
/// restoring an editable campaign must preserve future edits, not just today's export.
pub fn campaign_original_hashes(state: &StudioState) -> std::collections::BTreeSet<String> {
    let mut hashes = std::collections::BTreeSet::new();
    for scene in &state.campaign.master_sequence.scenes {
        if let Some(timeline) = &scene.timeline {
            for track in &timeline.tracks {
                for clip in &track.clips {
                    hashes.insert(clip.asset_id.clone());
                }
            }
        }
    }
    for value in state.campaign.slots.iter().map(|s| &s.master_value).chain(
        state
            .campaign
            .creative_sets
            .iter()
            .flat_map(|s| s.replacements.iter().map(|r| &r.value)),
    ) {
        if let studio_model::SlotValue::Logo { asset_id }
        | studio_model::SlotValue::Media { asset_id, .. } = value
        {
            hashes.insert(asset_id.clone());
        }
    }
    hashes
}

/// Connected adapters must reject unknown fields instead of silently losing them.
pub fn parse_sync_snapshot(value: serde_json::Value) -> Result<StudioState, String> {
    let state: StudioState =
        serde_json::from_value(value.clone()).map_err(|_| "invalid_snapshot")?;
    if serde_json::to_value(&state).map_err(|_| "sync_encoding")? != value {
        return Err("unknown_snapshot_fields".into());
    }
    if state.schema_version != 1 {
        return Err("unsupported_snapshot_version".into());
    }
    Ok(state)
}

/// Storage-independent sync decision. Both native and WASM adapters supply the
/// immutable base and current head; their database transaction commits the result.
pub fn plan_connected_sync(
    campaign_id: &str,
    request_json: &str,
    base_json: &str,
    head_json: &str,
    foreign_writer_lease: bool,
) -> Result<String, String> {
    use serde_json::{Value, json};
    let request: Value = serde_json::from_str(request_json).map_err(|_| "invalid_sync_contract")?;
    let object = request.as_object().ok_or("invalid_sync_contract")?;
    if object.keys().any(|key| {
        ![
            "schema_version",
            "request_id",
            "device_id",
            "base_revision",
            "base_sha256",
            "initial_snapshot",
            "commands",
        ]
        .contains(&key.as_str())
    }) || request["schema_version"] != 1
        || request["base_revision"]
            .as_u64()
            .is_none_or(|r| r > i32::MAX as u64)
        || request["base_sha256"]
            .as_str()
            .is_none_or(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("invalid_sync_contract".into());
    }
    let commands: Vec<CommandEnvelope> =
        serde_json::from_value(request["commands"].clone()).map_err(|_| "invalid_sync_contract")?;
    let head: Value = serde_json::from_str(head_json).map_err(|_| "invalid_sync_head")?;
    let initial = &request["initial_snapshot"];
    let (next, conflict) = if head.is_null() {
        if initial.is_null() {
            return Err("sync_not_enabled".into());
        }
        let state = parse_sync_snapshot(initial.clone())?;
        if state.campaign.id != campaign_id
            || json!(state.campaign.revision) != request["base_revision"]
            || json!(studio_model::snapshot_hash(&state).map_err(|_| "invalid_snapshot")?)
                != request["base_sha256"]
            || !commands.is_empty()
        {
            return Err("initial_snapshot_mismatch".into());
        }
        (state, Value::Null)
    } else {
        if !initial.is_null() {
            return Err("sync_already_enabled".into());
        }
        let base =
            parse_sync_snapshot(serde_json::from_str(base_json).map_err(|_| "sync_base_missing")?)?;
        if base.campaign.id != campaign_id
            || json!(base.campaign.revision) != request["base_revision"]
            || json!(studio_model::snapshot_hash(&base).map_err(|_| "invalid_snapshot")?)
                != request["base_sha256"]
        {
            return Err("sync_base_checksum".into());
        }
        let divergent = head["snapshot_sha256"] != request["base_sha256"];
        if !divergent && foreign_writer_lease {
            return Err("writer_lease_held".into());
        }
        (
            replay_sync(&base, &commands)?,
            if divergent {
                head["revision"].clone()
            } else {
                Value::Null
            },
        )
    };
    let hash = studio_model::snapshot_hash(&next).map_err(|_| "invalid_snapshot")?;
    serde_json::to_string(
        &json!({"snapshot": next, "snapshot_sha256": hash, "server_revision": conflict}),
    )
    .map_err(|_| "sync_encoding".into())
}

pub fn acknowledge_sync_outbox(
    mut outbox: studio_model::ConnectedSyncOutbox,
    request_id: &str,
    receipt: studio_model::ConnectedSyncReceipt,
) -> Result<studio_model::ConnectedSyncOutbox, String> {
    if outbox.pending_request_id.as_deref() != Some(request_id) {
        return Err("sync_receipt_mismatch".into());
    }
    match receipt.status.as_str() {
        "synced" => {
            if outbox.pending_commands_count as usize > outbox.commands.len()
                || receipt.revision < outbox.base_revision
            {
                return Err("sync_receipt_invalid".into());
            }
            outbox
                .commands
                .drain(..outbox.pending_commands_count as usize);
            outbox.base_revision = receipt.revision;
            outbox.base_sha256 = receipt.snapshot_sha256;
            outbox.initial_snapshot = None;
        }
        "recovered_branch" if receipt.branch_id.is_some() => outbox.branch_id = receipt.branch_id,
        _ => return Err("sync_receipt_invalid".into()),
    }
    outbox.pending_request_id = None;
    outbox.pending_commands_count = 0;
    Ok(outbox)
}

pub fn append_sync_outbox(
    mut outbox: studio_model::ConnectedSyncOutbox,
    command: CommandEnvelope,
) -> Result<studio_model::ConnectedSyncOutbox, String> {
    if command.campaign_id != outbox.campaign_id {
        return Err("sync_campaign_mismatch".into());
    }
    if outbox
        .commands
        .iter()
        .any(|item| item.command_id == command.command_id)
    {
        return Ok(outbox);
    }
    let size = serde_json::to_vec(&outbox.commands)
        .map_err(|_| "sync_encoding")?
        .len()
        + serde_json::to_vec(&command)
            .map_err(|_| "sync_encoding")?
            .len();
    if outbox.commands.len() >= MAX_SYNC_COMMANDS || size > MAX_SYNC_BYTES {
        outbox.overflow = true;
    } else {
        outbox.commands.push(command);
    }
    Ok(outbox)
}

/// Replays an atomic bounded command batch against its immutable base. No clocks,
/// identities or active UI scopes are inferred by the domain.
pub fn replay_sync(
    base: &StudioState,
    commands: &[CommandEnvelope],
) -> Result<StudioState, String> {
    if commands.len() > MAX_SYNC_COMMANDS
        || serde_json::to_vec(commands)
            .map_err(|_| "sync_encoding")?
            .len()
            > MAX_SYNC_BYTES
    {
        return Err("sync_batch_limit".into());
    }
    let mut state = base.clone();
    let mut ids = std::collections::BTreeSet::new();
    for command in commands {
        if !ids.insert(&command.command_id) {
            return Err("duplicate_sync_command".into());
        }
        state = match crate::prepare_command(&state, command.clone())
            .map_err(|error| error.to_string())?
        {
            PrepareResult::Prepared { commit } => commit.next_state,
            PrepareResult::NoOp { state, .. } => *state,
        };
    }
    Ok(state)
}

/// Explicit recovery creates a new campaign checkpoint. The conflict snapshot is
/// retained separately; old scoped undo entries cannot target the new campaign.
pub fn fork_recovered(
    mut state: StudioState,
    id: String,
    name: String,
    at: String,
) -> Result<StudioState, String> {
    if id.trim().is_empty() || id == state.campaign.id || name.trim().is_empty() {
        return Err("invalid_recovery_identity".into());
    }
    state.campaign.id = id;
    state.campaign.name = name;
    state.campaign.revision = 0;
    state.campaign.updated_at = at;
    state.history.clear();
    state.redo.clear();
    Ok(state)
}
