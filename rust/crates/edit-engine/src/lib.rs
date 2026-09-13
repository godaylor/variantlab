use studio_model::{
    ChangeSet, CommandEnvelope, CommandPayload, DirtyTimeRange, HISTORY_LIMIT, HistoryEntry,
    HistoryScope, PrepareResult, PreparedCommit, ReversibleCommand, SceneScope, StudioState,
    TimelineEdit, VariantScope, snapshot_hash,
};
use thiserror::Error;
mod sync;
pub use sync::*;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EditError {
    #[error("unsupported schema version {0}")]
    UnsupportedSchema(u32),
    #[error("command targets a different campaign")]
    CampaignMismatch,
    #[error("command targets a different master sequence")]
    SequenceMismatch,
    #[error("history scope does not match the command envelope")]
    HistoryScopeMismatch,
    #[error("variant scope does not match payload target")]
    VariantScopeMismatch,
    #[error("variant command failed: {0}")]
    Variant(String),
    #[error("creative command failed: {0}")]
    Creative(String),
    #[error("caption or locale command failed: {0}")]
    Transcript(String),
    #[error("base revision {actual} does not match current revision {expected}")]
    RevisionMismatch { expected: u32, actual: u32 },
    #[error("scene scope does not match payload scene")]
    SceneScopeMismatch,
    #[error("scene {0} was not found")]
    SceneNotFound(String),
    #[error("scene name must not be empty")]
    EmptySceneName,
    #[error("master sequence must include at least one scene")]
    EmptyIncludedSequence,
    #[error("snapshot hash failed: {0}")]
    Snapshot(String),
    #[error("json contract failed: {0}")]
    Contract(String),
    #[error("timeline edit failed: {0}")]
    Timeline(String),
}

type CreativeApply = (String, Vec<String>, Vec<String>);

pub fn prepare_command(
    state: &StudioState,
    envelope: CommandEnvelope,
) -> Result<PrepareResult, EditError> {
    validate_envelope(state, &envelope)?;
    let mut next = state.clone();

    let (
        label,
        changed_entities,
        dirty_time_ranges,
        affected_variant_cells,
        invalidated_render_keys,
    ) = match &envelope.payload {
        CommandPayload::RenameScene { scene_id, new_name } => {
            let trimmed_name = new_name.trim();
            if trimmed_name.is_empty() {
                return Err(EditError::EmptySceneName);
            }
            match &envelope.scene_scope {
                SceneScope::Scene {
                    scene_id: scoped_id,
                } if scoped_id == scene_id => {}
                _ => return Err(EditError::SceneScopeMismatch),
            }
            let scene = next
                .campaign
                .master_sequence
                .scenes
                .iter_mut()
                .find(|scene| scene.id == *scene_id)
                .ok_or_else(|| EditError::SceneNotFound(scene_id.clone()))?;
            if scene.name == trimmed_name {
                return Ok(PrepareResult::NoOp {
                    reason: "Scene already has that name".to_owned(),
                    state: Box::new(state.clone()),
                });
            }
            let previous_name = scene.name.clone();
            let previous_updated_at = scene.updated_at.clone();
            scene.name = trimmed_name.to_owned();
            scene.updated_at = envelope.issued_at.clone();
            next.history.push(HistoryEntry {
                transaction_id: envelope.transaction_id.clone(),
                label: "Rename scene".to_owned(),
                scope: envelope.history_scope.clone(),
                forward: ReversibleCommand::RenameScene {
                    scene_id: scene_id.clone(),
                    name: trimmed_name.to_owned(),
                    updated_at: envelope.issued_at.clone(),
                },
                inverse: ReversibleCommand::RenameScene {
                    scene_id: scene_id.clone(),
                    name: previous_name,
                    updated_at: previous_updated_at,
                },
            });
            if next.history.len() > HISTORY_LIMIT {
                next.history.remove(0);
            }
            next.redo.clear();
            (
                "Rename scene".to_owned(),
                vec![format!("scene:{scene_id}")],
                Vec::new(),
                all_cell_ids(&next),
                all_render_keys(&next),
            )
        }
        CommandPayload::EditTimeline { scene_id, edit } => {
            match &envelope.scene_scope {
                SceneScope::Scene {
                    scene_id: scoped_id,
                } if scoped_id == scene_id => {}
                _ => return Err(EditError::SceneScopeMismatch),
            }
            let scene = next
                .campaign
                .master_sequence
                .scenes
                .iter_mut()
                .find(|scene| scene.id == *scene_id)
                .ok_or_else(|| EditError::SceneNotFound(scene_id.clone()))?;
            let previous = scene.timeline.clone().unwrap_or_default();
            let result = match timeline_engine::apply_edit(&previous, edit) {
                Ok(result) => result,
                Err(timeline_engine::TimelineError::NoOp) => {
                    return Ok(PrepareResult::NoOp {
                        reason: "Timeline edit made no change".to_owned(),
                        state: Box::new(state.clone()),
                    });
                }
                Err(error) => return Err(EditError::Timeline(error.to_string())),
            };
            let (forward, inverse) = timeline_engine::patches(&previous, &result.timeline);
            scene.timeline = Some(result.timeline);
            for binding in &next.campaign.render_bindings {
                creative_engine::validate_slot_binding(&next.campaign, binding)
                    .map_err(|error| EditError::Creative(error.to_string()))?;
            }
            let label = timeline_edit_label(edit).to_owned();
            next.history.push(HistoryEntry {
                transaction_id: envelope.transaction_id.clone(),
                label: label.clone(),
                scope: envelope.history_scope.clone(),
                forward: ReversibleCommand::ApplyTimelinePatch {
                    scene_id: scene_id.clone(),
                    patch: forward,
                },
                inverse: ReversibleCommand::ApplyTimelinePatch {
                    scene_id: scene_id.clone(),
                    patch: inverse,
                },
            });
            if next.history.len() > HISTORY_LIMIT {
                next.history.remove(0);
            }
            next.redo.clear();
            (
                label,
                result
                    .changed_clip_ids
                    .iter()
                    .map(|id| format!("clip:{id}"))
                    .collect(),
                vec![DirtyTimeRange {
                    scene_id: scene_id.clone(),
                    start_ticks: result.dirty_start_ticks,
                    end_ticks: result.dirty_end_ticks,
                }],
                all_cell_ids(&next),
                all_render_keys(&next),
            )
        }
        CommandPayload::SetSceneInclusion { scene_id, included } => {
            if envelope.scene_scope != SceneScope::Sequence
                || envelope.variant_scope != VariantScope::Master
            {
                return Err(EditError::SceneScopeMismatch);
            }
            if !next
                .campaign
                .master_sequence
                .scenes
                .iter()
                .any(|scene| scene.id == *scene_id)
            {
                return Err(EditError::SceneNotFound(scene_id.clone()));
            }
            if next.campaign.scene_is_included(scene_id) == *included {
                return Ok(PrepareResult::NoOp {
                    reason: "Scene inclusion already has that value".to_owned(),
                    state: Box::new(state.clone()),
                });
            }
            let previous = next.campaign.scene_inclusions.clone();
            next.campaign
                .scene_inclusions
                .retain(|entry| entry.scene_id != *scene_id);
            if !included {
                next.campaign
                    .scene_inclusions
                    .push(studio_model::SceneInclusion {
                        scene_id: scene_id.clone(),
                        included: false,
                    });
            }
            next.campaign
                .scene_inclusions
                .sort_by(|left, right| left.scene_id.cmp(&right.scene_id));
            if !next
                .campaign
                .master_sequence
                .scenes
                .iter()
                .any(|scene| next.campaign.scene_is_included(&scene.id))
            {
                return Err(EditError::EmptyIncludedSequence);
            }
            let forward = next.campaign.scene_inclusions.clone();
            next.history.push(HistoryEntry {
                transaction_id: envelope.transaction_id.clone(),
                label: "Set scene inclusion".to_owned(),
                scope: envelope.history_scope.clone(),
                forward: ReversibleCommand::ReplaceSceneInclusions { entries: forward },
                inverse: ReversibleCommand::ReplaceSceneInclusions { entries: previous },
            });
            trim_history(&mut next);
            next.redo.clear();
            (
                "Set scene inclusion".to_owned(),
                vec![format!("scene_inclusion:{scene_id}")],
                Vec::new(),
                all_cell_ids(&next),
                all_render_keys(&next),
            )
        }
        CommandPayload::CreateDeliveryProfile { profile, cell_id } => {
            let expected_scope = VariantScope::DeliveryProfile {
                delivery_profile_id: profile.id.clone(),
            };
            if envelope.scene_scope != SceneScope::Sequence
                || envelope.variant_scope != expected_scope
            {
                return Err(EditError::VariantScopeMismatch);
            }
            let cell = variant_engine::create_delivery_profile(
                &mut next.campaign,
                profile.clone(),
                cell_id.clone(),
            )
            .map_err(|error| EditError::Variant(error.to_string()))?;
            next.history.push(HistoryEntry {
                transaction_id: envelope.transaction_id.clone(),
                label: "Create 9:16 profile".into(),
                scope: envelope.history_scope.clone(),
                forward: ReversibleCommand::ReplaceDeliveryProfileBundle {
                    profile_id: profile.id.clone(),
                    profile: Some(profile.clone()),
                    cell_id: cell.id.clone(),
                    cell: Some(cell.clone()),
                },
                inverse: ReversibleCommand::ReplaceDeliveryProfileBundle {
                    profile_id: profile.id.clone(),
                    profile: None,
                    cell_id: cell.id.clone(),
                    cell: None,
                },
            });
            trim_history(&mut next);
            (
                "Create 9:16 profile".into(),
                vec![
                    format!("delivery_profile:{}", profile.id),
                    format!("variant_cell:{}", cell.id),
                ],
                Vec::new(),
                vec![cell.id.clone()],
                vec![format!("variant:{}", cell.id)],
            )
        }
        CommandPayload::SetVariantCrop { cell_id, crop } => {
            let expected_scope = VariantScope::VariantCell {
                variant_cell_id: cell_id.clone(),
            };
            if envelope.variant_scope != expected_scope {
                return Err(EditError::VariantScopeMismatch);
            }
            let current = next
                .campaign
                .variant_cells
                .iter()
                .find(|cell| cell.id == *cell_id)
                .ok_or_else(|| {
                    EditError::Variant(format!("variant cell {cell_id} was not found"))
                })?;
            if current.layout_override == Some(*crop) {
                return Ok(PrepareResult::NoOp {
                    reason: "Variant crop already has that value".into(),
                    state: Box::new(state.clone()),
                });
            }
            let (previous, updated) =
                variant_engine::set_crop(&mut next.campaign, cell_id, Some(*crop))
                    .map_err(|error| EditError::Variant(error.to_string()))?;
            push_variant_cell_history(&mut next, &envelope, "Adjust 9:16 crop", previous, updated);
            (
                "Adjust 9:16 crop".into(),
                vec![format!("variant_cell:{cell_id}")],
                Vec::new(),
                vec![cell_id.clone()],
                vec![format!("variant:{cell_id}")],
            )
        }
        CommandPayload::ResetVariantCrop { cell_id } => {
            let expected_scope = VariantScope::VariantCell {
                variant_cell_id: cell_id.clone(),
            };
            if envelope.variant_scope != expected_scope {
                return Err(EditError::VariantScopeMismatch);
            }
            let current = next
                .campaign
                .variant_cells
                .iter()
                .find(|cell| cell.id == *cell_id)
                .ok_or_else(|| {
                    EditError::Variant(format!("variant cell {cell_id} was not found"))
                })?;
            if current.layout_override.is_none() {
                return Ok(PrepareResult::NoOp {
                    reason: "Variant crop already inherits master geometry".into(),
                    state: Box::new(state.clone()),
                });
            }
            let (previous, updated) = variant_engine::set_crop(&mut next.campaign, cell_id, None)
                .map_err(|error| EditError::Variant(error.to_string()))?;
            push_variant_cell_history(
                &mut next,
                &envelope,
                "Reset crop to master",
                previous,
                updated,
            );
            (
                "Reset crop to master".into(),
                vec![format!("variant_cell:{cell_id}")],
                Vec::new(),
                vec![cell_id.clone()],
                vec![format!("variant:{cell_id}")],
            )
        }
        payload @ (CommandPayload::CreateSlots { .. }
        | CommandPayload::SetSlotBinding { .. }
        | CommandPayload::ClearSlotBinding { .. }
        | CommandPayload::CreateCreativeSets { .. }
        | CommandPayload::AssignSlotValues { .. }
        | CommandPayload::UpdateMasterSlotStyle { .. }
        | CommandPayload::DeleteSlot { .. }
        | CommandPayload::RemapAndDeleteSlot { .. }
        | CommandPayload::DropAndDeleteSlot { .. }) => {
            let Some((label, changed_entities, affected_variant_cells)) =
                apply_creative_payload(&mut next, &envelope, payload)?
            else {
                return Ok(PrepareResult::NoOp {
                    reason: "Creative command made no change".into(),
                    state: Box::new(state.clone()),
                });
            };
            let invalidated_render_keys = affected_variant_cells
                .iter()
                .map(|cell_id| format!("variant:{cell_id}"))
                .collect();
            (
                label,
                changed_entities,
                Vec::new(),
                affected_variant_cells,
                invalidated_render_keys,
            )
        }
        payload @ (CommandPayload::AttachTranscript { .. }
        | CommandPayload::CreateLocaleProfile { .. }
        | CommandPayload::SetCaptionPlacement { .. }
        | CommandPayload::EditCaption { .. }) => {
            if envelope.scene_scope != SceneScope::Sequence
                || envelope.variant_scope != VariantScope::Master
            {
                return Err(EditError::VariantScopeMismatch);
            }
            let previous = caption_locale_snapshot(&next);
            let (label, changed_entities) = apply_caption_locale_payload(&mut next, payload)?;
            let forward = caption_locale_snapshot(&next);
            if previous == forward {
                return Ok(PrepareResult::NoOp {
                    reason: "Caption command made no change".into(),
                    state: Box::new(state.clone()),
                });
            }
            next.history.push(HistoryEntry {
                transaction_id: envelope.transaction_id.clone(),
                label: label.clone(),
                scope: envelope.history_scope.clone(),
                forward,
                inverse: previous,
            });
            trim_history(&mut next);
            let affected = all_cell_ids(&next);
            let keys = all_render_keys(&next);
            (label, changed_entities, Vec::new(), affected, keys)
        }
        payload @ (CommandPayload::AddDeliveryProfiles { .. }
        | CommandPayload::EnableVariantCells { .. }
        | CommandPayload::DetachVariantCells { .. }
        | CommandPayload::SetBrandKit { .. }) => {
            if envelope.scene_scope != SceneScope::Sequence
                || envelope.variant_scope != VariantScope::Master
            {
                return Err(EditError::VariantScopeMismatch);
            }
            let previous_profiles = next.campaign.delivery_profiles.clone();
            let previous_cells = next.campaign.variant_cells.clone();
            let previous_kit = next.campaign.brand_kit.clone();
            let (label, changed_entities, affected) = match payload {
                CommandPayload::AddDeliveryProfiles { profiles } => {
                    let profile_ids: std::collections::BTreeSet<&str> =
                        profiles.iter().map(|profile| profile.id.as_str()).collect();
                    let ids =
                        variant_engine::add_delivery_profiles(&mut next.campaign, profiles.clone())
                            .map_err(|error| EditError::Variant(error.to_string()))?;
                    let affected = next
                        .campaign
                        .variant_cells
                        .iter()
                        .filter(|cell| profile_ids.contains(cell.delivery_profile_id.as_str()))
                        .map(|cell| cell.id.clone())
                        .collect();
                    (
                        "Add delivery profiles".to_owned(),
                        ids.into_iter()
                            .map(|id| format!("delivery_profile:{id}"))
                            .collect(),
                        affected,
                    )
                }
                CommandPayload::EnableVariantCells { cells } => {
                    let ids =
                        variant_engine::enable_variant_cells(&mut next.campaign, cells.clone())
                            .map_err(|error| EditError::Variant(error.to_string()))?;
                    (
                        "Enable variant cells".to_owned(),
                        ids.iter().map(|id| format!("variant_cell:{id}")).collect(),
                        ids,
                    )
                }
                CommandPayload::DetachVariantCells { cell_ids } => {
                    let ids = variant_engine::detach_variant_cells(&mut next.campaign, cell_ids)
                        .map_err(|error| EditError::Variant(error.to_string()))?;
                    (
                        "Detach variant cells".to_owned(),
                        ids.iter().map(|id| format!("variant_cell:{id}")).collect(),
                        ids,
                    )
                }
                CommandPayload::SetBrandKit { brand_kit } => {
                    let kit = variant_engine::set_brand_kit(&mut next.campaign, brand_kit.clone())
                        .map_err(|error| EditError::Variant(error.to_string()))?;
                    (
                        "Set BrandKit".to_owned(),
                        vec![format!("brand_kit:{}", kit.id)],
                        all_cell_ids(&next),
                    )
                }
                _ => unreachable!(),
            };
            let inverse = ReversibleCommand::ReplaceVariantMatrixState {
                delivery_profiles: previous_profiles,
                variant_cells: previous_cells,
                brand_kit: previous_kit,
                affected_cell_ids: affected.clone(),
            };
            let forward = variant_matrix_snapshot(&next, affected.clone());
            if inverse == forward {
                return Ok(PrepareResult::NoOp {
                    reason: "Variant matrix command made no change".into(),
                    state: Box::new(state.clone()),
                });
            }
            next.history.push(HistoryEntry {
                transaction_id: envelope.transaction_id.clone(),
                label: label.clone(),
                scope: envelope.history_scope.clone(),
                forward,
                inverse,
            });
            trim_history(&mut next);
            let keys = affected
                .iter()
                .map(|cell_id| format!("variant:{cell_id}"))
                .collect();
            (label, changed_entities, Vec::new(), affected, keys)
        }
        CommandPayload::Undo => {
            let Some(index) = latest_scope_index(&next.history, &envelope.history_scope) else {
                return Ok(PrepareResult::NoOp {
                    reason: scope_empty_message(&envelope.history_scope, "undo"),
                    state: Box::new(state.clone()),
                });
            };
            let entry = next.history.remove(index);
            apply_reversible(&mut next, &entry.inverse, &entry.scope)?;
            next.redo.push(entry.clone());
            let ranges = dirty_ranges(&entry.inverse);
            (
                format!("Undo {}", entry.label),
                changed_entities(&entry.inverse),
                ranges,
                affected_cells(&next, &entry.inverse),
                invalidated_keys(&next, &entry.inverse),
            )
        }
        CommandPayload::Redo => {
            let Some(index) = latest_scope_index(&next.redo, &envelope.history_scope) else {
                return Ok(PrepareResult::NoOp {
                    reason: scope_empty_message(&envelope.history_scope, "redo"),
                    state: Box::new(state.clone()),
                });
            };
            let entry = next.redo.remove(index);
            apply_reversible(&mut next, &entry.forward, &entry.scope)?;
            next.history.push(entry.clone());
            let ranges = dirty_ranges(&entry.forward);
            (
                format!("Redo {}", entry.label),
                changed_entities(&entry.forward),
                ranges,
                affected_cells(&next, &entry.forward),
                invalidated_keys(&next, &entry.forward),
            )
        }
    };

    // Includes scoped undo/redo: never commit a dangling or timing-invalid binding.
    for binding in &next.campaign.render_bindings {
        creative_engine::validate_slot_binding(&next.campaign, binding)
            .map_err(|error| EditError::Creative(error.to_string()))?;
    }
    next.campaign.revision += 1;
    next.campaign.updated_at = envelope.issued_at.clone();
    let hash = snapshot_hash(&next).map_err(|error| EditError::Snapshot(error.to_string()))?;
    Ok(PrepareResult::Prepared {
        commit: Box::new(PreparedCommit {
            envelope,
            revision: next.campaign.revision,
            snapshot_hash: hash,
            next_state: next,
            label,
            change_set: ChangeSet {
                changed_entities,
                dirty_time_ranges,
                affected_variant_cells,
                invalidated_render_keys,
                warnings: Vec::new(),
            },
        }),
    })
}

pub fn prepare_command_json(state_json: &str, envelope_json: &str) -> Result<String, EditError> {
    let state: StudioState =
        serde_json::from_str(state_json).map_err(|error| EditError::Contract(error.to_string()))?;
    let envelope: CommandEnvelope = serde_json::from_str(envelope_json)
        .map_err(|error| EditError::Contract(error.to_string()))?;
    let result = prepare_command(&state, envelope)?;
    serde_json::to_string(&result).map_err(|error| EditError::Contract(error.to_string()))
}

fn apply_creative_payload(
    state: &mut StudioState,
    envelope: &CommandEnvelope,
    payload: &CommandPayload,
) -> Result<Option<CreativeApply>, EditError> {
    if envelope.scene_scope != SceneScope::Sequence {
        return Err(EditError::SceneScopeMismatch);
    }
    let binding_only = matches!(
        payload,
        CommandPayload::SetSlotBinding { .. } | CommandPayload::ClearSlotBinding { .. }
    );
    let previous = creative_snapshot(state, binding_only);
    let (label, changed_entities, affected) = match payload {
        CommandPayload::SetSlotBinding { binding } => {
            if envelope.variant_scope != VariantScope::Master {
                return Err(EditError::VariantScopeMismatch);
            }
            creative_engine::set_slot_binding(&mut state.campaign, binding.clone())
                .map_err(|error| EditError::Creative(error.to_string()))?;
            (
                "Set explicit slot placement".to_owned(),
                vec![format!("slot:{}", binding.slot_id)],
                all_cell_ids(state),
            )
        }
        CommandPayload::ClearSlotBinding { slot_id } => {
            if envelope.variant_scope != VariantScope::Master {
                return Err(EditError::VariantScopeMismatch);
            }
            creative_engine::clear_slot_binding(&mut state.campaign, slot_id)
                .map_err(|error| EditError::Creative(error.to_string()))?;
            (
                "Clear explicit slot placement".to_owned(),
                vec![format!("slot:{slot_id}")],
                all_cell_ids(state),
            )
        }
        CommandPayload::CreateSlots { slots } => {
            if envelope.variant_scope != VariantScope::Master {
                return Err(EditError::VariantScopeMismatch);
            }
            creative_engine::create_slots(&mut state.campaign, slots.clone())
                .map_err(|error| EditError::Creative(error.to_string()))?;
            (
                "Declare creative slots".to_owned(),
                slots
                    .iter()
                    .map(|slot| format!("slot:{}", slot.id))
                    .collect(),
                all_cell_ids(state),
            )
        }
        CommandPayload::CreateCreativeSets { sets, cells } => {
            if envelope.variant_scope != VariantScope::Master {
                return Err(EditError::VariantScopeMismatch);
            }
            let affected = creative_engine::create_creative_sets(
                &mut state.campaign,
                sets.clone(),
                cells.clone(),
            )
            .map_err(|error| EditError::Creative(error.to_string()))?;
            (
                "Create creative sets".to_owned(),
                sets.iter()
                    .map(|set| format!("creative_set:{}", set.id))
                    .chain(cells.iter().map(|cell| format!("variant_cell:{}", cell.id)))
                    .collect(),
                affected,
            )
        }
        CommandPayload::AssignSlotValues { assignments } => {
            let valid_scope = match &envelope.variant_scope {
                VariantScope::Master => true,
                VariantScope::CreativeSet { creative_set_id } => assignments
                    .iter()
                    .all(|assignment| assignment.creative_set_id == *creative_set_id),
                _ => false,
            };
            if !valid_scope {
                return Err(EditError::VariantScopeMismatch);
            }
            let affected =
                creative_engine::assign_slot_values(&mut state.campaign, assignments.clone())
                    .map_err(|error| EditError::Creative(error.to_string()))?;
            (
                if assignments.len() > 1 {
                    "Assign slot values atomically".to_owned()
                } else {
                    "Assign slot value".to_owned()
                },
                assignments
                    .iter()
                    .map(|assignment| {
                        format!(
                            "creative_set:{}:slot:{}",
                            assignment.creative_set_id, assignment.slot_id
                        )
                    })
                    .collect(),
                affected,
            )
        }
        CommandPayload::UpdateMasterSlotStyle {
            slot_id,
            style_fingerprint,
        } => {
            if envelope.variant_scope != VariantScope::Master {
                return Err(EditError::VariantScopeMismatch);
            }
            if state
                .campaign
                .slots
                .iter()
                .find(|slot| slot.id == *slot_id)
                .is_some_and(|slot| slot.style_fingerprint == *style_fingerprint)
            {
                return Ok(None);
            }
            let affected = creative_engine::update_master_slot_style(
                &mut state.campaign,
                slot_id,
                style_fingerprint.clone(),
            )
            .map_err(|error| EditError::Creative(error.to_string()))?;
            (
                "Update inherited master slot style".to_owned(),
                vec![format!("slot:{slot_id}")],
                affected,
            )
        }
        CommandPayload::DeleteSlot { slot_id } => {
            if envelope.variant_scope != VariantScope::Master {
                return Err(EditError::VariantScopeMismatch);
            }
            let affected = creative_engine::delete_slot(&mut state.campaign, slot_id)
                .map_err(|error| EditError::Creative(error.to_string()))?;
            (
                "Delete unreferenced slot".to_owned(),
                vec![format!("slot:{slot_id}")],
                affected,
            )
        }
        CommandPayload::RemapAndDeleteSlot {
            source_slot_id,
            target_slot_id,
            audit_event,
        } => {
            if envelope.variant_scope != VariantScope::Master {
                return Err(EditError::VariantScopeMismatch);
            }
            let affected = creative_engine::remap_and_delete_slot(
                &mut state.campaign,
                source_slot_id,
                target_slot_id,
                audit_event.clone(),
            )
            .map_err(|error| EditError::Creative(error.to_string()))?;
            (
                "Remap slot references and delete source".to_owned(),
                vec![
                    format!("slot:{source_slot_id}"),
                    format!("slot:{target_slot_id}"),
                    format!("slot_audit:{}", audit_event.id),
                ],
                affected,
            )
        }
        CommandPayload::DropAndDeleteSlot {
            slot_id,
            audit_event,
        } => {
            if envelope.variant_scope != VariantScope::Master {
                return Err(EditError::VariantScopeMismatch);
            }
            let affected = creative_engine::drop_and_delete_slot(
                &mut state.campaign,
                slot_id,
                audit_event.clone(),
            )
            .map_err(|error| EditError::Creative(error.to_string()))?;
            (
                "Drop slot references and delete slot".to_owned(),
                vec![
                    format!("slot:{slot_id}"),
                    format!("slot_audit:{}", audit_event.id),
                ],
                affected,
            )
        }
        _ => return Err(EditError::Creative("not a creative payload".into())),
    };
    let forward = creative_snapshot(state, binding_only);
    if previous == forward {
        return Ok(None);
    }
    state.history.push(HistoryEntry {
        transaction_id: envelope.transaction_id.clone(),
        label: label.clone(),
        scope: envelope.history_scope.clone(),
        forward,
        inverse: previous,
    });
    trim_history(state);
    Ok(Some((label, changed_entities, affected)))
}

fn creative_snapshot(state: &StudioState, binding_only: bool) -> ReversibleCommand {
    if binding_only {
        return ReversibleCommand::ReplaceSlotBindings {
            bindings: state.campaign.render_bindings.clone(),
        };
    }
    ReversibleCommand::ReplaceCreativeState {
        slots: state.campaign.slots.clone(),
        render_bindings: state.campaign.render_bindings.clone(),
        creative_sets: state.campaign.creative_sets.clone(),
        variant_cells: state.campaign.variant_cells.clone(),
        slot_audit_events: state.campaign.slot_audit_events.clone(),
    }
}
fn caption_locale_snapshot(state: &StudioState) -> ReversibleCommand {
    ReversibleCommand::ReplaceCaptionLocaleState {
        transcript_artifacts: state.campaign.transcript_artifacts.clone(),
        caption_tracks: state.campaign.caption_tracks.clone(),
        locale_profiles: state.campaign.locale_profiles.clone(),
        delivery_profiles: state.campaign.delivery_profiles.clone(),
        font_manifest: state.campaign.font_manifest.clone(),
    }
}

fn variant_matrix_snapshot(
    state: &StudioState,
    affected_cell_ids: Vec<String>,
) -> ReversibleCommand {
    ReversibleCommand::ReplaceVariantMatrixState {
        delivery_profiles: state.campaign.delivery_profiles.clone(),
        variant_cells: state.campaign.variant_cells.clone(),
        brand_kit: state.campaign.brand_kit.clone(),
        affected_cell_ids,
    }
}

fn apply_caption_locale_payload(
    state: &mut StudioState,
    payload: &CommandPayload,
) -> Result<(String, Vec<String>), EditError> {
    match payload {
        CommandPayload::SetCaptionPlacement {
            track_id,
            placement,
        } => {
            if let Some(value) = placement {
                transcript_engine::validate_caption_placement(&state.campaign, track_id, value)
                    .map_err(EditError::Transcript)?;
            }
            let track = state
                .campaign
                .caption_tracks
                .iter_mut()
                .find(|track| &track.id == track_id)
                .ok_or_else(|| EditError::Transcript("caption_track_missing".into()))?;
            if track.placement != *placement {
                track.placement = placement.clone();
                track.version += 1;
            }
            Ok((
                "Set caption placement".into(),
                vec![format!("caption_track:{track_id}")],
            ))
        }
        CommandPayload::AttachTranscript { artifact, track } => {
            transcript_engine::validate_artifact(artifact)
                .map_err(|error| EditError::Transcript(error.to_string()))?;
            transcript_engine::validate_track(track, artifact)
                .map_err(|error| EditError::Transcript(error.to_string()))?;
            if state
                .campaign
                .transcript_artifacts
                .iter()
                .any(|item| item.id == artifact.id)
                || state
                    .campaign
                    .caption_tracks
                    .iter()
                    .any(|item| item.id == track.id)
            {
                return Err(EditError::Transcript(
                    "transcript artifact already exists".into(),
                ));
            }
            state.campaign.transcript_artifacts.push(artifact.clone());
            state.campaign.caption_tracks.push(track.clone());
            state
                .campaign
                .transcript_artifacts
                .sort_by(|left, right| left.id.cmp(&right.id));
            state
                .campaign
                .caption_tracks
                .sort_by(|left, right| left.id.cmp(&right.id));
            Ok((
                "Attach immutable transcript".into(),
                vec![
                    format!("transcript:{}", artifact.id),
                    format!("caption_track:{}", track.id),
                ],
            ))
        }
        CommandPayload::CreateLocaleProfile {
            profile,
            delivery_profile_id,
            font_manifest,
        } => {
            transcript_engine::validate_locale_profile(
                &state.campaign.locale_profiles,
                profile,
                font_manifest,
            )
            .map_err(|error| EditError::Transcript(error.to_string()))?;
            let delivery = state
                .campaign
                .delivery_profiles
                .iter_mut()
                .find(|item| item.id == *delivery_profile_id)
                .ok_or_else(|| {
                    EditError::Transcript(format!(
                        "delivery profile {delivery_profile_id} was not found"
                    ))
                })?;
            delivery.locale = profile.locale.clone();
            delivery.locale_profile_id = Some(profile.id.clone());
            delivery.version += 1;
            if let Some(track) = state.campaign.caption_tracks.first_mut() {
                track.locale_profile_id = Some(profile.id.clone());
                track.version += 1;
            }
            state.campaign.locale_profiles.push(profile.clone());
            state
                .campaign
                .locale_profiles
                .sort_by(|left, right| left.id.cmp(&right.id));
            state.campaign.font_manifest = Some(font_manifest.clone());
            Ok((
                "Create locale profile".into(),
                vec![
                    format!("locale_profile:{}", profile.id),
                    format!("delivery_profile:{delivery_profile_id}"),
                ],
            ))
        }
        CommandPayload::EditCaption {
            track_id,
            cue_id,
            text,
        } => {
            let track = state
                .campaign
                .caption_tracks
                .iter_mut()
                .find(|item| item.id == *track_id)
                .ok_or_else(|| {
                    EditError::Transcript(format!("caption track {track_id} was not found"))
                })?;
            transcript_engine::edit_caption(track, cue_id, text.clone())
                .map_err(|error| EditError::Transcript(error.to_string()))?;
            Ok(("Edit caption".into(), vec![format!("caption:{cue_id}")]))
        }
        _ => Err(EditError::Transcript(
            "not a caption or locale payload".into(),
        )),
    }
}

fn validate_envelope(state: &StudioState, envelope: &CommandEnvelope) -> Result<(), EditError> {
    if envelope.schema_version != state.schema_version {
        return Err(EditError::UnsupportedSchema(envelope.schema_version));
    }
    if envelope.campaign_id != state.campaign.id {
        return Err(EditError::CampaignMismatch);
    }
    if envelope.master_sequence_id != state.campaign.master_sequence.id {
        return Err(EditError::SequenceMismatch);
    }
    if envelope.base_revision != state.campaign.revision {
        return Err(EditError::RevisionMismatch {
            expected: state.campaign.revision,
            actual: envelope.base_revision,
        });
    }
    if envelope.history_scope.campaign_id != envelope.campaign_id
        || envelope.history_scope.master_sequence_id != envelope.master_sequence_id
        || envelope.history_scope.scene_scope != envelope.scene_scope
        || envelope.history_scope.variant_scope != envelope.variant_scope
    {
        return Err(EditError::HistoryScopeMismatch);
    }
    Ok(())
}

fn latest_scope_index(entries: &[HistoryEntry], scope: &HistoryScope) -> Option<usize> {
    entries.iter().rposition(|entry| entry.scope == *scope)
}

fn apply_reversible(
    state: &mut StudioState,
    command: &ReversibleCommand,
    scope: &HistoryScope,
) -> Result<(), EditError> {
    match command {
        ReversibleCommand::RenameScene {
            scene_id,
            name,
            updated_at,
        } => {
            let scene = state
                .campaign
                .master_sequence
                .scenes
                .iter_mut()
                .find(|scene| scene.id == *scene_id)
                .ok_or_else(|| EditError::SceneNotFound(scene_id.clone()))?;
            scene.name = name.clone();
            scene.updated_at = updated_at.clone();
        }
        ReversibleCommand::ApplyTimelinePatch { scene_id, patch } => {
            let scene = state
                .campaign
                .master_sequence
                .scenes
                .iter_mut()
                .find(|scene| scene.id == *scene_id)
                .ok_or_else(|| EditError::SceneNotFound(scene_id.clone()))?;
            let timeline = scene.timeline.get_or_insert_with(Default::default);
            timeline_engine::apply_patch(timeline, patch)
                .map_err(|error| EditError::Timeline(error.to_string()))?;
        }
        ReversibleCommand::ReplaceSceneInclusions { entries } => {
            state.campaign.scene_inclusions = entries.clone();
        }
        ReversibleCommand::ReplaceDeliveryProfileBundle {
            profile_id,
            profile,
            cell_id,
            cell,
        } => {
            replace_by_id(
                &mut state.campaign.delivery_profiles,
                profile_id,
                profile.clone(),
                |item| item.id.as_str(),
            );
            replace_by_id(
                &mut state.campaign.variant_cells,
                cell_id,
                cell.clone(),
                |item| item.id.as_str(),
            );
        }
        ReversibleCommand::ReplaceVariantCell { cell } => {
            replace_by_id(
                &mut state.campaign.variant_cells,
                &cell.id,
                Some(cell.clone()),
                |item| item.id.as_str(),
            );
        }
        ReversibleCommand::ReplaceCreativeState {
            slots,
            render_bindings,
            creative_sets,
            variant_cells,
            slot_audit_events,
        } => {
            if let VariantScope::CreativeSet { creative_set_id } = &scope.variant_scope {
                let recorded = creative_sets
                    .iter()
                    .find(|set| &set.id == creative_set_id)
                    .ok_or_else(|| EditError::Creative("recorded creative set missing".into()))?;
                let current = state
                    .campaign
                    .creative_sets
                    .iter_mut()
                    .find(|set| &set.id == creative_set_id)
                    .ok_or_else(|| EditError::Creative("creative set no longer exists".into()))?;
                *current = recorded.clone();
                return Ok(());
            }
            state.campaign.slots = slots.clone();
            state.campaign.render_bindings = render_bindings.clone();
            state.campaign.creative_sets = creative_sets.clone();
            state.campaign.variant_cells = variant_cells.clone();
            state.campaign.slot_audit_events = slot_audit_events.clone();
        }
        ReversibleCommand::ReplaceSlotBindings { bindings } => {
            state.campaign.render_bindings = bindings.clone();
        }
        ReversibleCommand::ReplaceCaptionLocaleState {
            transcript_artifacts,
            caption_tracks,
            locale_profiles,
            delivery_profiles,
            font_manifest,
        } => {
            state.campaign.transcript_artifacts = transcript_artifacts.clone();
            state.campaign.caption_tracks = caption_tracks.clone();
            state.campaign.locale_profiles = locale_profiles.clone();
            state.campaign.delivery_profiles = delivery_profiles.clone();
            state.campaign.font_manifest = font_manifest.clone();
        }
        ReversibleCommand::ReplaceVariantMatrixState {
            delivery_profiles,
            variant_cells,
            brand_kit,
            ..
        } => {
            state.campaign.delivery_profiles = delivery_profiles.clone();
            state.campaign.variant_cells = variant_cells.clone();
            state.campaign.brand_kit = brand_kit.clone();
        }
    }
    Ok(())
}

fn changed_entities(command: &ReversibleCommand) -> Vec<String> {
    match command {
        ReversibleCommand::ReplaceSlotBindings { bindings } => bindings
            .iter()
            .map(|binding| format!("slot:{}", binding.slot_id))
            .collect(),
        ReversibleCommand::RenameScene { scene_id, .. } => vec![format!("scene:{scene_id}")],
        ReversibleCommand::ApplyTimelinePatch { patch, .. } => patch
            .upsert
            .iter()
            .map(|placement| placement.clip.id.as_str())
            .chain(patch.remove_clip_ids.iter().map(String::as_str))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(|id| format!("clip:{id}"))
            .collect(),
        ReversibleCommand::ReplaceSceneInclusions { entries } => entries
            .iter()
            .map(|entry| format!("scene_inclusion:{}", entry.scene_id))
            .collect(),
        ReversibleCommand::ReplaceDeliveryProfileBundle {
            profile_id,
            cell_id,
            ..
        } => vec![
            format!("delivery_profile:{profile_id}"),
            format!("variant_cell:{cell_id}"),
        ],
        ReversibleCommand::ReplaceVariantCell { cell } => {
            vec![format!("variant_cell:{}", cell.id)]
        }
        ReversibleCommand::ReplaceCreativeState {
            slots,
            creative_sets,
            variant_cells,
            slot_audit_events,
            ..
        } => slots
            .iter()
            .map(|slot| format!("slot:{}", slot.id))
            .chain(
                creative_sets
                    .iter()
                    .map(|set| format!("creative_set:{}", set.id)),
            )
            .chain(
                variant_cells
                    .iter()
                    .map(|cell| format!("variant_cell:{}", cell.id)),
            )
            .chain(
                slot_audit_events
                    .iter()
                    .map(|event| format!("slot_audit:{}", event.id)),
            )
            .collect(),
        ReversibleCommand::ReplaceCaptionLocaleState {
            transcript_artifacts,
            caption_tracks,
            locale_profiles,
            delivery_profiles,
            ..
        } => transcript_artifacts
            .iter()
            .map(|item| format!("transcript:{}", item.id))
            .chain(
                caption_tracks
                    .iter()
                    .map(|item| format!("caption_track:{}", item.id)),
            )
            .chain(
                locale_profiles
                    .iter()
                    .map(|item| format!("locale_profile:{}", item.id)),
            )
            .chain(
                delivery_profiles
                    .iter()
                    .map(|item| format!("delivery_profile:{}", item.id)),
            )
            .collect(),
        ReversibleCommand::ReplaceVariantMatrixState {
            delivery_profiles,
            variant_cells,
            brand_kit,
            ..
        } => {
            let mut entities: Vec<String> = delivery_profiles
                .iter()
                .map(|profile| format!("delivery_profile:{}", profile.id))
                .chain(
                    variant_cells
                        .iter()
                        .map(|cell| format!("variant_cell:{}", cell.id)),
                )
                .collect();
            if let Some(kit) = brand_kit {
                entities.push(format!("brand_kit:{}", kit.id));
            }
            entities
        }
    }
}

fn dirty_ranges(command: &ReversibleCommand) -> Vec<DirtyTimeRange> {
    match command {
        ReversibleCommand::RenameScene { .. } => Vec::new(),
        ReversibleCommand::ApplyTimelinePatch { scene_id, patch } => {
            let start = patch
                .upsert
                .iter()
                .map(|item| item.clip.start_ticks)
                .min()
                .unwrap_or(0);
            let end = patch
                .upsert
                .iter()
                .map(|item| item.clip.start_ticks + item.clip.duration_ticks)
                .max()
                .unwrap_or(start);
            vec![DirtyTimeRange {
                scene_id: scene_id.clone(),
                start_ticks: start,
                end_ticks: end,
            }]
        }
        ReversibleCommand::ReplaceSceneInclusions { .. }
        | ReversibleCommand::ReplaceSlotBindings { .. }
        | ReversibleCommand::ReplaceDeliveryProfileBundle { .. }
        | ReversibleCommand::ReplaceVariantCell { .. }
        | ReversibleCommand::ReplaceCaptionLocaleState { .. }
        | ReversibleCommand::ReplaceVariantMatrixState { .. }
        | ReversibleCommand::ReplaceCreativeState { .. } => Vec::new(),
    }
}

fn trim_history(state: &mut StudioState) {
    if state.history.len() > HISTORY_LIMIT {
        state.history.remove(0);
    }
    state.redo.clear();
}

fn push_variant_cell_history(
    state: &mut StudioState,
    envelope: &CommandEnvelope,
    label: &str,
    previous: studio_model::VariantCell,
    updated: studio_model::VariantCell,
) {
    state.history.push(HistoryEntry {
        transaction_id: envelope.transaction_id.clone(),
        label: label.into(),
        scope: envelope.history_scope.clone(),
        forward: ReversibleCommand::ReplaceVariantCell { cell: updated },
        inverse: ReversibleCommand::ReplaceVariantCell { cell: previous },
    });
    trim_history(state);
}

fn replace_by_id<T>(
    values: &mut Vec<T>,
    id: &str,
    replacement: Option<T>,
    id_of: impl Fn(&T) -> &str,
) {
    values.retain(|item| id_of(item) != id);
    if let Some(replacement) = replacement {
        values.push(replacement);
        values.sort_by(|left, right| id_of(left).cmp(id_of(right)));
    }
}

fn all_cell_ids(state: &StudioState) -> Vec<String> {
    state
        .campaign
        .variant_cells
        .iter()
        .map(|cell| cell.id.clone())
        .collect()
}

fn all_render_keys(state: &StudioState) -> Vec<String> {
    all_cell_ids(state)
        .into_iter()
        .map(|cell_id| format!("variant:{cell_id}"))
        .collect()
}

fn affected_cells(state: &StudioState, command: &ReversibleCommand) -> Vec<String> {
    match command {
        ReversibleCommand::ReplaceDeliveryProfileBundle { cell_id, .. } => {
            vec![cell_id.clone()]
        }
        ReversibleCommand::ReplaceCreativeState { .. }
        | ReversibleCommand::ReplaceSlotBindings { .. } => all_cell_ids(state),
        ReversibleCommand::ReplaceCaptionLocaleState { .. } => all_cell_ids(state),
        ReversibleCommand::ReplaceVariantMatrixState {
            affected_cell_ids, ..
        } => affected_cell_ids.clone(),
        ReversibleCommand::ReplaceVariantCell { cell } => vec![cell.id.clone()],
        ReversibleCommand::RenameScene { .. }
        | ReversibleCommand::ApplyTimelinePatch { .. }
        | ReversibleCommand::ReplaceSceneInclusions { .. } => all_cell_ids(state),
    }
}

fn invalidated_keys(state: &StudioState, command: &ReversibleCommand) -> Vec<String> {
    affected_cells(state, command)
        .into_iter()
        .map(|cell_id| format!("variant:{cell_id}"))
        .collect()
}

fn timeline_edit_label(edit: &TimelineEdit) -> &'static str {
    match edit {
        TimelineEdit::InsertClip { .. } => "Insert media",
        TimelineEdit::MoveClips { .. } => "Move clips",
        TimelineEdit::TrimClip { ripple: true, .. } => "Ripple trim clip",
        TimelineEdit::TrimClip { ripple: false, .. } => "Trim clip",
        TimelineEdit::SplitClips { .. } => "Split clips",
        TimelineEdit::DeleteClips { ripple: true, .. } => "Ripple delete clips",
        TimelineEdit::DeleteClips { ripple: false, .. } => "Delete clips",
    }
}

fn scope_empty_message(scope: &HistoryScope, operation: &str) -> String {
    match &scope.scene_scope {
        SceneScope::Scene { scene_id } => format!(
            "Nothing to {operation} in scene {scene_id}; history in other scenes is untouched"
        ),
        SceneScope::Sequence => format!("Nothing to {operation} in this master sequence"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_model::{
        CreateCampaignInput, STUDIO_SCHEMA_VERSION, Scene, VariantScope, create_campaign,
        snapshot_hash,
    };

    fn state(campaign_id: &str) -> StudioState {
        create_campaign(CreateCampaignInput {
            campaign_id: campaign_id.into(),
            campaign_name: "Launch".into(),
            master_sequence_id: format!("sequence-{campaign_id}"),
            created_at: "2026-08-27T00:00:00Z".into(),
            scenes: vec![scene("scene-a", "Scene A"), scene("scene-b", "Scene B")],
            imported_from: None,
        })
        .unwrap()
    }

    #[test]
    fn connected_plan_preserves_conflicts_leases_and_unknown_fields() {
        let base = state("connected");
        let hash = snapshot_hash(&base).unwrap();
        let mut request = serde_json::json!({"schema_version":1,"request_id":"request","device_id":"device","base_revision":0,"base_sha256":hash,"initial_snapshot":base,"commands":[]});
        let plan =
            plan_connected_sync("connected", &request.to_string(), "null", "null", false).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&plan).unwrap()["snapshot_sha256"],
            hash
        );
        assert!(plan_connected_sync("other", &request.to_string(), "null", "null", false).is_err());
        request["initial_snapshot"]["unknown_future_field"] = true.into();
        assert_eq!(
            plan_connected_sync("connected", &request.to_string(), "null", "null", false)
                .unwrap_err(),
            "unknown_snapshot_fields"
        );
        request["initial_snapshot"] = serde_json::Value::Null;
        let head = serde_json::json!({"revision":0,"snapshot_sha256":hash});
        assert_eq!(
            plan_connected_sync(
                "connected",
                &request.to_string(),
                &serde_json::to_string(&base).unwrap(),
                &head.to_string(),
                true
            )
            .unwrap_err(),
            "writer_lease_held"
        );
        let diverged = serde_json::json!({"revision":1,"snapshot_sha256":"different"});
        let plan = plan_connected_sync(
            "connected",
            &request.to_string(),
            &serde_json::to_string(&base).unwrap(),
            &diverged.to_string(),
            true,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&plan).unwrap()["server_revision"],
            1
        );
    }

    fn scene(id: &str, name: &str) -> Scene {
        Scene {
            id: id.into(),
            name: name.into(),
            created_at: "2026-08-27T00:00:00Z".into(),
            updated_at: "2026-08-27T00:00:00Z".into(),
            timeline: Some(Default::default()),
        }
    }

    fn envelope(state: &StudioState, scene_id: &str, payload: CommandPayload) -> CommandEnvelope {
        let scene_scope = SceneScope::Scene {
            scene_id: scene_id.into(),
        };
        CommandEnvelope {
            schema_version: STUDIO_SCHEMA_VERSION,
            command_id: format!("command-{}-{}", state.campaign.revision, scene_id),
            transaction_id: format!("transaction-{}-{}", state.campaign.revision, scene_id),
            campaign_id: state.campaign.id.clone(),
            master_sequence_id: state.campaign.master_sequence.id.clone(),
            scene_scope: scene_scope.clone(),
            variant_scope: VariantScope::Master,
            history_scope: HistoryScope {
                campaign_id: state.campaign.id.clone(),
                master_sequence_id: state.campaign.master_sequence.id.clone(),
                scene_scope,
                variant_scope: VariantScope::Master,
            },
            base_revision: state.campaign.revision,
            actor_id: "local-user".into(),
            device_id: "browser-fixture".into(),
            issued_at: format!("2026-08-27T00:00:0{}Z", state.campaign.revision + 1),
            payload,
        }
    }

    fn prepared(result: PrepareResult) -> StudioState {
        match result {
            PrepareResult::Prepared { commit } => commit.next_state,
            PrepareResult::NoOp { .. } => panic!("expected prepared commit"),
        }
    }

    #[test]
    fn sync_replay_is_atomic_and_preserves_two_offline_writers() {
        let base = state("sync-campaign");
        let make = |name: &str| {
            envelope(
                &base,
                "scene-a",
                CommandPayload::RenameScene {
                    scene_id: "scene-a".into(),
                    new_name: name.into(),
                },
            )
        };
        let left = replay_sync(&base, &[make("Left")]).unwrap();
        let right = replay_sync(&base, &[make("Right")]).unwrap();
        assert_ne!(
            snapshot_hash(&left).unwrap(),
            snapshot_hash(&right).unwrap()
        );
        assert_eq!(base.campaign.revision, 0);
        assert!(replay_sync(&base, &[make("Left"), make("Right")]).is_err());
        let recovered = fork_recovered(
            right.clone(),
            "recovered".into(),
            "Recovered branch".into(),
            "2026-09-10T00:00:00Z".into(),
        )
        .unwrap();
        assert_eq!(
            recovered.campaign.master_sequence,
            right.campaign.master_sequence
        );
        assert_eq!(recovered.campaign.revision, 0);
        assert!(recovered.history.is_empty() && recovered.redo.is_empty());
        assert_eq!(left.campaign.master_sequence.scenes[0].name, "Left");
        assert!(replay_sync(&base, &vec![make("Left"); MAX_SYNC_COMMANDS + 1]).is_err());
        let mut outbox = studio_model::ConnectedSyncOutbox {
            campaign_id: base.campaign.id.clone(),
            base_revision: 0,
            base_sha256: snapshot_hash(&base).unwrap(),
            commands: vec![],
            pending_request_id: None,
            pending_commands_count: 0,
            branch_id: None,
            overflow: false,
            initial_snapshot: None,
        };
        for i in 0..=MAX_SYNC_COMMANDS {
            let mut command = make("Left");
            command.command_id = i.to_string();
            outbox = append_sync_outbox(outbox, command).unwrap();
        }
        assert!(outbox.overflow);
        assert_eq!(outbox.commands.len(), MAX_SYNC_COMMANDS);
    }

    #[test]
    fn explicit_binding_is_scoped_noop_undoable_and_cannot_orphan_a_clip() {
        use studio_model::{
            MasterRenderBinding, Slot, SlotFitPolicy, SlotKind, SlotRenderTarget, SlotValue,
        };
        let initial = state("bindings");
        let mut with_clip = prepared(
            prepare_command(
                &initial,
                envelope(
                    &initial,
                    "scene-a",
                    CommandPayload::EditTimeline {
                        scene_id: "scene-a".into(),
                        edit: TimelineEdit::InsertClip {
                            track_id: "video-1".into(),
                            clip: studio_model::TimelineClip {
                                id: "clip-a".into(),
                                asset_id: "actual-asset".into(),
                                label: "Original".into(),
                                start_ticks: 0,
                                duration_ticks: 48000,
                                source_offset_ticks: 0,
                                source_duration_ticks: 48000,
                                has_audio: true,
                            },
                        },
                    },
                ),
            )
            .unwrap(),
        );
        with_clip.campaign.slots.push(Slot {
            id: "hook".into(),
            name: "Hook".into(),
            kind: SlotKind::Hook,
            master_entity_id: "clip-a".into(),
            master_value: SlotValue::Media {
                asset_id: "actual-asset".into(),
                duration_ticks: 48000,
            },
            duration_ticks: 48000,
            fit_policy: SlotFitPolicy::ExactDuration,
            style_fingerprint: "explicit".into(),
            version: 1,
        });
        let binding = MasterRenderBinding {
            slot_id: "hook".into(),
            target: SlotRenderTarget::Clip {
                scene_id: "scene-a".into(),
                clip_id: "clip-a".into(),
            },
        };
        with_clip
            .campaign
            .creative_sets
            .push(studio_model::CreativeSet {
                id: "row".into(),
                name: "Row".into(),
                replacements: Vec::new(),
                version: 1,
            });
        let payload = CommandPayload::SetSlotBinding {
            binding: binding.clone(),
        };
        assert!(
            prepare_command(&with_clip, envelope(&with_clip, "scene-a", payload.clone())).is_err()
        );
        let master = |state: &StudioState, payload| {
            let mut command = envelope(state, "scene-a", payload);
            command.scene_scope = SceneScope::Sequence;
            command.history_scope.scene_scope = SceneScope::Sequence;
            command
        };
        let bound =
            prepared(prepare_command(&with_clip, master(&with_clip, payload.clone())).unwrap());
        assert_eq!(bound.campaign.render_bindings, vec![binding]);
        assert!(matches!(
            prepare_command(&bound, master(&bound, payload)).unwrap(),
            PrepareResult::NoOp { .. }
        ));
        // Scene-scoped undo must not remove the clip referenced by a later master command.
        assert!(
            prepare_command(&bound, envelope(&bound, "scene-a", CommandPayload::Undo)).is_err()
        );
        assert_eq!(bound.campaign.render_bindings.len(), 1);
        let undone =
            prepared(prepare_command(&bound, master(&bound, CommandPayload::Undo)).unwrap());
        assert!(undone.campaign.render_bindings.is_empty());
        let redone =
            prepared(prepare_command(&undone, master(&undone, CommandPayload::Redo)).unwrap());
        assert_eq!(
            bound.campaign.render_bindings,
            redone.campaign.render_bindings
        );
        let mut row_command = master(
            &bound,
            CommandPayload::AssignSlotValues {
                assignments: vec![studio_model::SlotAssignment {
                    creative_set_id: "row".into(),
                    slot_id: "hook".into(),
                    value: SlotValue::Media {
                        asset_id: "actual-alternative".into(),
                        duration_ticks: 48000,
                    },
                }],
            },
        );
        row_command.variant_scope = VariantScope::CreativeSet {
            creative_set_id: "row".into(),
        };
        row_command.history_scope.variant_scope = row_command.variant_scope.clone();
        let assigned = prepared(prepare_command(&bound, row_command).unwrap());
        let undone_binding =
            prepared(prepare_command(&assigned, master(&assigned, CommandPayload::Undo)).unwrap());
        assert_eq!(
            undone_binding.campaign.creative_sets, assigned.campaign.creative_sets,
            "binding undo must preserve later row assignments"
        );
        let cleared = prepared(
            prepare_command(
                &assigned,
                master(
                    &assigned,
                    CommandPayload::ClearSlotBinding {
                        slot_id: "hook".into(),
                    },
                ),
            )
            .unwrap(),
        );
        let mut undo_row = master(&cleared, CommandPayload::Undo);
        undo_row.variant_scope = VariantScope::CreativeSet {
            creative_set_id: "row".into(),
        };
        undo_row.history_scope.variant_scope = undo_row.variant_scope.clone();
        let row_undone = prepared(prepare_command(&cleared, undo_row).unwrap());
        assert!(
            row_undone.campaign.render_bindings.is_empty(),
            "row undo must not restore an old master binding"
        );
        assert!(row_undone.campaign.creative_sets[0].replacements.is_empty());
    }

    #[test]
    fn edit_a_switch_b_undo_does_not_touch_a() {
        let initial = state("campaign-a");
        let renamed = prepared(
            prepare_command(
                &initial,
                envelope(
                    &initial,
                    "scene-a",
                    CommandPayload::RenameScene {
                        scene_id: "scene-a".into(),
                        new_name: "Hook winner".into(),
                    },
                ),
            )
            .unwrap(),
        );
        let result = prepare_command(
            &renamed,
            envelope(&renamed, "scene-b", CommandPayload::Undo),
        )
        .unwrap();
        assert!(matches!(result, PrepareResult::NoOp { .. }));
        assert_eq!(
            renamed.campaign.master_sequence.scenes[0].name,
            "Hook winner"
        );
    }

    #[test]
    fn timeline_edit_a_switch_b_undo_preserves_a_then_undo_a_restores_it() {
        let initial = state("campaign-a");
        let edited = prepared(
            prepare_command(
                &initial,
                envelope(
                    &initial,
                    "scene-a",
                    CommandPayload::EditTimeline {
                        scene_id: "scene-a".into(),
                        edit: TimelineEdit::InsertClip {
                            track_id: "video-1".into(),
                            clip: studio_model::TimelineClip {
                                id: "clip-a".into(),
                                asset_id: "asset-a".into(),
                                label: "Master".into(),
                                start_ticks: 0,
                                duration_ticks: 48_000,
                                source_offset_ticks: 0,
                                source_duration_ticks: 48_000,
                                has_audio: true,
                            },
                        },
                    },
                ),
            )
            .unwrap(),
        );
        let b_undo =
            prepare_command(&edited, envelope(&edited, "scene-b", CommandPayload::Undo)).unwrap();
        assert!(matches!(b_undo, PrepareResult::NoOp { .. }));
        assert_eq!(
            edited.campaign.master_sequence.scenes[0]
                .timeline
                .as_ref()
                .unwrap()
                .tracks[0]
                .clips
                .len(),
            1
        );
        let restored = prepared(
            prepare_command(&edited, envelope(&edited, "scene-a", CommandPayload::Undo)).unwrap(),
        );
        assert!(
            restored.campaign.master_sequence.scenes[0]
                .timeline
                .as_ref()
                .unwrap()
                .tracks[0]
                .clips
                .is_empty()
        );
    }

    #[test]
    fn project_a_open_b_undo_is_a_no_op() {
        let campaign_a = state("campaign-a");
        let campaign_b = state("campaign-b");
        let result = prepare_command(
            &campaign_b,
            envelope(&campaign_b, "scene-a", CommandPayload::Undo),
        )
        .unwrap();
        assert!(matches!(result, PrepareResult::NoOp { .. }));
        assert_ne!(
            snapshot_hash(&campaign_a).unwrap(),
            snapshot_hash(&campaign_b).unwrap()
        );
    }

    #[test]
    fn apply_and_inverse_restore_scene_content() {
        let initial = state("campaign-a");
        let renamed = prepared(
            prepare_command(
                &initial,
                envelope(
                    &initial,
                    "scene-a",
                    CommandPayload::RenameScene {
                        scene_id: "scene-a".into(),
                        new_name: "Hook winner".into(),
                    },
                ),
            )
            .unwrap(),
        );
        let undone = prepared(
            prepare_command(
                &renamed,
                envelope(&renamed, "scene-a", CommandPayload::Undo),
            )
            .unwrap(),
        );
        assert_eq!(undone.campaign.master_sequence.scenes[0].name, "Scene A");
    }

    #[test]
    fn semantic_no_op_creates_no_revision_or_history() {
        let initial = state("campaign-a");
        let result = prepare_command(
            &initial,
            envelope(
                &initial,
                "scene-a",
                CommandPayload::RenameScene {
                    scene_id: "scene-a".into(),
                    new_name: "Scene A".into(),
                },
            ),
        )
        .unwrap();
        match result {
            PrepareResult::NoOp { state, .. } => assert_eq!(*state, initial),
            PrepareResult::Prepared { .. } => panic!("no-op must not create a commit"),
        }
    }

    fn variant_envelope(
        state: &StudioState,
        scene_scope: SceneScope,
        variant_scope: VariantScope,
        payload: CommandPayload,
    ) -> CommandEnvelope {
        CommandEnvelope {
            schema_version: STUDIO_SCHEMA_VERSION,
            command_id: format!("variant-command-{}", state.campaign.revision),
            transaction_id: format!("variant-transaction-{}", state.campaign.revision),
            campaign_id: state.campaign.id.clone(),
            master_sequence_id: state.campaign.master_sequence.id.clone(),
            scene_scope: scene_scope.clone(),
            variant_scope: variant_scope.clone(),
            history_scope: HistoryScope {
                campaign_id: state.campaign.id.clone(),
                master_sequence_id: state.campaign.master_sequence.id.clone(),
                scene_scope,
                variant_scope,
            },
            base_revision: state.campaign.revision,
            actor_id: "local-user".into(),
            device_id: "browser-fixture".into(),
            issued_at: format!("2026-08-28T00:00:{:02}Z", state.campaign.revision + 1),
            payload,
        }
    }

    fn vertical_profile() -> studio_model::DeliveryProfile {
        studio_model::DeliveryProfile {
            id: "profile-vertical".into(),
            name: "9:16 social".into(),
            canvas: studio_model::CanvasSpec {
                width: 1080,
                height: 1920,
            },
            safe_area: studio_model::SafeArea {
                top_basis_points: 800,
                right_basis_points: 600,
                bottom_basis_points: 1400,
                left_basis_points: 600,
            },
            locale: "en".into(),
            layout_constraints: vec!["safe_area".into()],
            version: 1,
            locale_profile_id: None,
        }
    }

    #[test]
    fn crop_history_is_scoped_to_the_variant_cell_and_does_not_copy_master() {
        let initial = state("campaign-a");
        let profile = vertical_profile();
        let with_profile = prepared(
            prepare_command(
                &initial,
                variant_envelope(
                    &initial,
                    SceneScope::Sequence,
                    VariantScope::DeliveryProfile {
                        delivery_profile_id: profile.id.clone(),
                    },
                    CommandPayload::CreateDeliveryProfile {
                        profile,
                        cell_id: "cell-vertical".into(),
                    },
                ),
            )
            .unwrap(),
        );
        let master_before = with_profile.campaign.master_sequence.clone();
        let cropped = prepared(
            prepare_command(
                &with_profile,
                variant_envelope(
                    &with_profile,
                    SceneScope::Scene {
                        scene_id: "scene-a".into(),
                    },
                    VariantScope::VariantCell {
                        variant_cell_id: "cell-vertical".into(),
                    },
                    CommandPayload::SetVariantCrop {
                        cell_id: "cell-vertical".into(),
                        crop: studio_model::CropOverride {
                            x_basis_points: 1_000,
                            y_basis_points: 0,
                            scale_basis_points: 10_000,
                        },
                    },
                ),
            )
            .unwrap(),
        );
        assert_eq!(cropped.campaign.master_sequence, master_before);
        let undone = prepared(
            prepare_command(
                &cropped,
                variant_envelope(
                    &cropped,
                    SceneScope::Scene {
                        scene_id: "scene-a".into(),
                    },
                    VariantScope::VariantCell {
                        variant_cell_id: "cell-vertical".into(),
                    },
                    CommandPayload::Undo,
                ),
            )
            .unwrap(),
        );
        assert_eq!(undone.campaign.variant_cells[0].layout_override, None);
        assert_eq!(undone.campaign.master_sequence, master_before);
    }

    #[test]
    fn matrix_bulk_command_is_atomic_and_undo_targets_master_scope() {
        let initial = state("campaign-m6");
        let with_profile = prepared(
            prepare_command(
                &initial,
                variant_envelope(
                    &initial,
                    SceneScope::Sequence,
                    VariantScope::Master,
                    CommandPayload::AddDeliveryProfiles {
                        profiles: vec![vertical_profile()],
                    },
                ),
            )
            .unwrap(),
        );
        let duplicate_key_error = prepare_command(
            &with_profile,
            variant_envelope(
                &with_profile,
                SceneScope::Sequence,
                VariantScope::Master,
                CommandPayload::EnableVariantCells {
                    cells: vec![
                        studio_model::VariantCell {
                            id: "cell-a".into(),
                            creative_set_id: "master".into(),
                            delivery_profile_id: "profile-vertical".into(),
                            layout_override: None,
                            version: 1,
                        },
                        studio_model::VariantCell {
                            id: "cell-b".into(),
                            creative_set_id: "master".into(),
                            delivery_profile_id: "profile-vertical".into(),
                            layout_override: None,
                            version: 1,
                        },
                    ],
                },
            ),
        );
        assert!(matches!(duplicate_key_error, Err(EditError::Variant(_))));
        assert!(with_profile.campaign.variant_cells.is_empty());

        let enabled = prepared(
            prepare_command(
                &with_profile,
                variant_envelope(
                    &with_profile,
                    SceneScope::Sequence,
                    VariantScope::Master,
                    CommandPayload::EnableVariantCells {
                        cells: vec![studio_model::VariantCell {
                            id: "cell-a".into(),
                            creative_set_id: "master".into(),
                            delivery_profile_id: "profile-vertical".into(),
                            layout_override: None,
                            version: 1,
                        }],
                    },
                ),
            )
            .unwrap(),
        );
        assert_eq!(enabled.campaign.variant_cells.len(), 1);
        let undone = prepared(
            prepare_command(
                &enabled,
                variant_envelope(
                    &enabled,
                    SceneScope::Sequence,
                    VariantScope::Master,
                    CommandPayload::Undo,
                ),
            )
            .unwrap(),
        );
        assert!(undone.campaign.variant_cells.is_empty());
        assert_eq!(undone.campaign.delivery_profiles.len(), 1);
    }
}
