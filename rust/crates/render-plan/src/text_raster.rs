//! Identical bounded text shaping/rasterization for native and WASM. No OS fonts.
use cosmic_text::{
    Align, Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache, Wrap, fontdb,
};
use studio_model::{RenderTextStyle, TextAlignment};

pub const INTER_FONT_ID: &str = "inter-regular-4.1";
pub const INTER_SHA256: &str = "40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82";
const INTER: &[u8] = include_bytes!("../../../../assets/fonts/inter-4.1/Inter-Regular.ttf");

pub fn raster_text(
    text: &str,
    style: &RenderTextStyle,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    if text.is_empty()
        || text.chars().count() > 2000
        || width == 0
        || height == 0
        || width > 3840
        || height > 3840
        || u64::from(width) * u64::from(height) > 4_194_304
    {
        return Err("text_raster_budget".into());
    }
    if style.font_id != INTER_FONT_ID || style.font_sha256 != INTER_SHA256 {
        return Err("pinned_font_unavailable".into());
    }
    if !(1..=512).contains(&style.font_size_px)
        || style.line_height_px < style.font_size_px
        || style.line_height_px > 1024
        || !(1..=100).contains(&style.max_lines)
    {
        return Err("invalid_text_metrics".into());
    }
    let mut db = fontdb::Database::new();
    db.load_font_data(INTER.to_vec());
    let mut fonts = FontSystem::new_with_locale_and_db("en-US".into(), db);
    let mut buffer = Buffer::new(
        &mut fonts,
        Metrics::new(style.font_size_px.into(), style.line_height_px.into()),
    );
    // Layout all bounded input, then reject overflow. Never silently clip/shrink text.
    buffer.set_size(&mut fonts, Some(width as f32), None);
    buffer.set_wrap(&mut fonts, Wrap::WordOrGlyph);
    buffer.set_text(
        &mut fonts,
        text,
        &Attrs::new().family(Family::Name("Inter")),
        Shaping::Advanced,
    );
    let alignment = match style.alignment {
        TextAlignment::Left => Align::Left,
        TextAlignment::Center => Align::Center,
        TextAlignment::Right => Align::Right,
    };
    for line in &mut buffer.lines {
        line.set_align(Some(alignment));
    }
    buffer.shape_until_scroll(&mut fonts, false);
    let runs = buffer.layout_runs().collect::<Vec<_>>();
    if runs.len() > usize::from(style.max_lines)
        || runs
            .iter()
            .any(|run| run.line_top + run.line_height > height as f32 || run.line_w > width as f32)
    {
        return Err("text_does_not_fit".into());
    }
    if runs
        .iter()
        .flat_map(|run| run.glyphs)
        .any(|glyph| glyph.glyph_id == 0)
    {
        return Err("font_glyph_missing".into());
    }
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let [r, g, b, a] = style.color_rgba;
    let mut cache = SwashCache::new();
    buffer.draw(
        &mut fonts,
        &mut cache,
        Color::rgba(r, g, b, a),
        |x, y, w, h, color| {
            for dy in 0..h {
                for dx in 0..w {
                    let (px, py) = (i64::from(x) + i64::from(dx), i64::from(y) + i64::from(dy));
                    if px >= 0 && py >= 0 && px < i64::from(width) && py < i64::from(height) {
                        let offset = (py as usize * width as usize + px as usize) * 4;
                        // All glyphs share one explicit color; coverage combines source-over.
                        let old_alpha = u32::from(pixels[offset + 3]);
                        let alpha = u32::from(color.a())
                            + (old_alpha * (255 - u32::from(color.a())) + 127) / 255;
                        pixels[offset..offset + 4].copy_from_slice(&[r, g, b, alpha as u8]);
                    }
                }
            }
        },
    );
    Ok(pixels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    fn style() -> RenderTextStyle {
        RenderTextStyle {
            font_id: INTER_FONT_ID.into(),
            font_sha256: INTER_SHA256.into(),
            font_size_px: 24,
            line_height_px: 32,
            max_lines: 3,
            color_rgba: [255, 255, 255, 255],
            alignment: TextAlignment::Left,
        }
    }
    #[test]
    fn pinned_font_and_ru_en_raster_are_deterministic() {
        assert_eq!(format!("{:x}", Sha256::digest(INTER)), INTER_SHA256);
        for text in ["VariantLab", "Привет, мир", "<script> & text"] {
            let a = raster_text(text, &style(), 400, 100).unwrap();
            assert!(a.chunks_exact(4).any(|p| p[3] > 0));
            assert_eq!(a, raster_text(text, &style(), 400, 100).unwrap());
        }
    }
    #[test]
    fn unavailable_fonts_overflow_and_unbounded_inputs_are_rejected() {
        let mut missing = style();
        missing.font_sha256 = "0".repeat(64);
        assert_eq!(
            raster_text("Text", &missing, 400, 100).unwrap_err(),
            "pinned_font_unavailable"
        );
        assert_eq!(
            raster_text("Text", &style(), 20, 10).unwrap_err(),
            "text_does_not_fit"
        );
        assert_eq!(
            raster_text(&"a".repeat(2001), &style(), 400, 100).unwrap_err(),
            "text_raster_budget"
        );
    }
}
