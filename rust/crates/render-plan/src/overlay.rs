use crate::{RenderManifest, raster_text};
use serde::{Deserialize, Serialize};
use studio_model::{SlotRenderTarget, SlotValue};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderOverlay {
    pub slot_id: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub z_index: u16,
    #[ts(type = "number")]
    pub start_tick: i64,
    #[ts(type = "number")]
    pub end_tick: i64,
}

pub fn render_overlays(manifest: &RenderManifest) -> Result<Vec<RenderOverlay>, String> {
    if manifest.engine_version != crate::RENDER_ENGINE_VERSION
        || manifest.schema_version != crate::RENDER_MANIFEST_SCHEMA_VERSION
    {
        return Err("render_engine_version_unsupported".into());
    }
    if !manifest.blockers.is_empty() {
        return Err(manifest.blockers.join(","));
    }
    let mut overlays = Vec::new();
    if manifest.slot_nodes.len() > 10_000 {
        return Err("overlay_count_budget".into());
    }
    for node in &manifest.slot_nodes {
        let SlotRenderTarget::Overlay {
            scene_id,
            start_ticks,
            end_ticks,
            rect,
            z_index,
            ..
        } = &node.target
        else {
            continue;
        };
        let scene = manifest
            .scenes
            .iter()
            .find(|scene| &scene.scene_id == scene_id)
            .ok_or("overlay_scene_missing")?;
        if !scene.included {
            continue;
        }
        if *start_ticks < 0
            || end_ticks <= start_ticks
            || *end_ticks > scene.duration_ticks
            || u32::from(rect.x) + u32::from(rect.width) > 10000
            || u32::from(rect.y) + u32::from(rect.height) > 10000
        {
            return Err("invalid_overlay_geometry".into());
        }
        let scale = |coordinate: u16, dimension: u32| {
            u32::try_from(u64::from(coordinate) * u64::from(dimension) / 10000)
                .map_err(|_| "overlay_geometry_overflow")
        };
        let (width, height) = (
            scale(rect.width, manifest.canvas.width)?,
            scale(rect.height, manifest.canvas.height)?,
        );
        if width == 0 || height == 0 {
            return Err("empty_overlay_geometry".into());
        }
        overlays.push(RenderOverlay {
            slot_id: node.slot_id.clone(),
            x: scale(rect.x, manifest.canvas.width)?,
            y: scale(rect.y, manifest.canvas.height)?,
            width,
            height,
            z_index: *z_index,
            start_tick: scene.start_tick + start_ticks,
            end_tick: scene.start_tick + end_ticks,
        });
    }
    overlays.sort_by(|a, b| (a.z_index, &a.slot_id).cmp(&(b.z_index, &b.slot_id)));
    // Half-open lifetimes: completed cues release their allocation before cues
    // starting at the same tick. The budget bounds live pixels, not track length.
    let mut events = Vec::with_capacity(overlays.len() * 2);
    for overlay in &overlays {
        let bytes = i64::from(overlay.width) * i64::from(overlay.height) * 4;
        events.push((overlay.start_tick, 1i64, bytes));
        events.push((overlay.end_tick, -1i64, -bytes));
    }
    events.sort();
    let (mut active, mut bytes) = (0i64, 0i64);
    for (_, count, allocation) in events {
        active += count;
        bytes += allocation;
        if active > 32 || bytes > 64 * 1024 * 1024 {
            return Err("overlay_memory_budget".into());
        }
    }
    Ok(overlays)
}

pub fn raster_manifest_text(manifest: &RenderManifest, slot_id: &str) -> Result<Vec<u8>, String> {
    let overlays = render_overlays(manifest)?;
    let overlay = overlays
        .iter()
        .find(|overlay| overlay.slot_id == slot_id)
        .ok_or("overlay_missing")?;
    let node = manifest
        .slot_nodes
        .iter()
        .find(|node| node.slot_id == slot_id)
        .ok_or("overlay_missing")?;
    match (&node.value, &node.target) {
        (
            SlotValue::Text { text },
            SlotRenderTarget::Overlay {
                text_style: Some(style),
                ..
            },
        ) => raster_text(text, style, overlay.width, overlay.height),
        _ => Err("text_style_required".into()),
    }
}

pub fn render_required_assets(manifest: &RenderManifest) -> Result<Vec<String>, String> {
    let mut assets = manifest
        .clips
        .iter()
        .map(|clip| clip.asset_hash.clone())
        .collect::<std::collections::BTreeSet<_>>();
    for overlay in render_overlays(manifest)? {
        if let Some(node) = manifest
            .slot_nodes
            .iter()
            .find(|node| node.slot_id == overlay.slot_id)
            && let SlotValue::Logo { asset_id } = &node.value
        {
            assets.insert(asset_id.clone());
        }
    }
    Ok(assets.into_iter().collect())
}

pub fn raster_manifest_logo(
    manifest: &RenderManifest,
    slot_id: &str,
    bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let overlays = render_overlays(manifest)?;
    let overlay = overlays
        .iter()
        .find(|overlay| overlay.slot_id == slot_id)
        .ok_or("overlay_missing")?;
    let node = manifest
        .slot_nodes
        .iter()
        .find(|node| node.slot_id == slot_id)
        .ok_or("overlay_missing")?;
    let SlotValue::Logo { asset_id } = &node.value else {
        return Err("logo_slot_required".into());
    };
    crate::raster_logo_png(bytes, asset_id, overlay.width, overlay.height)
}
