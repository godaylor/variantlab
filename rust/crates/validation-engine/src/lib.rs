use std::collections::BTreeSet;

use studio_model::{BrandKit, CropOverride, DeliveryProfile, SafeArea};
use thiserror::Error;

pub const MAX_FORMAT_PROFILES: usize = 6;
pub const MAX_LOCALE_PROFILES: usize = 12;
pub const MAX_DELIVERY_PROFILES: usize = 24;
pub const MAX_VARIANT_CELLS: usize = 100;
pub const MAX_DETACHED_CELLS: usize = 20;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("delivery profile IDs and names must not be empty")]
    EmptyProfileIdentity,
    #[error("delivery profile canvas must be 16:9, 1:1 or 9:16")]
    UnsupportedCanvas,
    #[error("safe-area insets must leave a visible canvas region")]
    InvalidSafeArea,
    #[error("delivery profile locale must not be empty")]
    EmptyLocale,
    #[error("crop scale must be between 1.0x and 3.0x")]
    InvalidCropScale,
    #[error("crop position must stay inside the allowlisted geometry range")]
    InvalidCropPosition,
    #[error("brand kit identity, version and fingerprint must be valid")]
    InvalidBrandKitIdentity,
    #[error("brand kit provenance must include source, revision and a SHA-256 asset hash")]
    InvalidBrandKitProvenance,
    #[error("brand kit contains an invalid or duplicate declarative rule")]
    InvalidBrandRule,
}

pub fn validate_delivery_profile(profile: &DeliveryProfile) -> Result<(), ValidationError> {
    if profile.id.trim().is_empty() || profile.name.trim().is_empty() {
        return Err(ValidationError::EmptyProfileIdentity);
    }
    let width = u64::from(profile.canvas.width);
    let height = u64::from(profile.canvas.height);
    let supported = width * 9 == height * 16 || width == height || width * 16 == height * 9;
    if width == 0 || height == 0 || !supported {
        return Err(ValidationError::UnsupportedCanvas);
    }
    validate_safe_area(&profile.safe_area)?;
    if profile.locale.trim().is_empty() {
        return Err(ValidationError::EmptyLocale);
    }
    Ok(())
}

pub fn validate_brand_kit(kit: &BrandKit) -> Result<(), ValidationError> {
    if kit.id.trim().is_empty()
        || kit.name.trim().is_empty()
        || kit.version == 0
        || (!kit.fingerprint.is_empty() && !is_sha256(&kit.fingerprint))
    {
        return Err(ValidationError::InvalidBrandKitIdentity);
    }
    if kit.provenance.source.trim().is_empty()
        || kit.provenance.revision.trim().is_empty()
        || !is_sha256(&kit.provenance.asset_hash)
    {
        return Err(ValidationError::InvalidBrandKitProvenance);
    }
    if kit.minimum_text_size_px == 0
        || has_empty_or_duplicate(&kit.allowed_color_tokens)
        || has_empty_or_duplicate(&kit.allowed_font_ids)
    {
        return Err(ValidationError::InvalidBrandRule);
    }
    let mut ids = BTreeSet::new();
    for region in &kit.custom_safe_regions {
        if region.id.trim().is_empty()
            || !ids.insert(region.id.as_str())
            || validate_safe_area(&region.safe_area).is_err()
        {
            return Err(ValidationError::InvalidBrandRule);
        }
    }
    if let Some(duration) = &kit.master_duration
        && (duration.minimum_ticks < 0 || duration.maximum_ticks < duration.minimum_ticks)
    {
        return Err(ValidationError::InvalidBrandRule);
    }
    Ok(())
}

pub fn validate_crop(crop: &CropOverride) -> Result<(), ValidationError> {
    if !(10_000..=30_000).contains(&crop.scale_basis_points) {
        return Err(ValidationError::InvalidCropScale);
    }
    if !(-10_000..=10_000).contains(&crop.x_basis_points)
        || !(-10_000..=10_000).contains(&crop.y_basis_points)
    {
        return Err(ValidationError::InvalidCropPosition);
    }
    Ok(())
}

fn validate_safe_area(safe: &SafeArea) -> Result<(), ValidationError> {
    if u32::from(safe.left_basis_points) + u32::from(safe.right_basis_points) >= 10_000
        || u32::from(safe.top_basis_points) + u32::from(safe.bottom_basis_points) >= 10_000
    {
        return Err(ValidationError::InvalidSafeArea);
    }
    Ok(())
}

fn has_empty_or_duplicate(values: &[String]) -> bool {
    let mut unique = BTreeSet::new();
    values
        .iter()
        .any(|value| value.trim().is_empty() || !unique.insert(value.as_str()))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_model::{CanvasSpec, SafeArea};

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
            layout_constraints: vec!["safe_area".into()],
            version: 1,
            locale_profile_id: None,
        }
    }

    #[test]
    fn accepts_finite_formats_and_allowlisted_crop() {
        let mut candidate = profile();
        assert_eq!(validate_delivery_profile(&candidate), Ok(()));
        candidate.canvas.width = 1920;
        candidate.canvas.height = 1080;
        assert_eq!(validate_delivery_profile(&candidate), Ok(()));
        candidate.canvas.width = 1080;
        candidate.canvas.height = 1080;
        assert_eq!(validate_delivery_profile(&candidate), Ok(()));
        assert_eq!(validate_crop(&CropOverride::default()), Ok(()));
    }

    #[test]
    fn rejects_arbitrary_canvas_and_out_of_range_crop() {
        let mut invalid = profile();
        invalid.canvas.width = 1200;
        invalid.canvas.height = 900;
        assert_eq!(
            validate_delivery_profile(&invalid),
            Err(ValidationError::UnsupportedCanvas)
        );
        assert_eq!(
            validate_crop(&CropOverride {
                x_basis_points: 10_001,
                ..CropOverride::default()
            }),
            Err(ValidationError::InvalidCropPosition)
        );
    }
}
