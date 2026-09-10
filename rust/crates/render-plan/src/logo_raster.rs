use image::{DynamicImage, Limits, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use ts_rs::TS;

pub const MAX_LOGO_BYTES: usize = 8 * 1024 * 1024;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogoProbe {
    pub width: u32,
    pub height: u32,
    pub sha256: String,
    pub byte_length: u32,
}

fn decode_png(bytes: &[u8]) -> Result<RgbaImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_LOGO_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
    {
        return Err("logo_png_required_or_byte_limit".into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(2048);
    limits.max_image_height = Some(2048);
    limits.max_alloc = Some(32 * 1024 * 1024);
    let decoder = image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes), limits)
        .map_err(|_| "invalid_or_oversized_logo_png")?;
    if decoder.is_apng().map_err(|_| "invalid_logo_png")? {
        return Err("animated_logo_not_supported".into());
    }
    DynamicImage::from_decoder(decoder)
        .map(|image| image.to_rgba8())
        .map_err(|_| "invalid_or_oversized_logo_png".into())
}
pub fn probe_logo_png(bytes: &[u8]) -> Result<LogoProbe, String> {
    let image = decode_png(bytes)?;
    Ok(LogoProbe {
        width: image.width(),
        height: image.height(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u32,
    })
}

/// Explicit contain policy inside the authored rectangle; no change to that rectangle.
pub fn raster_logo_png(
    bytes: &[u8],
    expected_hash: &str,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 4_194_304 {
        return Err("logo_raster_budget".into());
    }
    if format!("{:x}", Sha256::digest(bytes)) != expected_hash {
        return Err("logo_checksum_mismatch".into());
    }
    let source = decode_png(bytes)?;
    let (scaled_width, scaled_height) = if u64::from(width) * u64::from(source.height())
        <= u64::from(height) * u64::from(source.width())
    {
        (
            width,
            ((u64::from(source.height()) * u64::from(width) / u64::from(source.width())) as u32)
                .max(1),
        )
    } else {
        (
            ((u64::from(source.width()) * u64::from(height) / u64::from(source.height())) as u32)
                .max(1),
            height,
        )
    };
    let scaled = image::imageops::resize(
        &source,
        scaled_width,
        scaled_height,
        image::imageops::FilterType::Triangle,
    );
    let mut output = RgbaImage::new(width, height);
    image::imageops::overlay(
        &mut output,
        &scaled,
        i64::from((width - scaled_width) / 2),
        i64::from((height - scaled_height) / 2),
    );
    Ok(output.into_raw())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageFormat;
    #[test]
    fn png_hash_probe_and_contain_are_real_and_bounded() {
        let source = RgbaImage::from_pixel(4, 2, image::Rgba([255, 40, 10, 255]));
        let mut bytes = Cursor::new(Vec::new());
        source.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let bytes = bytes.into_inner();
        let probe = probe_logo_png(&bytes).unwrap();
        assert_eq!((probe.width, probe.height), (4, 2));
        let pixels = raster_logo_png(&bytes, &probe.sha256, 8, 8).unwrap();
        assert_eq!(pixels[3], 0);
        assert_eq!(pixels[(2 * 8) * 4 + 3], 255);
        assert_eq!(
            pixels,
            raster_logo_png(&bytes, &probe.sha256, 8, 8).unwrap()
        );
        assert!(raster_logo_png(&bytes, &"0".repeat(64), 8, 8).is_err());
        assert!(probe_logo_png(b"fake-logo").is_err());
        assert!(raster_logo_png(&bytes, &probe.sha256, 32768, 32768).is_err());
    }
}
