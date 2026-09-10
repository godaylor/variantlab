use studio_model::{CommandEnvelope, PrepareResult, StudioState};

pub const MAX_SYNC_COMMANDS: usize = 200;
pub const MAX_SYNC_BYTES: usize = 2 * 1024 * 1024;

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
