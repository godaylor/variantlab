use std::collections::BTreeSet;

use creative_engine::{CreativeError, ResolvedSlot};
use serde::Serialize;
use sha2::{Digest, Sha256};
use studio_model::{BrandKit, SlotKind};
use studio_model::{
    Campaign, CanvasSpec, CropOverride, DeliveryProfile, DirtyTimeRange, MasterSequence, SafeArea,
    StudioState, VariantCell,
};
use thiserror::Error;
use ts_rs::TS;
use validation_engine::{
    MAX_DELIVERY_PROFILES, MAX_VARIANT_CELLS, ValidationError, validate_crop,
    validate_delivery_profile,
};
use validation_engine::{
    MAX_DETACHED_CELLS, MAX_FORMAT_PROFILES, MAX_LOCALE_PROFILES, validate_brand_kit,
};

pub const VARIANT_ENGINE_VERSION: &str = "variantlab-m6-v1";
pub const MASTER_CREATIVE_SET_ID: &str = "master";
pub const MAX_M3_FORMAT_PROFILES: usize = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProvenanceSource {
    Master,
    DeliveryProfile,
    VariantCell,
    CreativeSet,
    BrandKit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct ProvenanceEntry {
    pub field: String,
    pub source: ProvenanceSource,
    pub source_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct VariantDiagnostic {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct ResolvedVariant {
    pub cell_id: String,
    pub creative_set_id: String,
    pub delivery_profile_id: String,
    pub canvas: CanvasSpec,
    pub safe_area: SafeArea,
    pub crop: CropOverride,
    pub fingerprint: String,
    pub provenance: Vec<ProvenanceEntry>,
    pub diagnostics: Vec<VariantDiagnostic>,
    pub dirty_time_ranges: Vec<DirtyTimeRange>,
    pub resolved_slots: Vec<ResolvedSlot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum VariantCellStatus {
    Ready,
    Stale,
    Warning,
    Error,
    Detached,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct VariantProjectionDiagnostic {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub action: String,
    pub rule_id: String,
    pub rule_source: String,
    pub rule_revision: String,
    pub affected_slot_id: Option<String>,
    pub affected_cell_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct VariantProjectionItem {
    pub cell_id: String,
    pub creative_set_id: String,
    pub delivery_profile_id: String,
    pub status: VariantCellStatus,
    pub diagnostics: Vec<VariantProjectionDiagnostic>,
    pub provenance: Vec<ProvenanceEntry>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct VariantProjectionPage {
    pub items: Vec<VariantProjectionItem>,
    pub total: u32,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThumbnailQuality {
    Full,
    Thumbnail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct ScheduledThumbnail {
    pub cell_id: String,
    pub priority: u8,
    pub quality: ThumbnailQuality,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct ThumbnailSchedule {
    pub queued: Vec<ScheduledThumbnail>,
    pub cancelled_cell_ids: Vec<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum VariantError {
    #[error("M3 supports one explicitly created format profile")]
    M3ProfileLimit,
    #[error("legacy M3 CreateDeliveryProfile accepts a 9:16 canvas only")]
    M3UnsupportedCanvas,
    #[error("delivery profile limit of {MAX_DELIVERY_PROFILES} reached")]
    DeliveryProfileLimit,
    #[error("variant cell limit of {MAX_VARIANT_CELLS} reached")]
    VariantCellLimit,
    #[error("delivery profile {0} already exists")]
    DuplicateProfileId(String),
    #[error("variant cell {0} already exists")]
    DuplicateCellId(String),
    #[error("format profile limit of {MAX_FORMAT_PROFILES} reached")]
    FormatProfileLimit,
    #[error("locale profile limit of {MAX_LOCALE_PROFILES} reached")]
    LocaleProfileLimit,
    #[error("detached cell limit of {MAX_DETACHED_CELLS} reached")]
    DetachedCellLimit,
    #[error("variant cell key (creative set, delivery profile) must be unique")]
    DuplicateCellKey,
    #[error("delivery profile {0} was not found")]
    ProfileNotFound(String),
    #[error("variant cell {0} was not found")]
    CellNotFound(String),
    #[error("cell ID must not be empty")]
    EmptyCellId,
    #[error("variant validation failed: {0}")]
    Validation(#[from] ValidationError),
    #[error("variant fingerprint serialization failed: {0}")]
    Serialization(String),
    #[error("creative set {0} was not found")]
    CreativeSetNotFound(String),
    #[error("locale profile {0} was not found")]
    LocaleProfileNotFound(String),
    #[error("brand kit fingerprint does not match its canonical declarative rules")]
    BrandKitFingerprintMismatch,
    #[error("projection page_size must be between 1 and 100")]
    InvalidPageSize,
    #[error("thumbnail schedule accepts at most 80 unique visible cells")]
    TooManyVisibleCells,
    #[error("thumbnail schedule max_jobs must be greater than zero")]
    InvalidThumbnailMaxJobs,
    #[error("creative resolution failed: {0}")]
    Creative(#[from] CreativeError),
}

pub fn create_delivery_profile(
    campaign: &mut Campaign,
    profile: DeliveryProfile,
    cell_id: String,
) -> Result<VariantCell, VariantError> {
    validate_delivery_profile(&profile)?;
    if u64::from(profile.canvas.width) * 16 != u64::from(profile.canvas.height) * 9 {
        return Err(VariantError::M3UnsupportedCanvas);
    }
    if campaign.delivery_profiles.len() >= MAX_M3_FORMAT_PROFILES {
        return Err(VariantError::M3ProfileLimit);
    }
    if campaign.delivery_profiles.len() >= MAX_DELIVERY_PROFILES {
        return Err(VariantError::DeliveryProfileLimit);
    }
    if campaign.variant_cells.len() >= MAX_VARIANT_CELLS {
        return Err(VariantError::VariantCellLimit);
    }
    if cell_id.trim().is_empty() {
        return Err(VariantError::EmptyCellId);
    }
    if campaign
        .delivery_profiles
        .iter()
        .any(|candidate| candidate.id == profile.id)
    {
        return Err(VariantError::DuplicateProfileId(profile.id));
    }
    if campaign
        .variant_cells
        .iter()
        .any(|candidate| candidate.id == cell_id)
    {
        return Err(VariantError::DuplicateCellId(cell_id));
    }
    if campaign.variant_cells.iter().any(|candidate| {
        candidate.creative_set_id == MASTER_CREATIVE_SET_ID
            && candidate.delivery_profile_id == profile.id
    }) {
        return Err(VariantError::DuplicateCellKey);
    }

    let cell = VariantCell {
        id: cell_id,
        creative_set_id: MASTER_CREATIVE_SET_ID.to_owned(),
        delivery_profile_id: profile.id.clone(),
        layout_override: None,
        version: 1,
    };
    campaign.delivery_profiles.push(profile);
    campaign
        .delivery_profiles
        .sort_by(|left, right| left.id.cmp(&right.id));
    campaign.variant_cells.push(cell.clone());
    campaign
        .variant_cells
        .sort_by(|left, right| left.id.cmp(&right.id));
    Ok(cell)
}

pub fn add_delivery_profiles(
    campaign: &mut Campaign,
    profiles: Vec<DeliveryProfile>,
) -> Result<Vec<String>, VariantError> {
    let mut next = campaign.clone();
    let mut input_ids = BTreeSet::new();
    for profile in profiles {
        validate_delivery_profile(&profile)?;
        validate_profile_references(&next, &profile)?;
        if !input_ids.insert(profile.id.clone()) {
            return Err(VariantError::DuplicateProfileId(profile.id));
        }
        if let Some(existing) = next
            .delivery_profiles
            .iter_mut()
            .find(|candidate| candidate.id == profile.id)
        {
            *existing = profile;
        } else {
            next.delivery_profiles.push(profile);
        }
    }
    validate_profile_limits(&next.delivery_profiles)?;
    next.delivery_profiles
        .sort_by(|left, right| left.id.cmp(&right.id));
    let ids = input_ids.into_iter().collect();
    campaign.delivery_profiles = next.delivery_profiles;
    Ok(ids)
}

pub fn enable_variant_cells(
    campaign: &mut Campaign,
    cells: Vec<VariantCell>,
) -> Result<Vec<String>, VariantError> {
    let mut next = campaign.clone();
    let mut input_ids = BTreeSet::new();
    for cell in cells {
        validate_cell_reference(&next, &cell)?;
        if !input_ids.insert(cell.id.clone()) {
            return Err(VariantError::DuplicateCellId(cell.id));
        }
        if let Some(existing_index) = next
            .variant_cells
            .iter()
            .position(|candidate| candidate.id == cell.id)
        {
            next.variant_cells.remove(existing_index);
        }
        if next.variant_cells.iter().any(|candidate| {
            candidate.creative_set_id == cell.creative_set_id
                && candidate.delivery_profile_id == cell.delivery_profile_id
        }) {
            return Err(VariantError::DuplicateCellKey);
        }
        next.variant_cells.push(cell);
    }
    validate_cell_limits(&next.variant_cells)?;
    next.variant_cells
        .sort_by(|left, right| left.id.cmp(&right.id));
    let ids = input_ids.into_iter().collect();
    campaign.variant_cells = next.variant_cells;
    Ok(ids)
}

pub fn detach_variant_cells(
    campaign: &mut Campaign,
    cell_ids: &[String],
) -> Result<Vec<String>, VariantError> {
    let mut next = campaign.clone();
    let unique: BTreeSet<&str> = cell_ids.iter().map(String::as_str).collect();
    if unique.len() != cell_ids.len() {
        return Err(VariantError::DuplicateCellId(
            cell_ids.first().cloned().unwrap_or_default(),
        ));
    }
    for cell_id in &unique {
        let cell = next
            .variant_cells
            .iter_mut()
            .find(|candidate| candidate.id == *cell_id)
            .ok_or_else(|| VariantError::CellNotFound((*cell_id).to_owned()))?;
        if cell.layout_override.is_none() {
            cell.layout_override = Some(CropOverride::default());
            cell.version = cell.version.saturating_add(1);
        }
    }
    validate_cell_limits(&next.variant_cells)?;
    next.variant_cells
        .sort_by(|left, right| left.id.cmp(&right.id));
    let ids = unique.into_iter().map(str::to_owned).collect();
    campaign.variant_cells = next.variant_cells;
    Ok(ids)
}

pub fn set_brand_kit(
    campaign: &mut Campaign,
    mut brand_kit: BrandKit,
) -> Result<BrandKit, VariantError> {
    validate_brand_kit(&brand_kit)?;
    let expected = brand_kit_fingerprint(&brand_kit)?;
    if !brand_kit.fingerprint.is_empty() && brand_kit.fingerprint != expected {
        return Err(VariantError::BrandKitFingerprintMismatch);
    }
    brand_kit.allowed_color_tokens.sort();
    brand_kit.allowed_font_ids.sort();
    brand_kit
        .custom_safe_regions
        .sort_by(|left, right| left.id.cmp(&right.id));
    brand_kit.fingerprint = brand_kit_fingerprint(&brand_kit)?;
    campaign.brand_kit = Some(brand_kit.clone());
    Ok(brand_kit)
}

pub fn brand_kit_fingerprint(brand_kit: &BrandKit) -> Result<String, VariantError> {
    let mut canonical = brand_kit.clone();
    canonical.fingerprint.clear();
    canonical.allowed_color_tokens.sort();
    canonical.allowed_font_ids.sort();
    canonical
        .custom_safe_regions
        .sort_by(|left, right| left.id.cmp(&right.id));
    sha256_json(&canonical)
}
pub fn set_crop(
    campaign: &mut Campaign,
    cell_id: &str,
    crop: Option<CropOverride>,
) -> Result<(VariantCell, VariantCell), VariantError> {
    if let Some(crop) = crop {
        validate_crop(&crop)?;
    }
    let mut next = campaign.clone();
    let cell = next
        .variant_cells
        .iter_mut()
        .find(|candidate| candidate.id == cell_id)
        .ok_or_else(|| VariantError::CellNotFound(cell_id.to_owned()))?;
    let previous = cell.clone();
    cell.layout_override = crop;
    cell.version = cell.version.saturating_add(1);
    let updated = cell.clone();
    validate_cell_limits(&next.variant_cells)?;
    campaign.variant_cells = next.variant_cells;
    Ok((previous, updated))
}

pub fn resolve(state: &StudioState, cell_id: &str) -> Result<ResolvedVariant, VariantError> {
    let cell = state
        .campaign
        .variant_cells
        .iter()
        .find(|candidate| candidate.id == cell_id)
        .ok_or_else(|| VariantError::CellNotFound(cell_id.to_owned()))?;
    let mut profile = state
        .campaign
        .delivery_profiles
        .iter()
        .find(|candidate| candidate.id == cell.delivery_profile_id)
        .cloned()
        .ok_or_else(|| VariantError::ProfileNotFound(cell.delivery_profile_id.clone()))?;
    validate_delivery_profile(&profile)?;
    let crop = cell.layout_override.unwrap_or_default();
    validate_crop(&crop)?;
    profile.layout_constraints.sort();
    let resolved_slots = creative_engine::resolve_slots(&state.campaign, &cell.creative_set_id)?;
    let fingerprint = fingerprint(
        state.campaign.revision,
        &state.campaign.master_sequence,
        &profile,
        cell,
        &resolved_slots,
        state.campaign.brand_kit.as_ref(),
    )?;
    let diagnostics = if crop.x_basis_points.unsigned_abs() > 7_500
        || crop.y_basis_points.unsigned_abs() > 7_500
    {
        vec![VariantDiagnostic {
            code: "safe_area_crop_risk".into(),
            severity: DiagnosticSeverity::Warning,
            message: "The crop is near the edge of the allowlisted safe geometry.".into(),
            action: "Nudge toward center or reset to master.".into(),
        }]
    } else {
        Vec::new()
    };
    let source = if cell.layout_override.is_some() {
        ProvenanceSource::VariantCell
    } else {
        ProvenanceSource::Master
    };
    let mut provenance = vec![
        ProvenanceEntry {
            field: "timeline".into(),
            source: ProvenanceSource::Master,
            source_id: state.campaign.master_sequence.id.clone(),
        },
        ProvenanceEntry {
            field: "canvas_safe_area".into(),
            source: ProvenanceSource::DeliveryProfile,
            source_id: profile.id.clone(),
        },
        ProvenanceEntry {
            field: "crop".into(),
            source,
            source_id: if cell.layout_override.is_some() {
                cell.id.clone()
            } else {
                state.campaign.master_sequence.id.clone()
            },
        },
    ];
    if let Some(kit) = &state.campaign.brand_kit {
        provenance.push(ProvenanceEntry {
            field: "brand_rules".into(),
            source: ProvenanceSource::BrandKit,
            source_id: format!("{}@{}", kit.id, kit.version),
        });
    }
    provenance.extend(resolved_slots.iter().map(|slot| ProvenanceEntry {
        field: format!("slot:{}", slot.slot_id),
        source: if slot.value_source == "creative_set" {
            ProvenanceSource::CreativeSet
        } else {
            ProvenanceSource::Master
        },
        source_id: slot.value_source_id.clone(),
    }));
    Ok(ResolvedVariant {
        cell_id: cell.id.clone(),
        creative_set_id: cell.creative_set_id.clone(),
        delivery_profile_id: profile.id.clone(),
        canvas: profile.canvas,
        safe_area: profile.safe_area,
        crop,
        fingerprint,
        provenance,
        diagnostics,
        resolved_slots,
        dirty_time_ranges: master_dirty_ranges(&state.campaign.master_sequence),
    })
}

pub fn thumbnail_schedule(
    visible_cell_ids: &[String],
    focused_cell_id: Option<&str>,
    prior_active_ids: &[String],
    max_jobs: u32,
) -> Result<ThumbnailSchedule, VariantError> {
    if max_jobs == 0 {
        return Err(VariantError::InvalidThumbnailMaxJobs);
    }
    let visible: BTreeSet<&str> = visible_cell_ids
        .iter()
        .filter(|cell_id| !cell_id.trim().is_empty())
        .map(String::as_str)
        .collect();
    if visible.len() != visible_cell_ids.len() || visible.len() > 80 {
        return Err(VariantError::TooManyVisibleCells);
    }
    let focused = focused_cell_id.filter(|cell_id| visible.contains(*cell_id));
    let mut queued = Vec::new();
    if let Some(cell_id) = focused {
        queued.push(ScheduledThumbnail {
            cell_id: cell_id.to_owned(),
            priority: 100,
            quality: ThumbnailQuality::Full,
        });
    }
    for cell_id in &visible {
        if Some(*cell_id) == focused || queued.len() >= max_jobs as usize {
            continue;
        }
        queued.push(ScheduledThumbnail {
            cell_id: (*cell_id).to_owned(),
            priority: 50,
            quality: ThumbnailQuality::Thumbnail,
        });
    }
    let queued_ids: BTreeSet<&str> = queued.iter().map(|item| item.cell_id.as_str()).collect();
    let cancelled_cell_ids: Vec<String> = prior_active_ids
        .iter()
        .filter(|cell_id| !queued_ids.contains(cell_id.as_str()))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(ThumbnailSchedule {
        queued,
        cancelled_cell_ids,
    })
}
pub fn projection_page(
    state: &StudioState,
    page: u32,
    page_size: u32,
) -> Result<VariantProjectionPage, VariantError> {
    if !(1..=100).contains(&page_size) {
        return Err(VariantError::InvalidPageSize);
    }
    let mut cells: Vec<&VariantCell> = state.campaign.variant_cells.iter().collect();
    cells.sort_by(|left, right| {
        left.creative_set_id
            .cmp(&right.creative_set_id)
            .then_with(|| left.delivery_profile_id.cmp(&right.delivery_profile_id))
            .then_with(|| left.id.cmp(&right.id))
    });
    let total = u32::try_from(cells.len()).unwrap_or(u32::MAX);
    let start = usize::try_from(page.saturating_mul(page_size)).unwrap_or(usize::MAX);
    let items = cells
        .into_iter()
        .skip(start)
        .take(page_size as usize)
        .map(|cell| {
            let resolved = resolve(state, &cell.id)?;
            let profile = state
                .campaign
                .delivery_profiles
                .iter()
                .find(|candidate| candidate.id == cell.delivery_profile_id)
                .ok_or_else(|| VariantError::ProfileNotFound(cell.delivery_profile_id.clone()))?;
            let diagnostics = collect_diagnostics(
                state,
                cell,
                profile,
                &resolved.resolved_slots,
                resolved.crop,
            );
            let required_revision = state
                .campaign
                .brand_kit
                .as_ref()
                .map_or(profile.version, |kit| profile.version.max(kit.version));
            let status = if diagnostics
                .iter()
                .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
            {
                VariantCellStatus::Error
            } else if diagnostics
                .iter()
                .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Warning)
            {
                VariantCellStatus::Warning
            } else if cell.layout_override.is_some() {
                VariantCellStatus::Detached
            } else if cell.version < required_revision {
                VariantCellStatus::Stale
            } else {
                VariantCellStatus::Ready
            };
            Ok(VariantProjectionItem {
                cell_id: cell.id.clone(),
                creative_set_id: cell.creative_set_id.clone(),
                delivery_profile_id: cell.delivery_profile_id.clone(),
                status,
                diagnostics,
                provenance: resolved.provenance,
                fingerprint: resolved.fingerprint,
            })
        })
        .collect::<Result<Vec<_>, VariantError>>()?;
    Ok(VariantProjectionPage {
        items,
        total,
        page,
        page_size,
    })
}

fn collect_diagnostics(
    state: &StudioState,
    cell: &VariantCell,
    profile: &DeliveryProfile,
    resolved_slots: &[ResolvedSlot],
    crop: CropOverride,
) -> Vec<VariantProjectionDiagnostic> {
    let mut diagnostics = Vec::new();
    if crop.x_basis_points.unsigned_abs() > 7_500 || crop.y_basis_points.unsigned_abs() > 7_500 {
        diagnostics.push(projection_diagnostic(
            cell,
            "engine.safe_area_crop_risk",
            DiagnosticSeverity::Warning,
            "The crop is near the edge of the allowlisted safe geometry.",
            "Nudge toward center or reset to master.",
            None,
            (VARIANT_ENGINE_VERSION, VARIANT_ENGINE_VERSION),
        ));
    }
    let Some(kit) = &state.campaign.brand_kit else {
        return diagnostics;
    };
    let source = kit.provenance.source.as_str();
    let revision = format!("{}@{}", kit.version, kit.provenance.revision);
    let text_slot = state
        .campaign
        .slots
        .iter()
        .find(|slot| matches!(slot.kind, SlotKind::Headline | SlotKind::Cta))
        .map(|slot| slot.id.clone());
    if kit.logo_required {
        let has_logo = state.campaign.slots.iter().any(|slot| {
            slot.kind == SlotKind::Logo
                && resolved_slots
                    .iter()
                    .any(|resolved| resolved.slot_id == slot.id)
        });
        if !has_logo {
            diagnostics.push(brand_diagnostic(
                cell,
                "brand.logo_required",
                "A required brand logo slot is missing.",
                "Create a typed logo slot or assign its explicit CreativeSet replacement.",
                None,
                source,
                &revision,
            ));
        }
    }
    let text_size = layout_value(&profile.layout_constraints, "text_size_px:")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    if text_size < kit.minimum_text_size_px {
        diagnostics.push(brand_diagnostic(
            cell,
            "brand.minimum_text_size",
            &format!(
                "Text size {text_size}px is below the {}px BrandKit minimum.",
                kit.minimum_text_size_px
            ),
            &format!(
                "Set DeliveryProfile layout constraint text_size_px:{}.",
                kit.minimum_text_size_px
            ),
            text_slot.clone(),
            source,
            &revision,
        ));
    }
    if kit.custom_safe_regions.iter().any(|region| {
        profile.safe_area.top_basis_points < region.safe_area.top_basis_points
            || profile.safe_area.right_basis_points < region.safe_area.right_basis_points
            || profile.safe_area.bottom_basis_points < region.safe_area.bottom_basis_points
            || profile.safe_area.left_basis_points < region.safe_area.left_basis_points
    }) {
        diagnostics.push(brand_diagnostic(
            cell,
            "brand.safe_region",
            "DeliveryProfile safe area does not contain the BrandKit custom safe region.",
            "Increase the profile safe-area insets to the named BrandKit region.",
            text_slot.clone(),
            source,
            &revision,
        ));
    }
    if !kit.allowed_font_ids.is_empty() {
        let font = layout_value(&profile.layout_constraints, "font:");
        if font.is_none_or(|value| !kit.allowed_font_ids.iter().any(|allowed| allowed == value)) {
            diagnostics.push(brand_diagnostic(
                cell,
                "brand.font_token",
                "DeliveryProfile font is not in the BrandKit allowlist.",
                "Choose an allowed font token in the DeliveryProfile.",
                text_slot.clone(),
                source,
                &revision,
            ));
        }
    }
    if !kit.allowed_color_tokens.is_empty() {
        let color = layout_value(&profile.layout_constraints, "color:");
        if color.is_none_or(|value| {
            !kit.allowed_color_tokens
                .iter()
                .any(|allowed| allowed == value)
        }) {
            diagnostics.push(brand_diagnostic(
                cell,
                "brand.color_token",
                "DeliveryProfile color is not in the BrandKit allowlist.",
                "Choose an allowed color token in the DeliveryProfile.",
                text_slot,
                source,
                &revision,
            ));
        }
    }
    if let Some(rule) = &kit.master_duration {
        let duration: i64 = state
            .campaign
            .master_sequence
            .scenes
            .iter()
            .filter_map(|scene| scene.timeline.as_ref())
            .map(|timeline| timeline.duration_ticks)
            .sum();
        if duration < rule.minimum_ticks || duration > rule.maximum_ticks {
            diagnostics.push(brand_diagnostic(
                cell,
                "brand.master_duration",
                "MasterSequence duration is outside the BrandKit rule.",
                "Edit MasterSequence timing; profile and cell overrides cannot change it.",
                None,
                source,
                &revision,
            ));
        }
    }
    diagnostics.sort_by(|left, right| left.rule_id.cmp(&right.rule_id));
    diagnostics
}

fn brand_diagnostic(
    cell: &VariantCell,
    rule_id: &str,
    message: &str,
    action: &str,
    affected_slot_id: Option<String>,
    source: &str,
    revision: &str,
) -> VariantProjectionDiagnostic {
    projection_diagnostic(
        cell,
        rule_id,
        DiagnosticSeverity::Error,
        message,
        action,
        affected_slot_id,
        (source, revision),
    )
}

fn projection_diagnostic(
    cell: &VariantCell,
    rule_id: &str,
    severity: DiagnosticSeverity,
    message: &str,
    action: &str,
    affected_slot_id: Option<String>,
    rule_origin: (&str, &str),
) -> VariantProjectionDiagnostic {
    VariantProjectionDiagnostic {
        code: rule_id.replace('.', "_"),
        severity,
        message: message.into(),
        action: action.into(),
        rule_id: rule_id.into(),
        rule_source: rule_origin.0.into(),
        rule_revision: rule_origin.1.into(),
        affected_slot_id,
        affected_cell_id: cell.id.clone(),
    }
}

fn layout_value<'a>(constraints: &'a [String], prefix: &str) -> Option<&'a str> {
    constraints
        .iter()
        .find_map(|constraint| constraint.strip_prefix(prefix))
}

fn validate_profile_limits(profiles: &[DeliveryProfile]) -> Result<(), VariantError> {
    if profiles.len() > MAX_DELIVERY_PROFILES {
        return Err(VariantError::DeliveryProfileLimit);
    }
    let formats: BTreeSet<(u32, u32)> = profiles
        .iter()
        .map(|profile| (profile.canvas.width, profile.canvas.height))
        .collect();
    if formats.len() > MAX_FORMAT_PROFILES {
        return Err(VariantError::FormatProfileLimit);
    }
    let locales: BTreeSet<&str> = profiles
        .iter()
        .map(|profile| {
            profile
                .locale_profile_id
                .as_deref()
                .unwrap_or(profile.locale.as_str())
        })
        .collect();
    if locales.len() > MAX_LOCALE_PROFILES {
        return Err(VariantError::LocaleProfileLimit);
    }
    Ok(())
}

fn validate_profile_references(
    campaign: &Campaign,
    profile: &DeliveryProfile,
) -> Result<(), VariantError> {
    if let Some(locale_profile_id) = &profile.locale_profile_id
        && !campaign
            .locale_profiles
            .iter()
            .any(|locale| locale.id == *locale_profile_id)
    {
        return Err(VariantError::LocaleProfileNotFound(
            locale_profile_id.clone(),
        ));
    }
    Ok(())
}

fn validate_cell_reference(campaign: &Campaign, cell: &VariantCell) -> Result<(), VariantError> {
    if cell.id.trim().is_empty() {
        return Err(VariantError::EmptyCellId);
    }
    if !campaign
        .delivery_profiles
        .iter()
        .any(|profile| profile.id == cell.delivery_profile_id)
    {
        return Err(VariantError::ProfileNotFound(
            cell.delivery_profile_id.clone(),
        ));
    }
    if cell.creative_set_id != MASTER_CREATIVE_SET_ID
        && !campaign
            .creative_sets
            .iter()
            .any(|set| set.id == cell.creative_set_id)
    {
        return Err(VariantError::CreativeSetNotFound(
            cell.creative_set_id.clone(),
        ));
    }
    if let Some(crop) = cell.layout_override {
        validate_crop(&crop)?;
    }
    Ok(())
}

fn validate_cell_limits(cells: &[VariantCell]) -> Result<(), VariantError> {
    if cells.len() > MAX_VARIANT_CELLS {
        return Err(VariantError::VariantCellLimit);
    }
    if cells
        .iter()
        .filter(|cell| cell.layout_override.is_some())
        .count()
        > MAX_DETACHED_CELLS
    {
        return Err(VariantError::DetachedCellLimit);
    }
    let mut ids = BTreeSet::new();
    let mut keys = BTreeSet::new();
    for cell in cells {
        if !ids.insert(cell.id.as_str()) {
            return Err(VariantError::DuplicateCellId(cell.id.clone()));
        }
        if !keys.insert((
            cell.creative_set_id.as_str(),
            cell.delivery_profile_id.as_str(),
        )) {
            return Err(VariantError::DuplicateCellKey);
        }
    }
    Ok(())
}
#[derive(Serialize)]
struct FingerprintInput<'a> {
    engine_version: &'static str,
    campaign_revision: u32,
    master_sequence: &'a MasterSequence,
    profile: &'a DeliveryProfile,
    cell: &'a VariantCell,
    resolved_slots: &'a [ResolvedSlot],
    brand_kit: Option<&'a BrandKit>,
}

fn fingerprint(
    campaign_revision: u32,
    master_sequence: &MasterSequence,
    profile: &DeliveryProfile,
    cell: &VariantCell,
    resolved_slots: &[ResolvedSlot],
    brand_kit: Option<&BrandKit>,
) -> Result<String, VariantError> {
    let canonical = serde_json::to_string(&FingerprintInput {
        engine_version: VARIANT_ENGINE_VERSION,
        campaign_revision,
        master_sequence,
        profile,
        cell,
        resolved_slots,
        brand_kit,
    })
    .map_err(|error| VariantError::Serialization(error.to_string()))?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn sha256_json(value: &impl Serialize) -> Result<String, VariantError> {
    let canonical = serde_json::to_string(value)
        .map_err(|error| VariantError::Serialization(error.to_string()))?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn master_dirty_ranges(sequence: &MasterSequence) -> Vec<DirtyTimeRange> {
    sequence
        .scenes
        .iter()
        .filter_map(|scene| {
            scene.timeline.as_ref().map(|timeline| DirtyTimeRange {
                scene_id: scene.id.clone(),
                start_ticks: 0,
                end_ticks: timeline.duration_ticks,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_model::{
        BrandKit, BrandKitProvenance, BrandSafeRegion, CanvasSpec, CreateCampaignInput,
        MasterDurationRule, SafeArea, Scene, create_campaign, snapshot_hash,
    };

    fn state() -> StudioState {
        create_campaign(CreateCampaignInput {
            campaign_id: "campaign-1".into(),
            campaign_name: "Launch".into(),
            master_sequence_id: "sequence-1".into(),
            created_at: "2026-08-28T00:00:00Z".into(),
            scenes: vec![Scene {
                id: "scene-1".into(),
                name: "Master".into(),
                created_at: "2026-08-28T00:00:00Z".into(),
                updated_at: "2026-08-28T00:00:00Z".into(),
                timeline: Some(Default::default()),
            }],
            imported_from: None,
        })
        .unwrap()
    }

    fn profile() -> DeliveryProfile {
        DeliveryProfile {
            id: "profile-vertical".into(),
            name: "9:16 social".into(),
            canvas: CanvasSpec {
                width: 1080,
                height: 1920,
            },
            safe_area: SafeArea {
                top_basis_points: 800,
                right_basis_points: 600,
                bottom_basis_points: 1400,
                left_basis_points: 600,
            },
            locale: "en".into(),
            layout_constraints: vec!["safe_area".into(), "cover".into()],
            version: 1,
            locale_profile_id: None,
        }
    }

    #[test]
    fn profile_cannot_deserialize_timing_fps_or_audio_fields() {
        let json = serde_json::json!({
            "id": "vertical",
            "name": "9:16",
            "canvas": {"width": 1080, "height": 1920},
            "safe_area": {
                "top_basis_points": 800,
                "right_basis_points": 600,
                "bottom_basis_points": 1400,
                "left_basis_points": 600
            },
            "locale": "en",
            "layout_constraints": [],
            "version": 1,
            "fps": 60,
            "audio_mix": "variant"
        });
        assert!(serde_json::from_value::<DeliveryProfile>(json).is_err());
    }

    #[test]
    fn inheritance_override_and_fingerprint_are_deterministic() {
        let mut state = state();
        let cell = create_delivery_profile(
            &mut state.campaign,
            profile(),
            "cell-master-vertical".into(),
        )
        .unwrap();
        let inherited = resolve(&state, &cell.id).unwrap();
        assert_eq!(inherited.crop, CropOverride::default());
        assert!(matches!(
            inherited.provenance[2].source,
            ProvenanceSource::Master
        ));
        let serialized = serde_json::to_string(&state).unwrap();
        let restored: StudioState = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            inherited.fingerprint,
            resolve(&restored, &cell.id).unwrap().fingerprint
        );
        assert_eq!(
            snapshot_hash(&state).unwrap(),
            snapshot_hash(&restored).unwrap()
        );

        set_crop(
            &mut state.campaign,
            &cell.id,
            Some(CropOverride {
                x_basis_points: 1_200,
                y_basis_points: -300,
                scale_basis_points: 11_000,
            }),
        )
        .unwrap();
        let overridden = resolve(&state, &cell.id).unwrap();
        assert_ne!(inherited.fingerprint, overridden.fingerprint);
        assert!(matches!(
            overridden.provenance[2].source,
            ProvenanceSource::VariantCell
        ));
    }

    #[test]
    fn rejects_duplicate_cell_key_and_second_m3_profile() {
        let mut current = state();
        create_delivery_profile(
            &mut current.campaign,
            profile(),
            "cell-master-vertical".into(),
        )
        .unwrap();
        let mut second = profile();
        second.id = "profile-second".into();
        assert_eq!(
            create_delivery_profile(&mut current.campaign, second, "cell-second".into()),
            Err(VariantError::M3ProfileLimit)
        );
        let mut fresh = state();
        let mut landscape = profile();
        landscape.id = "legacy-landscape".into();
        landscape.canvas = CanvasSpec {
            width: 1920,
            height: 1080,
        };
        assert_eq!(
            create_delivery_profile(
                &mut fresh.campaign,
                landscape,
                "legacy-landscape-cell".into(),
            ),
            Err(VariantError::M3UnsupportedCanvas)
        );
    }

    #[test]
    fn explicit_profiles_never_materialize_cartesian_cells() {
        let mut state = state();
        let mut square = profile();
        square.id = "profile-square".into();
        square.canvas = CanvasSpec {
            width: 1080,
            height: 1080,
        };
        add_delivery_profiles(&mut state.campaign, vec![profile(), square]).unwrap();
        assert_eq!(state.campaign.delivery_profiles.len(), 2);
        assert!(state.campaign.variant_cells.is_empty());
        enable_variant_cells(
            &mut state.campaign,
            vec![VariantCell {
                id: "explicit-cell".into(),
                creative_set_id: MASTER_CREATIVE_SET_ID.into(),
                delivery_profile_id: "profile-square".into(),
                layout_override: None,
                version: 1,
            }],
        )
        .unwrap();
        assert_eq!(state.campaign.variant_cells.len(), 1);
    }

    #[test]
    fn one_hundred_cell_limit_and_bulk_failure_are_atomic() {
        let mut state = state();
        let profiles: Vec<_> = (0..9)
            .map(|index| {
                let mut candidate = profile();
                candidate.id = format!("profile-{index:02}");
                candidate.name = candidate.id.clone();
                candidate.canvas = match index % 3 {
                    0 => CanvasSpec {
                        width: 1920,
                        height: 1080,
                    },
                    1 => CanvasSpec {
                        width: 1080,
                        height: 1080,
                    },
                    _ => CanvasSpec {
                        width: 1080,
                        height: 1920,
                    },
                };
                candidate
            })
            .collect();
        add_delivery_profiles(&mut state.campaign, profiles).unwrap();
        state.campaign.creative_sets = (0..11)
            .map(|index| studio_model::CreativeSet {
                id: format!("set-{index:02}"),
                name: format!("Set {index}"),
                replacements: Vec::new(),
                version: 1,
            })
            .collect();
        let rows: Vec<_> = std::iter::once(MASTER_CREATIVE_SET_ID.to_owned())
            .chain((0..11).map(|index| format!("set-{index:02}")))
            .collect();
        let all_cells: Vec<_> = rows
            .iter()
            .flat_map(|row| {
                (0..9).map(move |column| VariantCell {
                    id: format!("cell-{row}-{column:02}"),
                    creative_set_id: row.clone(),
                    delivery_profile_id: format!("profile-{column:02}"),
                    layout_override: None,
                    version: 1,
                })
            })
            .collect();
        let before = state.campaign.clone();
        assert_eq!(
            enable_variant_cells(&mut state.campaign, all_cells[..101].to_vec()),
            Err(VariantError::VariantCellLimit)
        );
        assert_eq!(state.campaign, before);
        enable_variant_cells(&mut state.campaign, all_cells[..100].to_vec()).unwrap();
        assert_eq!(state.campaign.variant_cells.len(), 100);
        assert_eq!(projection_page(&state, 0, 80).unwrap().items.len(), 80);
        assert_eq!(projection_page(&state, 1, 80).unwrap().items.len(), 20);
    }

    #[test]
    fn twenty_detached_limit_is_atomic() {
        let mut state = state();
        let mut vertical = profile();
        vertical.id = "profile-0".into();
        let mut square = profile();
        square.id = "profile-1".into();
        square.canvas = CanvasSpec {
            width: 1080,
            height: 1080,
        };
        let mut landscape = profile();
        landscape.id = "profile-2".into();
        landscape.canvas = CanvasSpec {
            width: 1920,
            height: 1080,
        };
        add_delivery_profiles(&mut state.campaign, vec![vertical, square, landscape]).unwrap();
        state.campaign.creative_sets = (0..7)
            .map(|index| studio_model::CreativeSet {
                id: format!("set-{index:02}"),
                name: format!("Set {index}"),
                replacements: Vec::new(),
                version: 1,
            })
            .collect();
        enable_variant_cells(
            &mut state.campaign,
            (0..21)
                .map(|index| VariantCell {
                    id: format!("cell-{index:02}"),
                    creative_set_id: format!("set-{:02}", index % 7),
                    delivery_profile_id: format!("profile-{}", index % 3),
                    layout_override: None,
                    version: 1,
                })
                .collect(),
        )
        .unwrap();
        detach_variant_cells(
            &mut state.campaign,
            &(0..20)
                .map(|index| format!("cell-{index:02}"))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let before = state.campaign.variant_cells.clone();
        assert_eq!(
            detach_variant_cells(&mut state.campaign, &["cell-20".into()]),
            Err(VariantError::DetachedCellLimit)
        );
        assert_eq!(state.campaign.variant_cells, before);
    }

    #[test]
    fn brand_diagnostics_include_rule_source_revision_cell_and_fix() {
        let mut state = state();
        add_delivery_profiles(&mut state.campaign, vec![profile()]).unwrap();
        enable_variant_cells(
            &mut state.campaign,
            vec![VariantCell {
                id: "cell-brand".into(),
                creative_set_id: MASTER_CREATIVE_SET_ID.into(),
                delivery_profile_id: "profile-vertical".into(),
                layout_override: None,
                version: 1,
            }],
        )
        .unwrap();
        let kit = BrandKit {
            id: "kit-launch".into(),
            name: "Launch".into(),
            version: 1,
            fingerprint: String::new(),
            provenance: BrandKitProvenance {
                source: "brand-ops".into(),
                revision: "revision-7".into(),
                asset_hash: "a".repeat(64),
            },
            logo_required: true,
            allowed_color_tokens: Vec::new(),
            allowed_font_ids: Vec::new(),
            minimum_text_size_px: 24,
            custom_safe_regions: vec![BrandSafeRegion {
                id: "controls".into(),
                safe_area: SafeArea {
                    top_basis_points: 1_000,
                    right_basis_points: 800,
                    bottom_basis_points: 1_600,
                    left_basis_points: 800,
                },
            }],
            master_duration: Some(MasterDurationRule {
                minimum_ticks: 0,
                maximum_ticks: i64::MAX,
            }),
        };
        let stored = set_brand_kit(&mut state.campaign, kit).unwrap();
        assert_eq!(stored.fingerprint.len(), 64);
        let page = projection_page(&state, 0, 80).unwrap();
        let diagnostics = &page.items[0].diagnostics;
        let rules: BTreeSet<&str> = diagnostics
            .iter()
            .map(|item| item.rule_id.as_str())
            .collect();
        assert!(rules.contains("brand.logo_required"));
        assert!(rules.contains("brand.minimum_text_size"));
        assert!(rules.contains("brand.safe_region"));
        assert!(diagnostics.iter().all(|item| {
            item.rule_source == "brand-ops"
                && item.rule_revision == "1@revision-7"
                && item.affected_cell_id == "cell-brand"
                && !item.action.is_empty()
        }));
    }

    #[test]
    fn thumbnail_schedule_is_visible_only_bounded_and_cancellable() {
        let visible = vec!["cell-b".into(), "cell-a".into(), "cell-c".into()];
        let prior = vec!["cell-offscreen".into(), "cell-c".into()];
        let schedule = thumbnail_schedule(&visible, Some("cell-b"), &prior, 2).unwrap();
        assert_eq!(
            schedule.queued,
            vec![
                ScheduledThumbnail {
                    cell_id: "cell-b".into(),
                    priority: 100,
                    quality: ThumbnailQuality::Full,
                },
                ScheduledThumbnail {
                    cell_id: "cell-a".into(),
                    priority: 50,
                    quality: ThumbnailQuality::Thumbnail,
                },
            ]
        );
        assert_eq!(
            schedule.cancelled_cell_ids,
            vec!["cell-c".to_owned(), "cell-offscreen".to_owned()]
        );
        assert_eq!(
            thumbnail_schedule(&visible, Some("cell-b"), &prior, 0),
            Err(VariantError::InvalidThumbnailMaxJobs)
        );
        assert_eq!(
            thumbnail_schedule(
                &(0..81)
                    .map(|index| format!("cell-{index}"))
                    .collect::<Vec<_>>(),
                None,
                &[],
                4,
            ),
            Err(VariantError::TooManyVisibleCells)
        );
        assert_eq!(
            schedule
                .queued
                .iter()
                .filter(|item| item.quality == ThumbnailQuality::Full)
                .count(),
            1
        );
    }
}
