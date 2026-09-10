use crate::{RenderManifest, render_overlays};
use serde::{Deserialize, Serialize};
use studio_model::TrackKind;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderFrameSource {
    pub asset_hash: String,
    #[ts(type = "number")]
    pub source_tick: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderFramePlan {
    pub video: Option<RenderFrameSource>,
    pub audio: Option<RenderFrameSource>,
    pub scene_boundary: bool,
    pub overlay_ids: Vec<String>,
}

/// The same half-open intervals and source clock apply to preview and export.
pub fn render_frame_plan(manifest: &RenderManifest, tick: i64) -> Result<RenderFramePlan, String> {
    let overlays = render_overlays(manifest)?;
    if tick < 0 || tick >= manifest.sequence_duration_ticks {
        return Err("frame_outside_sequence".into());
    }
    let source = |audio: bool| {
        manifest
            .clips
            .iter()
            .find(|clip| {
                (if audio {
                    clip.track_kind == TrackKind::Audio || clip.has_audio
                } else {
                    clip.track_kind == TrackKind::Video
                }) && tick >= clip.start_tick
                    && tick < clip.start_tick + clip.duration_ticks
            })
            .map(|clip| RenderFrameSource {
                asset_hash: clip.asset_hash.clone(),
                source_tick: clip.source_offset_ticks + tick - clip.start_tick,
            })
    };
    Ok(RenderFramePlan {
        video: source(false),
        audio: source(true),
        scene_boundary: manifest
            .scenes
            .iter()
            .any(|scene| scene.included && scene.start_tick == tick),
        overlay_ids: overlays
            .into_iter()
            .filter(|node| tick >= node.start_tick && tick < node.end_tick)
            .map(|node| node.slot_id)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_intervals_source_offsets_and_gaps_are_canonical() {
        let manifest: RenderManifest = serde_json::from_value(serde_json::json!({
            "schema_version":1,"engine_version":crate::RENDER_ENGINE_VERSION,
            "campaign_revision":1,"master_sequence_id":"master","scenes":[],
            "clips":[{"scene_id":"scene","clip_id":"clip","asset_hash":"real", "track_kind":"video", "has_audio":true,
                "start_tick":100,"duration_ticks":200,"source_offset_ticks":50,"source_duration_ticks":500}],
            "sequence_duration_ticks":400,"variant_fingerprint":"fixture","canvas":{"width":100,"height":100},
            "fps_num":30,"fps_den":1,"safe_area":{"top_basis_points":0,"right_basis_points":0,"bottom_basis_points":0,"left_basis_points":0},
            "crop":{"x_basis_points":0,"y_basis_points":0,"scale_basis_points":10000},
            "asset_hashes":[],"font_revisions":[],"fps_source":"master","audio_mix_source":"master"
        })).unwrap();
        assert!(render_frame_plan(&manifest, 99).unwrap().video.is_none());
        let frame = render_frame_plan(&manifest, 150).unwrap();
        assert_eq!(frame.video.as_ref().unwrap().source_tick, 100);
        assert_eq!(frame.audio, frame.video);
        assert!(render_frame_plan(&manifest, 300).unwrap().video.is_none());
        assert!(render_frame_plan(&manifest, 400).is_err());
        assert!(render_frame_plan(&manifest, -1).is_err());
    }
}
