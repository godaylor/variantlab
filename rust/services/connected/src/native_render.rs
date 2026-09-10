//! Native adapter for the frozen v1 clip/timing/canvas contract.
//! All file paths are worker-owned; the filter program contains numbers and indices only.
use std::collections::BTreeSet;

use render_plan::{RENDER_ENGINE_VERSION, RenderManifest, render_timing};
use studio_model::TrackKind;

pub struct NativePlan {
    pub assets: Vec<String>,
    pub originals: Vec<String>,
    pub filters: String,
    pub duration_seconds: String,
    pub fps: String,
    pub frame_count: u64,
    pub overlays: Vec<render_plan::RenderOverlay>,
}

pub fn plan(manifest: &RenderManifest) -> Result<NativePlan, String> {
    if !manifest.blockers.is_empty() {
        return Err(manifest.blockers.join(","));
    }
    let overlays = render_plan::render_overlays(manifest)?;
    if manifest.schema_version != 1
        || manifest.engine_version != RENDER_ENGINE_VERSION
        || manifest.fps_num == 0
        || manifest.fps_den == 0
        || manifest.sequence_duration_ticks <= 0
        || manifest.sequence_duration_ticks > 48_000 * 7_200
        || manifest.canvas.width == 0
        || manifest.canvas.height == 0
        || manifest.canvas.width > 3840
        || manifest.canvas.height > 3840
        || manifest.clips.is_empty()
    {
        return Err("unsupported_native_manifest".into());
    }
    let assets: Vec<String> = manifest
        .clips
        .iter()
        .map(|c| c.asset_hash.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if assets.len() > 64
        || assets
            .iter()
            .any(|hash| hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("invalid_native_assets".into());
    }
    let mut cuts = BTreeSet::from([0, manifest.sequence_duration_ticks]);
    for clip in &manifest.clips {
        let end = clip
            .start_tick
            .checked_add(clip.duration_ticks)
            .ok_or("invalid_clip_time")?;
        if clip.start_tick < 0
            || clip.duration_ticks <= 0
            || clip.source_offset_ticks < 0
            || clip.source_duration_ticks < clip.source_offset_ticks + clip.duration_ticks
            || end > manifest.sequence_duration_ticks
        {
            return Err("invalid_clip_time".into());
        }
        cuts.insert(clip.start_tick);
        cuts.insert(end);
    }
    let cuts: Vec<i64> = cuts.into_iter().collect();
    if cuts.len() > 1025 {
        return Err("native_segment_budget_exceeded".into());
    }
    let fps = format!("{}/{}", manifest.fps_num, manifest.fps_den);
    let crop = render_plan::native_crop_filter(manifest.canvas, manifest.crop)?;
    let mut filters = Vec::new();
    for (index, window) in cuts.windows(2).enumerate() {
        let (tick, duration) = (window[0], window[1] - window[0]);
        for (kind, label) in [(TrackKind::Video, "v"), (TrackKind::Audio, "a")] {
            let active = manifest.clips.iter().find(|clip| {
                (clip.track_kind == kind || (kind == TrackKind::Audio && clip.has_audio))
                    && tick >= clip.start_tick
                    && tick < clip.start_tick + clip.duration_ticks
            });
            let output = format!("[{label}{index}]");
            if let Some(clip) = active {
                let input = assets
                    .iter()
                    .position(|hash| hash == &clip.asset_hash)
                    .ok_or("missing_asset_index")?;
                let start = seconds(clip.source_offset_ticks + tick - clip.start_tick);
                let end = seconds(clip.source_offset_ticks + tick - clip.start_tick + duration);
                if kind == TrackKind::Video {
                    // Match the browser's previous-sample hold: a source frame
                    // becomes eligible at or after its PTS, never half a frame early.
                    filters.push(format!("[{input}:v:0]trim=start={start}:end={end},setpts=PTS-STARTPTS,{crop},scale={}:{},setsar=1,fps={fps}:round=up,format=yuv420p{output}", manifest.canvas.width, manifest.canvas.height));
                } else {
                    filters.push(format!("[{input}:a:0]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,apad,atrim=duration={}{output}",seconds(duration)));
                }
            } else if kind == TrackKind::Video {
                filters.push(format!(
                    "color=c=black:s={}x{}:r={fps}:d={}{output}",
                    manifest.canvas.width,
                    manifest.canvas.height,
                    seconds(duration)
                ));
            } else {
                filters.push(format!(
                    "anullsrc=r=48000:cl=mono,atrim=duration={}{output}",
                    seconds(duration)
                ));
            }
        }
    }
    let count = cuts.len() - 1;
    for label in ["v", "a"] {
        let input = (0..count)
            .map(|i| format!("[{label}{i}]"))
            .collect::<String>();
        let output = if label == "v" && !overlays.is_empty() {
            "vbase".to_owned()
        } else {
            format!("{label}out")
        };
        filters.push(format!(
            "{input}concat=n={count}:v={}:a={}[{output}]",
            u8::from(label == "v"),
            u8::from(label == "a")
        ));
    }
    if !overlays.is_empty() {
        filters.push(format!(
            "[vbase][{}:v:0]overlay=x=0:y=0:eof_action=pass[vout]",
            assets.len()
        ));
    }
    Ok(NativePlan {
        assets,
        originals: render_plan::render_required_assets(manifest)?,
        filters: filters.join(";"),
        duration_seconds: seconds(manifest.sequence_duration_ticks),
        fps,
        frame_count: render_timing(manifest).frame_count,
        overlays,
    })
}

fn seconds(ticks: i64) -> String {
    format!("{:.9}", ticks as f64 / 48_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_plan::RenderClipNode;
    fn fixture() -> RenderManifest {
        serde_json::from_value(serde_json::json!({"schema_version":1,"engine_version":RENDER_ENGINE_VERSION,"campaign_revision":4,"master_sequence_id":"master","scenes":[],"clips":[],"sequence_duration_ticks":96000,"variant_fingerprint":"fixture","canvas":{"width":1080,"height":1920},"fps_num":30,"fps_den":1,"safe_area":{"top_basis_points":0,"right_basis_points":0,"bottom_basis_points":0,"left_basis_points":0},"crop":{"x_basis_points":0,"y_basis_points":0,"scale_basis_points":10000},"asset_hashes":[],"font_revisions":[],"fps_source":"master","audio_mix_source":"master"})).unwrap()
    }
    #[test]
    fn frozen_sequence_uses_each_source_offset_and_target_canvas() {
        let mut m = fixture();
        m.clips = (0..2)
            .map(|i| RenderClipNode {
                scene_id: format!("scene-{i}"),
                clip_id: format!("clip-{i}"),
                asset_hash: format!("{i:064x}"),
                track_kind: TrackKind::Video,
                has_audio: true,
                start_tick: i * 48000,
                duration_ticks: 48000,
                source_offset_ticks: 24000,
                source_duration_ticks: 96000,
            })
            .collect();
        let p = plan(&m).unwrap();
        assert_eq!(p.assets.len(), 2);
        assert_eq!(p.frame_count, 60);
        assert!(p.filters.contains("scale=1080:1920"));
        assert!(p.filters.contains("trim=start=0.500000000:end=1.500000000"));
        assert!(p.filters.contains("fps=30/1:round=up"));
        m.scenes.push(render_plan::RenderSceneBoundary {
            scene_id: "scene-0".into(),
            scene_revision: 4,
            included: true,
            start_tick: 0,
            duration_ticks: 48000,
        });
        m.slot_nodes.push(render_plan::RenderSlotNode {
            slot_id: "text".into(),
            value: studio_model::SlotValue::Text {
                text: "Привет VariantLab".into(),
            },
            target: studio_model::SlotRenderTarget::Overlay {
                scene_id: "scene-0".into(),
                start_ticks: 12000,
                end_ticks: 36000,
                rect: studio_model::PlacementRect {
                    x: 1000,
                    y: 1000,
                    width: 6000,
                    height: 2000,
                },
                z_index: 1,
                text_style: Some(studio_model::RenderTextStyle {
                    font_id: render_plan::INTER_FONT_ID.into(),
                    font_sha256: render_plan::INTER_SHA256.into(),
                    font_size_px: 24,
                    line_height_px: 32,
                    max_lines: 2,
                    color_rgba: [255, 255, 255, 255],
                    alignment: studio_model::TextAlignment::Left,
                }),
            },
        });
        let with_text = plan(&m).unwrap();
        assert_eq!(with_text.overlays.len(), 1);
        assert!(
            with_text
                .filters
                .contains("overlay=x=0:y=0:eof_action=pass")
        );
        assert!(p.filters.contains("[v0][v1]concat=n=2:v=1:a=0"));
        assert!(!p.filters.contains("filename"));

        // A hundred sequential caption-size overlays exceed the old lifetime
        // count and byte budget, but retain only one cue's pixels at a time.
        let template = m.slot_nodes[0].clone();
        m.slot_nodes.clear();
        for index in 0..100 {
            let mut node = template.clone();
            node.slot_id = format!("caption-{index}");
            if let studio_model::SlotRenderTarget::Overlay {
                start_ticks,
                end_ticks,
                ..
            } = &mut node.target
            {
                *start_ticks = index * 480;
                *end_ticks = (index + 1) * 480;
            }
            m.slot_nodes.push(node);
        }
        assert_eq!(plan(&m).unwrap().overlays.len(), 100);
        let mut stream = render_plan::OverlayStream::new(&m).unwrap();
        let first = stream
            .frame(&m, 0, |_| Err("unexpected_logo".into()))
            .unwrap()
            .to_vec();
        assert!(first.iter().any(|v| *v != 0));
        for tick in [480, 24_000, 47_999] {
            assert_eq!(
                stream
                    .frame(&m, tick, |_| Err("unexpected_logo".into()))
                    .unwrap(),
                first
            );
            assert!(stream.cached_bytes() < 2 * 1024 * 1024);
        }
        assert!(
            stream
                .frame(&m, 48_000, |_| Err("unexpected_logo".into()))
                .unwrap()
                .iter()
                .all(|v| *v == 0)
        );
        assert_eq!(stream.cached_bytes(), 0);
        for node in &mut m.slot_nodes {
            if let studio_model::SlotRenderTarget::Overlay {
                start_ticks,
                end_ticks,
                ..
            } = &mut node.target
            {
                *start_ticks = 0;
                *end_ticks = 48_000;
            }
        }
        assert!(
            plan(&m).is_err(),
            "simultaneous overlays still enforce the memory limit"
        );
    }
    #[test]
    fn crop_changes_the_executed_filter_program() {
        let mut m = fixture();
        m.clips = vec![RenderClipNode {
            scene_id: "scene".into(),
            clip_id: "clip".into(),
            asset_hash: "a".repeat(64),
            track_kind: TrackKind::Video,
            has_audio: true,
            start_tick: 0,
            duration_ticks: 96000,
            source_offset_ticks: 0,
            source_duration_ticks: 96000,
        }];
        let before = plan(&m).unwrap().filters;
        m.crop.x_basis_points = 5000;
        m.crop.scale_basis_points = 20000;
        assert_ne!(
            before,
            plan(&m).unwrap().filters,
            "crop must change actual native output, not only its fingerprint"
        );
    }

    #[test]
    fn invalid_manifest_cannot_reach_codec_process() {
        assert!(plan(&fixture()).is_err());
        let mut m = fixture();
        m.engine_version = "unknown".into();
        assert!(plan(&m).is_err());
    }
}
