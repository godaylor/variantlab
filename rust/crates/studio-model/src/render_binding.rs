use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Explicit user-authored placement; absent on legacy snapshots, never inferred.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct MasterRenderBinding {
    pub slot_id: String,
    pub target: SlotRenderTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export)]
pub enum SlotRenderTarget {
    Clip {
        scene_id: String,
        clip_id: String,
    },
    Overlay {
        scene_id: String,
        #[ts(type = "number")]
        start_ticks: i64,
        #[ts(type = "number")]
        end_ticks: i64,
        rect: PlacementRect,
        z_index: u16,
        text_style: Option<RenderTextStyle>,
    },
}

/// Coordinates in 1/10000 of the output canvas, all supplied explicitly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct PlacementRect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct RenderTextStyle {
    pub font_id: String,
    pub font_sha256: String,
    pub font_size_px: u16,
    pub line_height_px: u16,
    pub max_lines: u16,
    pub color_rgba: [u8; 4],
    pub alignment: TextAlignment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TextAlignment {
    Left,
    Center,
    Right,
}
