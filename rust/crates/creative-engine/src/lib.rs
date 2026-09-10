use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use studio_model::{
    Campaign, CreativeSet, Slot, SlotAssignment, SlotAuditEvent, SlotAuditKind, SlotFitPolicy,
    SlotKind, SlotReplacement, SlotValue, VariantCell,
};
use thiserror::Error;
use ts_rs::TS;

mod bindings;
pub use bindings::*;

pub const MAX_CREATIVE_SETS_INCLUDING_MASTER: usize = 12;
pub const MAX_ALTERNATIVE_CREATIVE_SETS: usize = MAX_CREATIVE_SETS_INCLUDING_MASTER - 1;
pub const MAX_SLOTS: usize = 32;
pub const MAX_VARIANT_CELLS: usize = 100;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CreativeError {
    #[error("creative sets are limited to 12 rows including master")]
    CreativeSetLimit,
    #[error("slots are limited to 32 named declarations")]
    SlotLimit,
    #[error("slot, creative-set, cell, and audit IDs must be non-empty and unique")]
    InvalidIdentity,
    #[error("slot {0} was not found")]
    SlotNotFound(String),
    #[error("creative set {0} was not found")]
    CreativeSetNotFound(String),
    #[error("slot value does not match the declared slot type")]
    SlotTypeMismatch,
    #[error("replacement duration must equal the declared fixed slot duration")]
    DurationMismatch,
    #[error("text replacement must contain 1 to 2000 characters")]
    InvalidText,
    #[error("asset references must be stable non-empty IDs")]
    InvalidAssetReference,
    #[error("creative-set cells must cover every explicit delivery profile exactly once")]
    InvalidCellCoverage,
    #[error("variant cell keys must be unique and the campaign is limited to 100 cells")]
    InvalidCellKey,
    #[error("slot {0} is referenced; remap or explicitly drop references before deletion")]
    ReferencedSlot(String),
    #[error("remap target must have the same slot type, duration, and fit policy")]
    IncompatibleRemap,
    #[error("remap would create two values for the same target slot")]
    DuplicateTargetReplacement,
    #[error("audit event does not match the requested destructive operation")]
    InvalidAuditEvent,
    #[error("invalid explicit slot binding: {0}")]
    InvalidBinding(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ResolvedSlot {
    pub slot_id: String,
    pub slot_name: String,
    pub value: SlotValue,
    pub style_fingerprint: String,
    pub value_source: String,
    pub value_source_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BulkAssignmentPreview {
    pub affected_cell_ids: Vec<String>,
    pub assignment_count: u32,
    pub reused_asset_ids: Vec<String>,
}

pub fn create_slots(campaign: &mut Campaign, mut slots: Vec<Slot>) -> Result<(), CreativeError> {
    if campaign.slots.len() + slots.len() > MAX_SLOTS {
        return Err(CreativeError::SlotLimit);
    }
    let mut ids: BTreeSet<String> = campaign.slots.iter().map(|slot| slot.id.clone()).collect();
    let mut entities: BTreeSet<String> = campaign
        .slots
        .iter()
        .map(|slot| slot.master_entity_id.clone())
        .collect();
    for slot in &slots {
        validate_slot(slot)?;
        if !ids.insert(slot.id.clone()) || !entities.insert(slot.master_entity_id.clone()) {
            return Err(CreativeError::InvalidIdentity);
        }
    }
    slots.sort_by(|left, right| left.id.cmp(&right.id));
    campaign.slots.extend(slots);
    campaign.slots.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(())
}

pub fn create_creative_sets(
    campaign: &mut Campaign,
    mut sets: Vec<CreativeSet>,
    mut cells: Vec<VariantCell>,
) -> Result<Vec<String>, CreativeError> {
    if campaign.creative_sets.len() + sets.len() > MAX_ALTERNATIVE_CREATIVE_SETS {
        return Err(CreativeError::CreativeSetLimit);
    }
    let mut set_ids: BTreeSet<String> = campaign
        .creative_sets
        .iter()
        .map(|set| set.id.clone())
        .collect();
    for set in &sets {
        if set.id.trim().is_empty()
            || set.id == "master"
            || set.name.trim().is_empty()
            || !set.replacements.is_empty()
            || !set_ids.insert(set.id.clone())
        {
            return Err(CreativeError::InvalidIdentity);
        }
    }
    validate_new_cells(campaign, &sets, &cells)?;
    let affected = sorted_unique(cells.iter().map(|cell| cell.id.clone()));
    sets.sort_by(|left, right| left.id.cmp(&right.id));
    cells.sort_by(|left, right| left.id.cmp(&right.id));
    campaign.creative_sets.extend(sets);
    campaign.variant_cells.extend(cells);
    campaign
        .creative_sets
        .sort_by(|left, right| left.id.cmp(&right.id));
    campaign
        .variant_cells
        .sort_by(|left, right| left.id.cmp(&right.id));
    Ok(affected)
}

pub fn preview_assignments(
    campaign: &Campaign,
    assignments: &[SlotAssignment],
) -> Result<BulkAssignmentPreview, CreativeError> {
    let mut clone = campaign.clone();
    let affected_cell_ids = assign_slot_values(&mut clone, assignments.to_vec())?;
    let reused_asset_ids =
        sorted_unique(
            assignments
                .iter()
                .filter_map(|assignment| match &assignment.value {
                    SlotValue::Media { asset_id, .. } | SlotValue::Logo { asset_id } => {
                        Some(asset_id.clone())
                    }
                    SlotValue::Text { .. } => None,
                }),
        );
    Ok(BulkAssignmentPreview {
        affected_cell_ids,
        assignment_count: assignments.len() as u32,
        reused_asset_ids,
    })
}

pub fn assign_slot_values(
    campaign: &mut Campaign,
    assignments: Vec<SlotAssignment>,
) -> Result<Vec<String>, CreativeError> {
    let mut planned: BTreeMap<(String, String), SlotValue> = BTreeMap::new();
    for assignment in &assignments {
        let slot = campaign
            .slots
            .iter()
            .find(|slot| slot.id == assignment.slot_id)
            .ok_or_else(|| CreativeError::SlotNotFound(assignment.slot_id.clone()))?;
        if !campaign
            .creative_sets
            .iter()
            .any(|set| set.id == assignment.creative_set_id)
        {
            return Err(CreativeError::CreativeSetNotFound(
                assignment.creative_set_id.clone(),
            ));
        }
        validate_value(slot, &assignment.value)?;
        let key = (
            assignment.creative_set_id.clone(),
            assignment.slot_id.clone(),
        );
        if planned.insert(key, assignment.value.clone()).is_some() {
            return Err(CreativeError::InvalidIdentity);
        }
    }

    let mut changed_set_ids = BTreeSet::new();
    for ((set_id, slot_id), value) in planned {
        let set = campaign
            .creative_sets
            .iter_mut()
            .find(|set| set.id == set_id)
            .ok_or_else(|| CreativeError::CreativeSetNotFound(set_id.clone()))?;
        if set
            .replacements
            .iter()
            .any(|replacement| replacement.slot_id == slot_id && replacement.value == value)
        {
            continue;
        }
        changed_set_ids.insert(set_id.clone());
        match set
            .replacements
            .iter_mut()
            .find(|replacement| replacement.slot_id == slot_id)
        {
            Some(replacement) => replacement.value = value,
            None => set.replacements.push(SlotReplacement { slot_id, value }),
        }
        set.replacements
            .sort_by(|left, right| left.slot_id.cmp(&right.slot_id));
        set.version += 1;
    }

    Ok(affected_cells_for_sets(
        campaign,
        changed_set_ids.iter().map(String::as_str),
    ))
}

pub fn update_master_slot_style(
    campaign: &mut Campaign,
    slot_id: &str,
    style_fingerprint: String,
) -> Result<Vec<String>, CreativeError> {
    if style_fingerprint.trim().is_empty() {
        return Err(CreativeError::InvalidIdentity);
    }
    let slot = campaign
        .slots
        .iter_mut()
        .find(|slot| slot.id == slot_id)
        .ok_or_else(|| CreativeError::SlotNotFound(slot_id.to_owned()))?;
    slot.style_fingerprint = style_fingerprint;
    slot.version += 1;
    Ok(dependency_cells(campaign, slot_id))
}

pub fn delete_slot(campaign: &mut Campaign, slot_id: &str) -> Result<Vec<String>, CreativeError> {
    if campaign
        .render_bindings
        .iter()
        .any(|binding| binding.slot_id == slot_id)
    {
        return Err(CreativeError::ReferencedSlot(slot_id.to_owned()));
    }
    if campaign.creative_sets.iter().any(|set| {
        set.replacements
            .iter()
            .any(|replacement| replacement.slot_id == slot_id)
    }) {
        return Err(CreativeError::ReferencedSlot(slot_id.to_owned()));
    }
    let affected = dependency_cells(campaign, slot_id);
    let before = campaign.slots.len();
    campaign.slots.retain(|slot| slot.id != slot_id);
    if campaign.slots.len() == before {
        return Err(CreativeError::SlotNotFound(slot_id.to_owned()));
    }
    Ok(affected)
}

pub fn remap_and_delete_slot(
    campaign: &mut Campaign,
    source_slot_id: &str,
    target_slot_id: &str,
    audit_event: SlotAuditEvent,
) -> Result<Vec<String>, CreativeError> {
    if campaign
        .render_bindings
        .iter()
        .any(|binding| binding.slot_id == source_slot_id)
    {
        return Err(CreativeError::ReferencedSlot(source_slot_id.to_owned()));
    }
    validate_audit(
        &audit_event,
        SlotAuditKind::Remap,
        source_slot_id,
        Some(target_slot_id),
    )?;
    let source = campaign
        .slots
        .iter()
        .find(|slot| slot.id == source_slot_id)
        .cloned()
        .ok_or_else(|| CreativeError::SlotNotFound(source_slot_id.to_owned()))?;
    let target = campaign
        .slots
        .iter()
        .find(|slot| slot.id == target_slot_id)
        .cloned()
        .ok_or_else(|| CreativeError::SlotNotFound(target_slot_id.to_owned()))?;
    if source.kind != target.kind
        || source.duration_ticks != target.duration_ticks
        || source.fit_policy != target.fit_policy
    {
        return Err(CreativeError::IncompatibleRemap);
    }
    for set in &campaign.creative_sets {
        let has_source = set
            .replacements
            .iter()
            .any(|replacement| replacement.slot_id == source_slot_id);
        let has_target = set
            .replacements
            .iter()
            .any(|replacement| replacement.slot_id == target_slot_id);
        if has_source && has_target {
            return Err(CreativeError::DuplicateTargetReplacement);
        }
    }
    for set in &mut campaign.creative_sets {
        for replacement in &mut set.replacements {
            if replacement.slot_id == source_slot_id {
                validate_value(&target, &replacement.value)?;
                replacement.slot_id = target_slot_id.to_owned();
            }
        }
        set.replacements
            .sort_by(|left, right| left.slot_id.cmp(&right.slot_id));
        set.version += 1;
    }
    campaign.slots.retain(|slot| slot.id != source_slot_id);
    // A remap retains the target's explicit placement. The source must be
    // explicitly unbound first; never choose between two placements implicitly.
    campaign.slot_audit_events.push(audit_event);
    campaign
        .slot_audit_events
        .sort_by(|left, right| left.id.cmp(&right.id));
    Ok(dependency_cells(campaign, target_slot_id))
}

pub fn drop_and_delete_slot(
    campaign: &mut Campaign,
    slot_id: &str,
    audit_event: SlotAuditEvent,
) -> Result<Vec<String>, CreativeError> {
    validate_audit(&audit_event, SlotAuditKind::DropReferences, slot_id, None)?;
    if !campaign.slots.iter().any(|slot| slot.id == slot_id) {
        return Err(CreativeError::SlotNotFound(slot_id.to_owned()));
    }
    let affected = dependency_cells(campaign, slot_id);
    for set in &mut campaign.creative_sets {
        set.replacements
            .retain(|replacement| replacement.slot_id != slot_id);
        set.version += 1;
    }
    campaign.slots.retain(|slot| slot.id != slot_id);
    campaign
        .render_bindings
        .retain(|binding| binding.slot_id != slot_id);
    campaign.slot_audit_events.push(audit_event);
    campaign
        .slot_audit_events
        .sort_by(|left, right| left.id.cmp(&right.id));
    Ok(affected)
}

pub fn resolve_slots(
    campaign: &Campaign,
    creative_set_id: &str,
) -> Result<Vec<ResolvedSlot>, CreativeError> {
    let set = campaign
        .creative_sets
        .iter()
        .find(|set| set.id == creative_set_id);
    if creative_set_id != "master" && set.is_none() {
        return Err(CreativeError::CreativeSetNotFound(
            creative_set_id.to_owned(),
        ));
    }
    let mut resolved = Vec::with_capacity(campaign.slots.len());
    for slot in &campaign.slots {
        let replacement = set.and_then(|set| {
            set.replacements
                .iter()
                .find(|replacement| replacement.slot_id == slot.id)
        });
        resolved.push(ResolvedSlot {
            slot_id: slot.id.clone(),
            slot_name: slot.name.clone(),
            value: replacement
                .map(|replacement| replacement.value.clone())
                .unwrap_or_else(|| slot.master_value.clone()),
            style_fingerprint: slot.style_fingerprint.clone(),
            value_source: if replacement.is_some() {
                "creative_set".into()
            } else {
                "master".into()
            },
            value_source_id: replacement
                .map(|_| creative_set_id.to_owned())
                .unwrap_or_else(|| campaign.master_sequence.id.clone()),
        });
    }
    resolved.sort_by(|left, right| left.slot_id.cmp(&right.slot_id));
    Ok(resolved)
}

pub fn dependency_cells(campaign: &Campaign, slot_id: &str) -> Vec<String> {
    if !campaign.slots.iter().any(|slot| slot.id == slot_id) {
        return Vec::new();
    }
    sorted_unique(campaign.variant_cells.iter().map(|cell| cell.id.clone()))
}

fn affected_cells_for_sets<'a>(
    campaign: &Campaign,
    set_ids: impl Iterator<Item = &'a str>,
) -> Vec<String> {
    let ids: BTreeSet<&str> = set_ids.collect();
    sorted_unique(
        campaign
            .variant_cells
            .iter()
            .filter(|cell| ids.contains(cell.creative_set_id.as_str()))
            .map(|cell| cell.id.clone()),
    )
}

fn validate_new_cells(
    campaign: &Campaign,
    sets: &[CreativeSet],
    cells: &[VariantCell],
) -> Result<(), CreativeError> {
    if campaign.variant_cells.len() + cells.len() > MAX_VARIANT_CELLS {
        return Err(CreativeError::InvalidCellKey);
    }
    // M6 creates finite matrix axes explicitly: a row-only command must not
    // materialize the delivery-profile Cartesian product. The original M4
    // atomic bundle contract remains unchanged whenever cells are supplied.
    if cells.is_empty() {
        return Ok(());
    }
    let profiles: BTreeSet<&str> = campaign
        .delivery_profiles
        .iter()
        .map(|profile| profile.id.as_str())
        .collect();
    let set_ids: BTreeSet<&str> = sets.iter().map(|set| set.id.as_str()).collect();
    let expected = profiles.len() * set_ids.len();
    if cells.len() != expected || profiles.is_empty() {
        return Err(CreativeError::InvalidCellCoverage);
    }
    let mut keys: BTreeSet<(String, String)> = campaign
        .variant_cells
        .iter()
        .map(|cell| {
            (
                cell.creative_set_id.clone(),
                cell.delivery_profile_id.clone(),
            )
        })
        .collect();
    let mut cell_ids: BTreeSet<String> = campaign
        .variant_cells
        .iter()
        .map(|cell| cell.id.clone())
        .collect();
    for cell in cells {
        if cell.id.trim().is_empty()
            || !set_ids.contains(cell.creative_set_id.as_str())
            || !profiles.contains(cell.delivery_profile_id.as_str())
            || cell.layout_override.is_some()
            || !cell_ids.insert(cell.id.clone())
            || !keys.insert((
                cell.creative_set_id.clone(),
                cell.delivery_profile_id.clone(),
            ))
        {
            return Err(CreativeError::InvalidCellCoverage);
        }
    }
    Ok(())
}

fn validate_slot(slot: &Slot) -> Result<(), CreativeError> {
    if slot.id.trim().is_empty()
        || slot.name.trim().is_empty()
        || slot.master_entity_id.trim().is_empty()
        || slot.style_fingerprint.trim().is_empty()
        || slot.duration_ticks < 0
    {
        return Err(CreativeError::InvalidIdentity);
    }
    validate_value(slot, &slot.master_value)
}

fn validate_value(slot: &Slot, value: &SlotValue) -> Result<(), CreativeError> {
    match (&slot.kind, value) {
        (
            SlotKind::Hook | SlotKind::ProductShot,
            SlotValue::Media {
                asset_id,
                duration_ticks,
            },
        ) => {
            if asset_id.trim().is_empty() {
                return Err(CreativeError::InvalidAssetReference);
            }
            if *duration_ticks != slot.duration_ticks {
                return Err(CreativeError::DurationMismatch);
            }
        }
        (SlotKind::Headline | SlotKind::Cta, SlotValue::Text { text }) => {
            let length = text.chars().count();
            if length == 0 || length > 2_000 {
                return Err(CreativeError::InvalidText);
            }
        }
        (SlotKind::Logo, SlotValue::Logo { asset_id }) => {
            if asset_id.trim().is_empty() {
                return Err(CreativeError::InvalidAssetReference);
            }
        }
        _ => return Err(CreativeError::SlotTypeMismatch),
    }
    if matches!(slot.fit_policy, SlotFitPolicy::ExactDuration)
        && matches!(value, SlotValue::Logo { .. } | SlotValue::Text { .. })
        && slot.duration_ticks != 0
    {
        return Err(CreativeError::DurationMismatch);
    }
    Ok(())
}

fn validate_audit(
    audit: &SlotAuditEvent,
    kind: SlotAuditKind,
    source_slot_id: &str,
    target_slot_id: Option<&str>,
) -> Result<(), CreativeError> {
    if audit.id.trim().is_empty()
        || audit.actor_id.trim().is_empty()
        || audit.occurred_at.trim().is_empty()
        || audit.kind != kind
        || audit.source_slot_id != source_slot_id
        || audit.target_slot_id.as_deref() != target_slot_id
    {
        return Err(CreativeError::InvalidAuditEvent);
    }
    Ok(())
}

fn sorted_unique(values: impl Iterator<Item = String>) -> Vec<String> {
    values.collect::<BTreeSet<_>>().into_iter().collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    use studio_model::{
        CanvasSpec, CreateCampaignInput, DeliveryProfile, SafeArea, Scene, create_campaign,
    };

    fn campaign() -> Campaign {
        let mut state = create_campaign(CreateCampaignInput {
            campaign_id: "campaign".into(),
            campaign_name: "Launch".into(),
            master_sequence_id: "sequence".into(),
            created_at: "2026-08-28T00:00:00Z".into(),
            scenes: vec![Scene {
                id: "scene".into(),
                name: "Scene".into(),
                created_at: "2026-08-28T00:00:00Z".into(),
                updated_at: "2026-08-28T00:00:00Z".into(),
                timeline: None,
            }],
            imported_from: None,
        })
        .unwrap();
        state.campaign.delivery_profiles.push(DeliveryProfile {
            id: "portrait".into(),
            name: "Portrait".into(),
            canvas: CanvasSpec {
                width: 1080,
                height: 1920,
            },
            safe_area: SafeArea {
                top_basis_points: 800,
                right_basis_points: 500,
                bottom_basis_points: 1200,
                left_basis_points: 500,
            },
            locale: "source".into(),
            layout_constraints: vec!["crop-only".into()],
            version: 1,
            locale_profile_id: None,
        });
        state.campaign.variant_cells.push(cell("master"));
        state.campaign
    }

    fn slot(id: &str) -> Slot {
        Slot {
            id: id.into(),
            name: id.into(),
            kind: SlotKind::Hook,
            master_entity_id: format!("entity-{id}"),
            master_value: SlotValue::Media {
                asset_id: format!("master-{id}"),
                duration_ticks: 96_000,
            },
            duration_ticks: 96_000,
            fit_policy: SlotFitPolicy::ExactDuration,
            style_fingerprint: "style-v1".into(),
            version: 1,
        }
    }

    #[test]
    fn binding_rejects_placeholder_substitution_and_invalid_overlay_without_mutation() {
        use studio_model::{MasterRenderBinding, PlacementRect, SlotRenderTarget, TimelineClip};
        let mut c = campaign();
        let mut timeline = studio_model::Timeline {
            duration_ticks: 96000,
            ..Default::default()
        };
        timeline.tracks[0].clips.push(TimelineClip {
            id: "clip".into(),
            asset_id: "actual".into(),
            label: "Original".into(),
            start_ticks: 0,
            duration_ticks: 96000,
            source_offset_ticks: 0,
            source_duration_ticks: 96000,
            has_audio: false,
        });
        c.master_sequence.scenes[0].timeline = Some(timeline);
        c.slots.push(slot("hook"));
        let before = c.clone();
        let binding = MasterRenderBinding {
            slot_id: "hook".into(),
            target: SlotRenderTarget::Clip {
                scene_id: "scene".into(),
                clip_id: "clip".into(),
            },
        };
        assert!(set_slot_binding(&mut c, binding.clone()).is_err());
        assert_eq!(c, before);
        c.slots[0].master_value = SlotValue::Media {
            asset_id: "actual".into(),
            duration_ticks: 96000,
        };
        set_slot_binding(&mut c, binding).unwrap();
        assert!(delete_slot(&mut c, "hook").is_err());
        let mut logo = slot("logo");
        logo.kind = SlotKind::Logo;
        logo.master_value = SlotValue::Logo {
            asset_id: "explicit-logo".into(),
        };
        c.slots.push(logo);
        let invalid = MasterRenderBinding {
            slot_id: "logo".into(),
            target: SlotRenderTarget::Overlay {
                scene_id: "scene".into(),
                start_ticks: 0,
                end_ticks: 96000,
                rect: PlacementRect {
                    x: 9000,
                    y: 0,
                    width: 2000,
                    height: 1000,
                },
                z_index: 0,
                text_style: None,
            },
        };
        let before = c.clone();
        assert!(set_slot_binding(&mut c, invalid).is_err());
        assert_eq!(c, before);
    }

    fn set(id: &str) -> CreativeSet {
        CreativeSet {
            id: id.into(),
            name: id.into(),
            replacements: Vec::new(),
            version: 1,
        }
    }

    fn cell(set_id: &str) -> VariantCell {
        VariantCell {
            id: format!("{set_id}-portrait"),
            creative_set_id: set_id.into(),
            delivery_profile_id: "portrait".into(),
            layout_override: None,
            version: 1,
        }
    }

    fn assignment(set_id: &str, asset_id: &str, duration_ticks: i64) -> SlotAssignment {
        SlotAssignment {
            creative_set_id: set_id.into(),
            slot_id: "hook".into(),
            value: SlotValue::Media {
                asset_id: asset_id.into(),
                duration_ticks,
            },
        }
    }

    #[test]
    fn three_rows_propagate_style_without_copying_master() {
        let mut campaign = campaign();
        create_slots(&mut campaign, vec![slot("hook")]).unwrap();
        create_creative_sets(
            &mut campaign,
            vec![set("a"), set("b"), set("c")],
            vec![cell("a"), cell("b"), cell("c")],
        )
        .unwrap();
        assign_slot_values(
            &mut campaign,
            vec![
                assignment("a", "asset-a", 96_000),
                assignment("b", "asset-b", 96_000),
            ],
        )
        .unwrap();
        let master = campaign.master_sequence.clone();
        assert_eq!(
            update_master_slot_style(&mut campaign, "hook", "style-v2".into())
                .unwrap()
                .len(),
            4
        );
        assert_eq!(campaign.master_sequence, master);
        assert_eq!(
            resolve_slots(&campaign, "a").unwrap()[0].style_fingerprint,
            "style-v2"
        );
        assert_eq!(
            resolve_slots(&campaign, "c").unwrap()[0].value_source,
            "master"
        );
    }

    #[test]
    fn invalid_bulk_assignment_rolls_back_atomically() {
        let mut campaign = campaign();
        create_slots(&mut campaign, vec![slot("hook")]).unwrap();
        create_creative_sets(
            &mut campaign,
            vec![set("a"), set("b")],
            vec![cell("a"), cell("b")],
        )
        .unwrap();
        let before = campaign.clone();
        assert_eq!(
            assign_slot_values(
                &mut campaign,
                vec![
                    assignment("a", "valid", 96_000),
                    assignment("b", "bad", 48_000)
                ],
            ),
            Err(CreativeError::DurationMismatch)
        );
        assert_eq!(campaign, before);
    }

    #[test]
    fn m6_row_only_creation_does_not_materialize_profile_cartesian_product() {
        let mut campaign = campaign();
        for index in 1..3 {
            let mut profile = campaign.delivery_profiles[0].clone();
            profile.id = format!("profile-{index}");
            profile.name = format!("Profile {index}");
            campaign.delivery_profiles.push(profile);
        }
        let existing_cells = campaign.variant_cells.clone();
        let sets: Vec<_> = (0..7).map(|index| set(&format!("set-{index}"))).collect();

        assert_eq!(
            create_creative_sets(&mut campaign, sets, Vec::new()).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(campaign.creative_sets.len(), 7);
        assert_eq!(campaign.variant_cells, existing_cells);
    }

    #[test]
    fn m4_non_empty_bundle_still_requires_complete_profile_coverage() {
        let mut campaign = campaign();
        let mut second = campaign.delivery_profiles[0].clone();
        second.id = "square".into();
        second.name = "Square".into();
        campaign.delivery_profiles.push(second);
        let before = campaign.clone();

        assert_eq!(
            create_creative_sets(&mut campaign, vec![set("a")], vec![cell("a")]),
            Err(CreativeError::InvalidCellCoverage)
        );
        assert_eq!(campaign, before);
    }

    #[test]
    fn fixed_axis_limits_reject_growth_and_type_mismatch() {
        let mut campaign = campaign();
        let sets: Vec<_> = (0..12).map(|index| set(&format!("set-{index}"))).collect();
        let cells: Vec<_> = (0..12).map(|index| cell(&format!("set-{index}"))).collect();
        assert_eq!(
            create_creative_sets(&mut campaign, sets, cells),
            Err(CreativeError::CreativeSetLimit)
        );
        let mut invalid = slot("hook");
        invalid.master_value = SlotValue::Text {
            text: "wrong axis".into(),
        };
        assert_eq!(
            create_slots(&mut campaign, vec![invalid]),
            Err(CreativeError::SlotTypeMismatch)
        );
    }

    #[test]
    fn referenced_delete_requires_audited_remap() {
        let mut campaign = campaign();
        create_slots(&mut campaign, vec![slot("hook"), slot("hook-backup")]).unwrap();
        create_creative_sets(&mut campaign, vec![set("a")], vec![cell("a")]).unwrap();
        assign_slot_values(&mut campaign, vec![assignment("a", "asset-a", 96_000)]).unwrap();
        assert_eq!(
            delete_slot(&mut campaign, "hook"),
            Err(CreativeError::ReferencedSlot("hook".into()))
        );
        remap_and_delete_slot(
            &mut campaign,
            "hook",
            "hook-backup",
            SlotAuditEvent {
                id: "audit".into(),
                kind: SlotAuditKind::Remap,
                source_slot_id: "hook".into(),
                target_slot_id: Some("hook-backup".into()),
                actor_id: "local-user".into(),
                occurred_at: "2026-08-28T01:00:00Z".into(),
            },
        )
        .unwrap();
        assert_eq!(
            campaign.creative_sets[0].replacements[0].slot_id,
            "hook-backup"
        );
        assert_eq!(campaign.slot_audit_events.len(), 1);
    }
}
