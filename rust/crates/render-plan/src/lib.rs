use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use studio_model::{CanvasSpec, CropOverride, SafeArea, StudioState, TrackKind};
use thiserror::Error;
use ts_rs::TS;
use variant_engine::{ResolvedVariant, VariantError, resolve};

mod package;
pub use package::*;
mod crop;
pub use crop::*;
mod text_raster;
pub use text_raster::*;
mod overlay;
mod overlay_stream;
pub use overlay::*;
pub use overlay_stream::OverlayStream;
mod logo_raster;
pub use logo_raster::*;
mod frame;
pub use frame::*;

pub const RENDER_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const RENDER_ENGINE_VERSION: &str = "variantlab-render-v2";

/// Untagged SDR VP8/VP9 uses the native decoder's limited-range BT.601
/// interpretation. Explicit source metadata always takes precedence.
pub fn untagged_video_color_space() -> serde_json::Value {
    serde_json::json!({
        "matrix": "smpte170m", "primaries": "smpte170m",
        "transfer": "smpte170m", "fullRange": false
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderSceneBoundary {
    pub scene_id: String,
    pub scene_revision: u32,
    pub included: bool,
    #[ts(type = "number")]
    pub start_tick: i64,
    #[ts(type = "number")]
    pub duration_ticks: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderClipNode {
    pub scene_id: String,
    pub clip_id: String,
    pub asset_hash: String,
    pub track_kind: TrackKind,
    pub has_audio: bool,
    #[ts(type = "number")]
    pub start_tick: i64,
    #[ts(type = "number")]
    pub duration_ticks: i64,
    #[ts(type = "number")]
    pub source_offset_ticks: i64,
    #[ts(type = "number")]
    pub source_duration_ticks: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderManifest {
    pub schema_version: u32,
    pub engine_version: String,
    pub campaign_revision: u32,
    pub master_sequence_id: String,
    pub scenes: Vec<RenderSceneBoundary>,
    pub clips: Vec<RenderClipNode>,
    #[ts(type = "number")]
    pub sequence_duration_ticks: i64,
    pub variant_fingerprint: String,
    pub canvas: CanvasSpec,
    pub fps_num: u32,
    pub fps_den: u32,
    pub safe_area: SafeArea,
    pub crop: CropOverride,
    pub asset_hashes: Vec<String>,
    pub font_revisions: Vec<String>,
    pub fps_source: String,
    pub audio_mix_source: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slot_nodes: Vec<RenderSlotNode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderSlotNode {
    pub slot_id: String,
    pub value: studio_model::SlotValue,
    pub target: studio_model::SlotRenderTarget,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RenderPlanError {
    #[error("variant resolution failed: {0}")]
    Variant(#[from] VariantError),
    #[error("render contract failed: {0}")]
    Contract(String),
}

pub fn build_manifest(
    state: &StudioState,
    cell_id: &str,
) -> Result<RenderManifest, RenderPlanError> {
    let resolved = resolve(state, cell_id)?;
    Ok(manifest_from_resolved(state, &resolved))
}

fn manifest_from_resolved(state: &StudioState, resolved: &ResolvedVariant) -> RenderManifest {
    let mut start_tick = 0;
    let scenes: Vec<RenderSceneBoundary> = state
        .campaign
        .master_sequence
        .scenes
        .iter()
        .map(|scene| {
            let included = state.campaign.scene_is_included(&scene.id);
            let duration_ticks = scene
                .timeline
                .as_ref()
                .map_or(0, |timeline| timeline.duration_ticks);
            let boundary = RenderSceneBoundary {
                scene_id: scene.id.clone(),
                scene_revision: state.campaign.revision,
                included,
                start_tick,
                duration_ticks,
            };
            if included {
                start_tick += duration_ticks;
            }
            boundary
        })
        .collect();
    let (fps_num, fps_den) = state
        .campaign
        .master_sequence
        .scenes
        .iter()
        .find_map(|scene| {
            scene
                .timeline
                .as_ref()
                .map(|timeline| (timeline.fps_num, timeline.fps_den))
        })
        .unwrap_or((30_000, 1_001));
    let mut asset_hashes: Vec<String> = state
        .campaign
        .master_sequence
        .scenes
        .iter()
        .filter(|scene| state.campaign.scene_is_included(&scene.id))
        .filter_map(|scene| scene.timeline.as_ref())
        .flat_map(|timeline| timeline.tracks.iter())
        .flat_map(|track| track.clips.iter())
        .map(|clip| clip.asset_id.clone())
        .chain(
            state
                .campaign
                .transcript_artifacts
                .iter()
                .map(|artifact| artifact.asset_hash.clone()),
        )
        .collect();
    asset_hashes.sort();
    asset_hashes.dedup();
    let mut font_revisions = state
        .campaign
        .font_manifest
        .iter()
        .flat_map(|manifest| manifest.fonts.iter())
        .map(|font| format!("{}@{}", font.id, font.revision))
        .collect::<Vec<_>>();
    font_revisions.sort();
    font_revisions.dedup();
    let mut clips: Vec<RenderClipNode> = state
        .campaign
        .master_sequence
        .scenes
        .iter()
        .filter(|scene| state.campaign.scene_is_included(&scene.id))
        .flat_map(|scene| {
            let scene_start = scenes
                .iter()
                .find(|boundary| boundary.scene_id == scene.id)
                .map_or(0, |boundary| boundary.start_tick);
            scene.timeline.iter().flat_map(move |timeline| {
                timeline.tracks.iter().flat_map(move |track| {
                    track.clips.iter().map(move |clip| RenderClipNode {
                        scene_id: scene.id.clone(),
                        clip_id: clip.id.clone(),
                        asset_hash: clip.asset_id.clone(),
                        track_kind: track.kind,
                        has_audio: clip.has_audio,
                        start_tick: scene_start + clip.start_ticks,
                        duration_ticks: clip.duration_ticks,
                        source_offset_ticks: clip.source_offset_ticks,
                        source_duration_ticks: clip.source_duration_ticks,
                    })
                })
            })
        })
        .collect();
    let mut blockers = Vec::new();
    let mut slot_nodes = Vec::new();
    for slot in &resolved.resolved_slots {
        let Some(binding) = state
            .campaign
            .render_bindings
            .iter()
            .find(|binding| binding.slot_id == slot.slot_id)
        else {
            blockers.push(format!("slot_binding_required:{}", slot.slot_id));
            continue;
        };
        let mut value = slot.value.clone();
        if let Some(locale) = state
            .campaign
            .delivery_profiles
            .iter()
            .find(|profile| profile.id == resolved.delivery_profile_id)
            .and_then(|profile| profile.locale_profile_id.as_ref())
            .and_then(|id| {
                state
                    .campaign
                    .locale_profiles
                    .iter()
                    .find(|locale| &locale.id == id)
            })
            && let Some(copy) = locale
                .text_values
                .iter()
                .find(|copy| copy.slot_id == slot.slot_id)
            && matches!(value, studio_model::SlotValue::Text { .. })
        {
            value = studio_model::SlotValue::Text {
                text: copy.text.clone(),
            };
        }
        if let (
            studio_model::SlotRenderTarget::Clip { scene_id, clip_id },
            studio_model::SlotValue::Media {
                asset_id,
                duration_ticks,
            },
        ) = (&binding.target, &value)
        {
            if let Some(index) = clips.iter().position(|clip| {
                &clip.scene_id == scene_id
                    && &clip.clip_id == clip_id
                    && clip.track_kind == TrackKind::Video
            }) {
                if clips[index].duration_ticks != *duration_ticks {
                    blockers.push(format!("slot_duration_mismatch:{}", slot.slot_id));
                }
                if clips[index].asset_hash != *asset_id {
                    if clips[index].has_audio {
                        let mut audio = clips[index].clone();
                        audio.track_kind = TrackKind::Audio;
                        // Keep this source's place in the existing master audio order.
                        clips.insert(index, audio);
                    }
                    let visual = clips
                        .iter_mut()
                        .find(|clip| {
                            &clip.scene_id == scene_id
                                && &clip.clip_id == clip_id
                                && clip.track_kind == TrackKind::Video
                        })
                        .unwrap();
                    visual.asset_hash = asset_id.clone();
                    visual.has_audio = false;
                    visual.source_offset_ticks = 0;
                    visual.source_duration_ticks = *duration_ticks;
                }
            } else if state.campaign.scene_is_included(scene_id) {
                blockers.push(format!("slot_clip_missing:{}", slot.slot_id));
            }
        }
        slot_nodes.push(RenderSlotNode {
            slot_id: slot.slot_id.clone(),
            value,
            target: binding.target.clone(),
        });
    }
    let locale_id = state
        .campaign
        .delivery_profiles
        .iter()
        .find(|profile| profile.id == resolved.delivery_profile_id)
        .and_then(|profile| profile.locale_profile_id.as_ref());
    for track in &state.campaign.caption_tracks {
        if track.cues.is_empty()
            || (track.locale_profile_id.is_some() && track.locale_profile_id.as_ref() != locale_id)
        {
            continue;
        }
        let Some(placement) = &track.placement else {
            blockers.push(format!("caption_placement_required:{}", track.id));
            continue;
        };
        if !state.campaign.scene_is_included(&placement.scene_id) {
            continue;
        }
        let source = state
            .campaign
            .master_sequence
            .scenes
            .iter()
            .find(|scene| scene.id == placement.scene_id)
            .and_then(|scene| scene.timeline.as_ref())
            .and_then(|timeline| {
                timeline
                    .tracks
                    .iter()
                    .flat_map(|track| &track.clips)
                    .find(|clip| clip.id == placement.clip_id)
            });
        let Some(source) = source else {
            blockers.push(format!("caption_source_clip_missing:{}", track.id));
            continue;
        };
        if !state.campaign.transcript_artifacts.iter().any(|artifact| {
            artifact.id == track.source_artifact_id && artifact.asset_hash == source.asset_id
        }) {
            blockers.push(format!("caption_source_asset_mismatch:{}", track.id));
            continue;
        }
        for cue in &track.cues {
            // Captions follow the explicitly bound master source through trims/moves.
            let start = cue.start_ticks.max(source.source_offset_ticks);
            let end = cue
                .end_ticks
                .min(source.source_offset_ticks + source.duration_ticks);
            if end <= start || cue.text.trim().is_empty() {
                continue;
            }
            slot_nodes.push(RenderSlotNode {
                slot_id: format!("caption:{}:{}", track.id, cue.id),
                value: studio_model::SlotValue::Text {
                    text: cue.text.clone(),
                },
                target: studio_model::SlotRenderTarget::Overlay {
                    scene_id: placement.scene_id.clone(),
                    start_ticks: source.start_ticks + start - source.source_offset_ticks,
                    end_ticks: source.start_ticks + end - source.source_offset_ticks,
                    rect: placement.rect.clone(),
                    z_index: placement.z_index,
                    text_style: Some(placement.text_style.clone()),
                },
            });
        }
    }
    asset_hashes.extend(clips.iter().map(|clip| clip.asset_hash.clone()));
    for node in &slot_nodes {
        if let studio_model::SlotRenderTarget::Overlay {
            scene_id,
            text_style,
            ..
        } = &node.target
            && state.campaign.scene_is_included(scene_id)
        {
            if let studio_model::SlotValue::Logo { asset_id } = &node.value {
                asset_hashes.push(asset_id.clone());
            }
            if let Some(style) = text_style {
                font_revisions.push(format!("{}@sha256:{}", style.font_id, style.font_sha256));
            }
        }
    }
    font_revisions.sort();
    font_revisions.dedup();
    asset_hashes.sort();
    asset_hashes.dedup();
    blockers.sort();
    slot_nodes.sort_by(|a, b| a.slot_id.cmp(&b.slot_id));
    RenderManifest {
        schema_version: RENDER_MANIFEST_SCHEMA_VERSION,
        engine_version: RENDER_ENGINE_VERSION.into(),
        campaign_revision: state.campaign.revision,
        master_sequence_id: state.campaign.master_sequence.id.clone(),
        scenes,
        clips,
        sequence_duration_ticks: start_tick,
        variant_fingerprint: resolved.fingerprint.clone(),
        canvas: resolved.canvas,
        fps_num,
        fps_den,
        safe_area: resolved.safe_area,
        crop: resolved.crop,
        asset_hashes,
        font_revisions,
        fps_source: "master".into(),
        audio_mix_source: "master".into(),
        slot_nodes,
        blockers,
    }
}

pub fn manifest_checksum(manifest: &RenderManifest) -> Result<String, RenderPlanError> {
    let json = serde_json::to_vec(manifest)
        .map_err(|error| RenderPlanError::Contract(error.to_string()))?;
    Ok(Sha256::digest(json)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_model::{
        CanvasSpec, CreateCampaignInput, DeliveryProfile, SafeArea, Scene, create_campaign,
    };
    use variant_engine::create_delivery_profile;

    #[test]
    fn manifest_is_immutable_and_keeps_master_timing_contract() {
        let mut state = create_campaign(CreateCampaignInput {
            campaign_id: "campaign-1".into(),
            campaign_name: "Launch".into(),
            master_sequence_id: "sequence-1".into(),
            created_at: "2026-08-28T00:00:00Z".into(),
            scenes: vec![Scene {
                id: "scene-1".into(),
                name: "Master".into(),
                created_at: "2026-08-28T00:00:00Z".into(),
                updated_at: "2026-08-28T00:00:00Z".into(),
                timeline: Some(studio_model::Timeline {
                    duration_ticks: 96_000,
                    ..Default::default()
                }),
            }],
            imported_from: None,
        })
        .unwrap();
        create_delivery_profile(
            &mut state.campaign,
            DeliveryProfile {
                id: "profile-vertical".into(),
                name: "9:16".into(),
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
                layout_constraints: vec!["safe_area".into()],
                version: 1,
                locale_profile_id: None,
            },
            "cell-vertical".into(),
        )
        .unwrap();
        let first = build_manifest(&state, "cell-vertical").unwrap();
        let second = build_manifest(&state, "cell-vertical").unwrap();
        assert_eq!(first, second);
        assert_eq!(first.sequence_duration_ticks, 96_000);
        assert_eq!((first.fps_num, first.fps_den), (30_000, 1_001));
        assert_eq!(first.audio_mix_source, "master");
        let old_hash = studio_model::snapshot_hash(&state).unwrap();
        let legacy = studio_model::canonical_snapshot(&state).unwrap();
        assert!(!legacy.contains("render_bindings"));
        assert_eq!(
            old_hash,
            studio_model::snapshot_hash(&serde_json::from_str(&legacy).unwrap()).unwrap()
        );
        state.campaign.slots.push(studio_model::Slot {
            id: "headline".into(),
            name: "User copy".into(),
            kind: studio_model::SlotKind::Headline,
            master_entity_id: "headline".into(),
            master_value: studio_model::SlotValue::Text {
                text: "Привет VariantLab".into(),
            },
            duration_ticks: 0,
            fit_policy: studio_model::SlotFitPolicy::ExactDuration,
            style_fingerprint: "explicit".into(),
            version: 1,
        });
        let unbound = build_manifest(&state, "cell-vertical").unwrap();
        assert_eq!(unbound.blockers, vec!["slot_binding_required:headline"]);
        state
            .campaign
            .render_bindings
            .push(studio_model::MasterRenderBinding {
                slot_id: "headline".into(),
                target: studio_model::SlotRenderTarget::Overlay {
                    scene_id: "scene-1".into(),
                    start_ticks: 12000,
                    end_ticks: 48000,
                    rect: studio_model::PlacementRect {
                        x: 1000,
                        y: 1000,
                        width: 6000,
                        height: 2000,
                    },
                    z_index: 2,
                    text_style: Some(studio_model::RenderTextStyle {
                        font_id: INTER_FONT_ID.into(),
                        font_sha256: INTER_SHA256.into(),
                        font_size_px: 24,
                        line_height_px: 32,
                        max_lines: 2,
                        color_rgba: [255, 255, 255, 255],
                        alignment: studio_model::TextAlignment::Left,
                    }),
                },
            });
        let bound = build_manifest(&state, "cell-vertical").unwrap();
        assert!(bound.blockers.is_empty());
        assert_eq!(
            bound.slot_nodes[0].value,
            state.campaign.slots[0].master_value
        );
        assert_eq!(render_overlays(&bound).unwrap()[0].start_tick, 12000);
        assert!(
            raster_manifest_text(&bound, "headline")
                .unwrap()
                .chunks_exact(4)
                .any(|pixel| pixel[3] > 0)
        );
        assert_ne!(
            manifest_checksum(&unbound).unwrap(),
            manifest_checksum(&bound).unwrap()
        );
        state.campaign.slots.clear();
        state.campaign.render_bindings.clear();
        state.campaign.master_sequence.scenes[0]
            .timeline
            .as_mut()
            .unwrap()
            .tracks[0]
            .clips
            .push(studio_model::TimelineClip {
                id: "caption-source".into(),
                asset_id: "real-source".into(),
                label: "Original".into(),
                start_ticks: 12000,
                duration_ticks: 48000,
                source_offset_ticks: 24000,
                source_duration_ticks: 96000,
                has_audio: true,
            });
        let legacy_track = serde_json::json!({"id":"captions","source_artifact_id":"transcript","locale_profile_id":null,
            "cues":[{"id":"cue","start_ticks":12000,"end_ticks":48000,"word_ids":["word"],"text":"Реальный текст","edited":true}],"version":1});
        let track: studio_model::CaptionTrack =
            serde_json::from_value(legacy_track.clone()).unwrap();
        assert_eq!(serde_json::to_value(&track).unwrap(), legacy_track);
        state.campaign.caption_tracks.push(track);
        state.campaign.transcript_artifacts.push(serde_json::from_value(serde_json::json!({"id":"transcript","asset_hash":"real-source","locale":"ru", "words":[],
            "model":{"id":"fixture","revision":"1","license":"MIT"},"created_at":"2026-09-09"})).unwrap());
        assert_eq!(
            build_manifest(&state, "cell-vertical").unwrap().blockers,
            vec!["caption_placement_required:captions"]
        );
        state.campaign.caption_tracks[0].placement = Some(studio_model::CaptionPlacement {
            scene_id: "scene-1".into(),
            clip_id: "caption-source".into(),
            rect: studio_model::PlacementRect {
                x: 1000,
                y: 6000,
                width: 8000,
                height: 2000,
            },
            z_index: 3,
            text_style: studio_model::RenderTextStyle {
                font_id: INTER_FONT_ID.into(),
                font_sha256: INTER_SHA256.into(),
                font_size_px: 32,
                line_height_px: 40,
                max_lines: 2,
                color_rgba: [255, 255, 255, 255],
                alignment: studio_model::TextAlignment::Center,
            },
        });
        let captioned = build_manifest(&state, "cell-vertical").unwrap();
        assert!(captioned.blockers.is_empty());
        let overlay = render_overlays(&captioned).unwrap().remove(0);
        assert_eq!((overlay.start_tick, overlay.end_tick), (12000, 36000));
        assert!(
            !render_frame_plan(&captioned, 11999)
                .unwrap()
                .overlay_ids
                .contains(&overlay.slot_id)
        );
        assert!(
            render_frame_plan(&captioned, 12000)
                .unwrap()
                .overlay_ids
                .contains(&overlay.slot_id)
        );
        assert!(
            !render_frame_plan(&captioned, 36000)
                .unwrap()
                .overlay_ids
                .contains(&overlay.slot_id)
        );
        assert!(
            raster_manifest_text(&captioned, &overlay.slot_id)
                .unwrap()
                .chunks_exact(4)
                .any(|pixel| pixel[3] > 0)
        );
    }
}
