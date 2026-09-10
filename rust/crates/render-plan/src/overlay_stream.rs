//! Bounded active-overlay raster cache, shared rules for a streamed native layer.
use crate::{
    RenderManifest, RenderOverlay, raster_manifest_logo, raster_manifest_text, render_overlays,
};
use std::collections::BTreeMap;

pub struct OverlayStream {
    overlays: Vec<RenderOverlay>,
    cache: BTreeMap<String, Vec<u8>>,
    frame: Vec<u8>,
    last_active: Option<Vec<String>>,
}
impl OverlayStream {
    pub fn new(manifest: &RenderManifest) -> Result<Self, String> {
        let bytes = u64::from(manifest.canvas.width) * u64::from(manifest.canvas.height) * 4;
        if bytes == 0 || bytes > 64 * 1024 * 1024 {
            return Err("overlay_frame_budget".into());
        }
        Ok(Self {
            overlays: render_overlays(manifest)?,
            cache: BTreeMap::new(),
            frame: vec![0; bytes as usize],
            last_active: None,
        })
    }
    pub fn frame(
        &mut self,
        manifest: &RenderManifest,
        tick: i64,
        mut load_logo: impl FnMut(&str) -> Result<Vec<u8>, String>,
    ) -> Result<&[u8], String> {
        let active: Vec<String> = self
            .overlays
            .iter()
            .filter(|o| tick >= o.start_tick && tick < o.end_tick)
            .map(|o| o.slot_id.clone())
            .collect();
        if self.last_active.as_ref() == Some(&active) {
            return Ok(&self.frame);
        }
        self.cache.retain(|id, _| {
            self.overlays
                .iter()
                .any(|o| &o.slot_id == id && tick >= o.start_tick && tick < o.end_tick)
        });
        self.frame.fill(0);
        for overlay in self
            .overlays
            .iter()
            .filter(|o| tick >= o.start_tick && tick < o.end_tick)
        {
            if !self.cache.contains_key(&overlay.slot_id) {
                let node = manifest
                    .slot_nodes
                    .iter()
                    .find(|n| n.slot_id == overlay.slot_id)
                    .ok_or("overlay_missing")?;
                let pixels = if let studio_model::SlotValue::Logo { asset_id } = &node.value {
                    raster_manifest_logo(manifest, &overlay.slot_id, &load_logo(asset_id)?)?
                } else {
                    raster_manifest_text(manifest, &overlay.slot_id)?
                };
                self.cache.insert(overlay.slot_id.clone(), pixels);
            }
            let source = &self.cache[&overlay.slot_id];
            for y in 0..overlay.height {
                for x in 0..overlay.width {
                    let from = ((y * overlay.width + x) * 4) as usize;
                    let to =
                        (((y + overlay.y) * manifest.canvas.width + x + overlay.x) * 4) as usize;
                    let a = u32::from(source[from + 3]);
                    if a == 0 {
                        continue;
                    }
                    let destination_a = u32::from(self.frame[to + 3]);
                    let alpha_numerator = a * 255 + destination_a * (255 - a);
                    for channel in 0..3 {
                        let numerator = u32::from(source[from + channel]) * a * 255
                            + u32::from(self.frame[to + channel]) * destination_a * (255 - a);
                        self.frame[to + channel] =
                            ((numerator + alpha_numerator / 2) / alpha_numerator) as u8;
                    }
                    self.frame[to + 3] = ((alpha_numerator + 127) / 255) as u8;
                }
            }
        }
        self.last_active = Some(active);
        Ok(&self.frame)
    }
    pub fn cached_bytes(&self) -> usize {
        self.cache.values().map(Vec::len).sum()
    }
}
