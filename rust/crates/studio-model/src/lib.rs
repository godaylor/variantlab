use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use ts_rs::TS;

mod render_binding;
pub use render_binding::*;
mod connected;
pub use connected::*;

pub const STUDIO_SCHEMA_VERSION: u32 = 1;
pub const HISTORY_LIMIT: usize = 100;
pub const TICKS_PER_SECOND: i64 = 48_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StudioState {
    pub schema_version: u32,
    pub campaign: Campaign,
    pub history: Vec<HistoryEntry>,
    pub redo: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Campaign {
    pub id: String,
    pub name: String,
    pub master_sequence: MasterSequence,
    pub revision: u32,
    pub created_at: String,
    pub updated_at: String,
    pub imported_from: Option<LegacyImportProvenance>,
    #[serde(default)]
    pub delivery_profiles: Vec<DeliveryProfile>,
    #[serde(default)]
    pub variant_cells: Vec<VariantCell>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slots: Vec<Slot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub render_bindings: Vec<MasterRenderBinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub creative_sets: Vec<CreativeSet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slot_audit_events: Vec<SlotAuditEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transcript_artifacts: Vec<TranscriptArtifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caption_tracks: Vec<CaptionTrack>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locale_profiles: Vec<LocaleProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_manifest: Option<FontManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand_kit: Option<BrandKit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scene_inclusions: Vec<SceneInclusion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MasterSequence {
    pub id: String,
    pub scenes: Vec<Scene>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub timeline: Option<Timeline>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct SceneInclusion {
    pub scene_id: String,
    pub included: bool,
}

impl Campaign {
    pub fn scene_is_included(&self, scene_id: &str) -> bool {
        self.scene_inclusions
            .iter()
            .find(|entry| entry.scene_id == scene_id)
            .is_none_or(|entry| entry.included)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimelineClip {
    pub id: String,
    pub asset_id: String,
    pub label: String,
    #[ts(type = "number")]
    pub start_ticks: i64,
    #[ts(type = "number")]
    pub duration_ticks: i64,
    #[ts(type = "number")]
    pub source_offset_ticks: i64,
    #[ts(type = "number")]
    pub source_duration_ticks: i64,
    pub has_audio: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimelineTrack {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    pub height: u32,
    pub clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Timeline {
    pub fps_num: u32,
    pub fps_den: u32,
    #[ts(type = "number")]
    pub duration_ticks: i64,
    pub tracks: Vec<TimelineTrack>,
}

impl Default for Timeline {
    fn default() -> Self {
        Self {
            fps_num: 30_000,
            fps_den: 1_001,
            duration_ticks: 0,
            tracks: vec![
                TimelineTrack {
                    id: "video-1".to_owned(),
                    name: "Video 1".to_owned(),
                    kind: TrackKind::Video,
                    height: 64,
                    clips: Vec::new(),
                },
                TimelineTrack {
                    id: "video-2".to_owned(),
                    name: "Video 2".to_owned(),
                    kind: TrackKind::Video,
                    height: 56,
                    clips: Vec::new(),
                },
                TimelineTrack {
                    id: "audio-1".to_owned(),
                    name: "Audio 1".to_owned(),
                    kind: TrackKind::Audio,
                    height: 52,
                    clips: Vec::new(),
                },
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TrimEdge {
    Start,
    End,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SplitRequest {
    pub clip_id: String,
    pub right_clip_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "edit", rename_all = "snake_case")]
#[ts(export)]
pub enum TimelineEdit {
    InsertClip {
        track_id: String,
        clip: TimelineClip,
    },
    MoveClips {
        clip_ids: Vec<String>,
        #[ts(type = "number")]
        delta_ticks: i64,
        target_track_id: Option<String>,
        #[ts(type = "number")]
        playhead_ticks: i64,
        #[ts(type = "number")]
        snap_tolerance_ticks: i64,
        disable_snapping: bool,
        ripple: bool,
    },
    TrimClip {
        clip_id: String,
        edge: TrimEdge,
        #[ts(type = "number")]
        target_ticks: i64,
        #[ts(type = "number")]
        playhead_ticks: i64,
        #[ts(type = "number")]
        snap_tolerance_ticks: i64,
        disable_snapping: bool,
        ripple: bool,
    },
    SplitClips {
        #[ts(type = "number")]
        at_ticks: i64,
        splits: Vec<SplitRequest>,
    },
    DeleteClips {
        clip_ids: Vec<String>,
        ripple: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ClipPlacement {
    pub track_id: String,
    pub clip: TimelineClip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimelinePatch {
    pub upsert: Vec<ClipPlacement>,
    pub remove_clip_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DirtyTimeRange {
    pub scene_id: String,
    #[ts(type = "number")]
    pub start_ticks: i64,
    #[ts(type = "number")]
    pub end_ticks: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LegacyImportProvenance {
    pub source_namespace: String,
    pub source_project_id: String,
    pub source_version: Option<u32>,
    pub imported_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CanvasSpec {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct SafeArea {
    pub top_basis_points: u16,
    pub right_basis_points: u16,
    pub bottom_basis_points: u16,
    pub left_basis_points: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct DeliveryProfile {
    pub id: String,
    pub name: String,
    pub canvas: CanvasSpec,
    pub safe_area: SafeArea,
    pub locale: String,
    pub layout_constraints: Vec<String>,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale_profile_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ModelProvenance {
    pub id: String,
    pub revision: String,
    pub license: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TranscriptWord {
    pub id: String,
    pub text: String,
    #[ts(type = "number")]
    pub start_ticks: i64,
    #[ts(type = "number")]
    pub end_ticks: i64,
    pub confidence_milli: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TranscriptArtifact {
    pub id: String,
    pub asset_hash: String,
    pub locale: String,
    pub words: Vec<TranscriptWord>,
    pub model: ModelProvenance,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CaptionCue {
    pub id: String,
    #[ts(type = "number")]
    pub start_ticks: i64,
    #[ts(type = "number")]
    pub end_ticks: i64,
    pub word_ids: Vec<String>,
    pub text: String,
    pub edited: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CaptionTrack {
    pub id: String,
    pub source_artifact_id: String,
    pub locale_profile_id: Option<String>,
    pub cues: Vec<CaptionCue>,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub placement: Option<CaptionPlacement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CaptionPlacement {
    pub scene_id: String,
    pub clip_id: String,
    pub rect: PlacementRect,
    pub text_style: RenderTextStyle,
    pub z_index: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct LocalizedTextValue {
    pub slot_id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CaptionStyle {
    pub font_size_px: u32,
    pub max_lines: u32,
    pub max_chars_per_second: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct LocaleProfile {
    pub id: String,
    pub name: String,
    pub locale: String,
    pub text_values: Vec<LocalizedTextValue>,
    pub font_fallback_ids: Vec<String>,
    pub caption_style: CaptionStyle,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct UnicodeRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct FontFace {
    pub id: String,
    pub family: String,
    pub revision: String,
    pub license: String,
    pub unicode_ranges: Vec<UnicodeRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct FontManifest {
    pub version: u32,
    pub fonts: Vec<FontFace>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TextDiagnosticKind {
    Overflow,
    MissingGlyph,
    Readability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TextDiagnostic {
    pub id: String,
    pub kind: TextDiagnosticKind,
    pub cue_id: String,
    pub text_slot_id: String,
    pub message: String,
    pub fix: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CropOverride {
    pub x_basis_points: i16,
    pub y_basis_points: i16,
    pub scale_basis_points: u16,
}

impl Default for CropOverride {
    fn default() -> Self {
        Self {
            x_basis_points: 0,
            y_basis_points: 0,
            scale_basis_points: 10_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct VariantCell {
    pub id: String,
    pub creative_set_id: String,
    pub delivery_profile_id: String,
    pub layout_override: Option<CropOverride>,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct BrandKitProvenance {
    pub source: String,
    pub revision: String,
    pub asset_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct BrandSafeRegion {
    pub id: String,
    pub safe_area: SafeArea,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct MasterDurationRule {
    #[ts(type = "number")]
    pub minimum_ticks: i64,
    #[ts(type = "number")]
    pub maximum_ticks: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct BrandKit {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub fingerprint: String,
    pub provenance: BrandKitProvenance,
    pub logo_required: bool,
    pub allowed_color_tokens: Vec<String>,
    pub allowed_font_ids: Vec<String>,
    pub minimum_text_size_px: u32,
    pub custom_safe_regions: Vec<BrandSafeRegion>,
    pub master_duration: Option<MasterDurationRule>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SlotKind {
    Hook,
    ProductShot,
    Headline,
    Cta,
    Logo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SlotFitPolicy {
    ExactDuration,
    Contain,
    Cover,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SlotValue {
    Media {
        asset_id: String,
        #[ts(type = "number")]
        duration_ticks: i64,
    },
    Text {
        text: String,
    },
    Logo {
        asset_id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum StrictSlotValue {
    Media {
        asset_id: String,
        duration_ticks: i64,
    },
    Text {
        text: String,
    },
    Logo {
        asset_id: String,
    },
}

impl<'de> Deserialize<'de> for SlotValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match StrictSlotValue::deserialize(deserializer)? {
            StrictSlotValue::Media {
                asset_id,
                duration_ticks,
            } => Self::Media {
                asset_id,
                duration_ticks,
            },
            StrictSlotValue::Text { text } => Self::Text { text },
            StrictSlotValue::Logo { asset_id } => Self::Logo { asset_id },
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct Slot {
    pub id: String,
    pub name: String,
    pub kind: SlotKind,
    pub master_entity_id: String,
    pub master_value: SlotValue,
    #[ts(type = "number")]
    pub duration_ticks: i64,
    pub fit_policy: SlotFitPolicy,
    pub style_fingerprint: String,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct SlotReplacement {
    pub slot_id: String,
    pub value: SlotValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CreativeSet {
    pub id: String,
    pub name: String,
    pub replacements: Vec<SlotReplacement>,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct SlotAssignment {
    pub creative_set_id: String,
    pub slot_id: String,
    pub value: SlotValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SlotAuditKind {
    Remap,
    DropReferences,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct SlotAuditEvent {
    pub id: String,
    pub kind: SlotAuditKind,
    pub source_slot_id: String,
    pub target_slot_id: Option<String>,
    pub actor_id: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SceneScope {
    Sequence,
    Scene { scene_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum VariantScope {
    Master,
    DeliveryProfile { delivery_profile_id: String },
    CreativeSet { creative_set_id: String },
    VariantCell { variant_cell_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HistoryScope {
    pub campaign_id: String,
    pub master_sequence_id: String,
    pub scene_scope: SceneScope,
    pub variant_scope: VariantScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CommandEnvelope {
    pub schema_version: u32,
    pub command_id: String,
    pub transaction_id: String,
    pub campaign_id: String,
    pub master_sequence_id: String,
    pub scene_scope: SceneScope,
    pub variant_scope: VariantScope,
    pub history_scope: HistoryScope,
    pub base_revision: u32,
    pub actor_id: String,
    pub device_id: String,
    pub issued_at: String,
    pub payload: CommandPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "command", rename_all = "snake_case")]
#[ts(export)]
pub enum CommandPayload {
    RenameScene {
        scene_id: String,
        new_name: String,
    },
    EditTimeline {
        scene_id: String,
        edit: TimelineEdit,
    },
    SetSceneInclusion {
        scene_id: String,
        included: bool,
    },
    CreateDeliveryProfile {
        profile: DeliveryProfile,
        cell_id: String,
    },
    SetVariantCrop {
        cell_id: String,
        crop: CropOverride,
    },
    ResetVariantCrop {
        cell_id: String,
    },
    CreateSlots {
        slots: Vec<Slot>,
    },
    SetSlotBinding {
        binding: MasterRenderBinding,
    },
    ClearSlotBinding {
        slot_id: String,
    },
    CreateCreativeSets {
        sets: Vec<CreativeSet>,
        cells: Vec<VariantCell>,
    },
    AssignSlotValues {
        assignments: Vec<SlotAssignment>,
    },
    UpdateMasterSlotStyle {
        slot_id: String,
        style_fingerprint: String,
    },
    DeleteSlot {
        slot_id: String,
    },
    RemapAndDeleteSlot {
        source_slot_id: String,
        target_slot_id: String,
        audit_event: SlotAuditEvent,
    },
    DropAndDeleteSlot {
        slot_id: String,
        audit_event: SlotAuditEvent,
    },
    AttachTranscript {
        artifact: TranscriptArtifact,
        track: CaptionTrack,
    },
    CreateLocaleProfile {
        profile: LocaleProfile,
        delivery_profile_id: String,
        font_manifest: FontManifest,
    },
    EditCaption {
        track_id: String,
        cue_id: String,
        text: String,
    },
    SetCaptionPlacement {
        track_id: String,
        placement: Option<CaptionPlacement>,
    },
    Undo,
    AddDeliveryProfiles {
        profiles: Vec<DeliveryProfile>,
    },
    EnableVariantCells {
        cells: Vec<VariantCell>,
    },
    DetachVariantCells {
        cell_ids: Vec<String>,
    },
    SetBrandKit {
        brand_kit: BrandKit,
    },
    Redo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HistoryEntry {
    pub transaction_id: String,
    pub label: String,
    pub scope: HistoryScope,
    pub forward: ReversibleCommand,
    pub inverse: ReversibleCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "command", rename_all = "snake_case")]
#[ts(export)]
pub enum ReversibleCommand {
    RenameScene {
        scene_id: String,
        name: String,
        updated_at: String,
    },
    ApplyTimelinePatch {
        scene_id: String,
        patch: TimelinePatch,
    },
    ReplaceSceneInclusions {
        entries: Vec<SceneInclusion>,
    },
    ReplaceDeliveryProfileBundle {
        profile_id: String,
        profile: Option<DeliveryProfile>,
        cell_id: String,
        cell: Option<VariantCell>,
    },
    ReplaceVariantCell {
        cell: VariantCell,
    },
    ReplaceCreativeState {
        slots: Vec<Slot>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        render_bindings: Vec<MasterRenderBinding>,
        creative_sets: Vec<CreativeSet>,
        variant_cells: Vec<VariantCell>,
        slot_audit_events: Vec<SlotAuditEvent>,
    },
    ReplaceSlotBindings {
        bindings: Vec<MasterRenderBinding>,
    },
    ReplaceCaptionLocaleState {
        transcript_artifacts: Vec<TranscriptArtifact>,
        caption_tracks: Vec<CaptionTrack>,
        locale_profiles: Vec<LocaleProfile>,
        delivery_profiles: Vec<DeliveryProfile>,
        font_manifest: Option<FontManifest>,
    },
    ReplaceVariantMatrixState {
        delivery_profiles: Vec<DeliveryProfile>,
        variant_cells: Vec<VariantCell>,
        brand_kit: Option<BrandKit>,
        affected_cell_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChangeSet {
    pub changed_entities: Vec<String>,
    #[serde(default)]
    pub dirty_time_ranges: Vec<DirtyTimeRange>,
    #[serde(default)]
    pub affected_variant_cells: Vec<String>,
    #[serde(default)]
    pub invalidated_render_keys: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PreparedCommit {
    pub envelope: CommandEnvelope,
    pub next_state: StudioState,
    pub revision: u32,
    pub snapshot_hash: String,
    pub label: String,
    pub change_set: ChangeSet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export)]
pub enum PrepareResult {
    Prepared {
        commit: Box<PreparedCommit>,
    },
    NoOp {
        reason: String,
        state: Box<StudioState>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateCampaignInput {
    pub campaign_id: String,
    pub campaign_name: String,
    pub master_sequence_id: String,
    pub created_at: String,
    pub scenes: Vec<Scene>,
    pub imported_from: Option<LegacyImportProvenance>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ModelError {
    #[error("campaign must contain at least one scene")]
    EmptySequence,
    #[error("campaign, master sequence and scene IDs must be non-empty")]
    EmptyId,
    #[error("scene IDs must be unique")]
    DuplicateSceneId,
    #[error("snapshot serialization failed: {0}")]
    Serialization(String),
}

pub fn create_campaign(input: CreateCampaignInput) -> Result<StudioState, ModelError> {
    if input.scenes.is_empty() {
        return Err(ModelError::EmptySequence);
    }
    if input.campaign_id.trim().is_empty()
        || input.master_sequence_id.trim().is_empty()
        || input.scenes.iter().any(|scene| scene.id.trim().is_empty())
    {
        return Err(ModelError::EmptyId);
    }
    let mut ids: Vec<&str> = input.scenes.iter().map(|scene| scene.id.as_str()).collect();
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(ModelError::DuplicateSceneId);
    }

    Ok(StudioState {
        schema_version: STUDIO_SCHEMA_VERSION,
        campaign: Campaign {
            id: input.campaign_id,
            name: input.campaign_name,
            master_sequence: MasterSequence {
                id: input.master_sequence_id,
                scenes: input.scenes,
            },
            revision: 0,
            created_at: input.created_at.clone(),
            updated_at: input.created_at,
            imported_from: input.imported_from,
            delivery_profiles: Vec::new(),
            variant_cells: Vec::new(),
            slots: Vec::new(),
            render_bindings: Vec::new(),
            creative_sets: Vec::new(),
            slot_audit_events: Vec::new(),
            transcript_artifacts: Vec::new(),
            caption_tracks: Vec::new(),
            locale_profiles: Vec::new(),
            font_manifest: None,
            brand_kit: None,
            scene_inclusions: Vec::new(),
        },
        history: Vec::new(),
        redo: Vec::new(),
    })
}

pub fn canonical_snapshot(state: &StudioState) -> Result<String, ModelError> {
    serde_json::to_string(state).map_err(|error| ModelError::Serialization(error.to_string()))
}

pub fn snapshot_hash(state: &StudioState) -> Result<String, ModelError> {
    let canonical = canonical_snapshot(state)?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(id: &str) -> Scene {
        Scene {
            id: id.to_owned(),
            name: id.to_owned(),
            created_at: "2026-08-27T00:00:00Z".to_owned(),
            updated_at: "2026-08-27T00:00:00Z".to_owned(),
            timeline: Some(Timeline::default()),
        }
    }

    #[test]
    fn snapshot_round_trip_and_hash_are_stable() {
        let state = create_campaign(CreateCampaignInput {
            campaign_id: "campaign-1".into(),
            campaign_name: "Launch".into(),
            master_sequence_id: "sequence-1".into(),
            created_at: "2026-08-27T00:00:00Z".into(),
            scenes: vec![scene("scene-a"), scene("scene-b")],
            imported_from: None,
        })
        .unwrap();
        let json = canonical_snapshot(&state).unwrap();
        let restored: StudioState = serde_json::from_str(&json).unwrap();
        assert_eq!(state, restored);
        assert_eq!(
            snapshot_hash(&state).unwrap(),
            snapshot_hash(&restored).unwrap()
        );
    }

    #[test]
    fn empty_creative_collections_preserve_pre_m4_snapshot_shape() {
        let state = create_campaign(CreateCampaignInput {
            campaign_id: "pre-m4".into(),
            campaign_name: "Launch".into(),
            master_sequence_id: "sequence".into(),
            created_at: "2026-08-28T00:00:00Z".into(),
            scenes: vec![scene("scene-a")],
            imported_from: None,
        })
        .unwrap();
        let json = canonical_snapshot(&state).unwrap();
        assert!(!json.contains("\"slots\""));
        assert!(!json.contains("\"render_bindings\""));
        assert!(!json.contains("\"creative_sets\""));
        assert!(!json.contains("\"brand_kit\""));
        assert!(!json.contains("\"slot_audit_events\""));
        let restored: StudioState = serde_json::from_str(&json).unwrap();
        assert_eq!(
            snapshot_hash(&state).unwrap(),
            snapshot_hash(&restored).unwrap()
        );
    }

    #[test]
    fn rejects_duplicate_scene_ids() {
        let result = create_campaign(CreateCampaignInput {
            campaign_id: "campaign-1".into(),
            campaign_name: "Launch".into(),
            master_sequence_id: "sequence-1".into(),
            created_at: "2026-08-27T00:00:00Z".into(),
            scenes: vec![scene("scene-a"), scene("scene-a")],
            imported_from: None,
        });
        assert_eq!(result, Err(ModelError::DuplicateSceneId));
    }
}
