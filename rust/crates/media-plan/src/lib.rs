use serde::{Deserialize, Serialize};
use studio_model::TICKS_PER_SECOND;
use thiserror::Error;
use ts_rs::TS;

pub const MEDIA_PLAN_VERSION: u32 = 1;
pub const MAX_IMPORT_BYTES: u64 = 512 * 1024 * 1024 * 1024;
pub const MAX_DURATION_TICKS: i64 = 24 * 60 * 60 * TICKS_PER_SECOND;
pub const MAX_PIXEL_COUNT: u64 = 16_384 * 8_640;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProbeReport {
    pub asset_hash: String,
    #[ts(type = "number")]
    pub byte_length: u64,
    pub declared_mime: String,
    pub detected_mime: String,
    #[ts(type = "number")]
    pub duration_ticks: i64,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub has_video: bool,
    pub has_audio: bool,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub can_decode: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProxyTier {
    pub tier: String,
    pub max_width: u32,
    pub max_height: u32,
    pub video_bitrate: u32,
    pub video_codec: String,
    pub audio_codec: String,
    #[ts(type = "number")]
    pub keyframe_interval_ticks: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WaveformLevelSpec {
    pub level: u32,
    pub samples_per_bucket: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WaveformSpec {
    pub channels: u32,
    pub base_samples_per_bucket: u32,
    pub levels: Vec<WaveformLevelSpec>,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DerivativePlan {
    pub schema_version: u32,
    pub asset_hash: String,
    pub probe_required: bool,
    pub proxy: Option<ProxyTier>,
    pub waveform: Option<WaveformSpec>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MediaPlanError {
    #[error("media hash must be a lowercase SHA-256 hex value")]
    InvalidHash,
    #[error("media file is empty or exceeds the 512 GiB import limit")]
    InvalidByteLength,
    #[error("declared MIME {declared} does not match detected content {detected}")]
    MimeMismatch { declared: String, detected: String },
    #[error("media duration must be positive and no longer than 24 hours")]
    InvalidDuration,
    #[error("media dimensions exceed the decode safety limit")]
    InvalidDimensions,
    #[error("media has neither a video nor an audio track")]
    NoMediaTracks,
    #[error("media frame rate must be a positive rational value")]
    InvalidFrameRate,
    #[error("the browser cannot decode this source; use a supported proxy provider")]
    UnsupportedDecode,
}

pub fn validate_probe(report: &ProbeReport) -> Result<(), MediaPlanError> {
    if report.asset_hash.len() != 64
        || !report
            .asset_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(MediaPlanError::InvalidHash);
    }
    if report.byte_length == 0 || report.byte_length > MAX_IMPORT_BYTES {
        return Err(MediaPlanError::InvalidByteLength);
    }
    if !mime_compatible(&report.declared_mime, &report.detected_mime) {
        return Err(MediaPlanError::MimeMismatch {
            declared: report.declared_mime.clone(),
            detected: report.detected_mime.clone(),
        });
    }
    if report.detected_mime == "image/png" {
        if report.byte_length > 8 * 1024 * 1024 {
            return Err(MediaPlanError::InvalidByteLength);
        }
        if report.width == 0 || report.height == 0 || report.width > 2048 || report.height > 2048 {
            return Err(MediaPlanError::InvalidDimensions);
        }
        if report.duration_ticks != 0 || report.has_video || report.has_audio || report.fps_num != 0
        {
            return Err(MediaPlanError::InvalidDuration);
        }
        return if report.can_decode {
            Ok(())
        } else {
            Err(MediaPlanError::UnsupportedDecode)
        };
    }
    if report.duration_ticks <= 0 || report.duration_ticks > MAX_DURATION_TICKS {
        return Err(MediaPlanError::InvalidDuration);
    }
    if report.has_video {
        if report.fps_num == 0 || report.fps_den == 0 {
            return Err(MediaPlanError::InvalidFrameRate);
        }
        if report.width == 0
            || report.height == 0
            || u64::from(report.width) * u64::from(report.height) > MAX_PIXEL_COUNT
        {
            return Err(MediaPlanError::InvalidDimensions);
        }
    }
    if !report.has_video && !report.has_audio {
        return Err(MediaPlanError::NoMediaTracks);
    }
    if !report.can_decode {
        return Err(MediaPlanError::UnsupportedDecode);
    }
    Ok(())
}

pub fn plan_derivatives(report: &ProbeReport) -> Result<DerivativePlan, MediaPlanError> {
    validate_probe(report)?;
    let mut warnings = Vec::new();
    let proxy = report.has_video.then(|| {
        if report.width <= 1280 && report.height <= 720 {
            warnings
                .push("Source is already preview-sized; proxy remains seek-optimized".to_owned());
        }
        ProxyTier {
            tier: "preview_720p".to_owned(),
            max_width: 1280,
            max_height: 720,
            video_bitrate: 2_500_000,
            video_codec: "vp9".to_owned(),
            audio_codec: "opus".to_owned(),
            keyframe_interval_ticks: 2 * TICKS_PER_SECOND,
        }
    });
    let waveform = report.has_audio.then(|| WaveformSpec {
        channels: 1,
        base_samples_per_bucket: 4096,
        levels: (0..12)
            .map(|level| WaveformLevelSpec {
                level,
                samples_per_bucket: 4096u32.saturating_mul(1u32 << level),
            })
            .collect(),
        values: vec!["min".to_owned(), "max".to_owned(), "rms".to_owned()],
    });
    Ok(DerivativePlan {
        schema_version: MEDIA_PLAN_VERSION,
        asset_hash: report.asset_hash.clone(),
        probe_required: true,
        proxy,
        waveform,
        warnings,
    })
}

fn mime_compatible(declared: &str, detected: &str) -> bool {
    let declared = declared
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let detected = detected.trim().to_ascii_lowercase();
    declared.is_empty()
        || declared == "application/octet-stream"
        || declared == detected
        || (declared == "audio/wav" && detected == "audio/wave")
        || (declared == "video/x-matroska" && detected == "video/webm")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> ProbeReport {
        ProbeReport {
            asset_hash: "a".repeat(64),
            byte_length: 1_024,
            declared_mime: "video/webm".into(),
            detected_mime: "video/webm".into(),
            duration_ticks: 2 * 60 * 60 * TICKS_PER_SECOND,
            width: 3840,
            height: 2160,
            fps_num: 30_000,
            fps_den: 1_001,
            has_video: true,
            has_audio: true,
            video_codec: Some("vp9".into()),
            audio_codec: Some("opus".into()),
            can_decode: true,
        }
    }

    #[test]
    fn long_4k_source_plans_seekable_proxy_and_waveform_pyramid() {
        let plan = plan_derivatives(&report()).unwrap();
        assert_eq!(plan.proxy.unwrap().tier, "preview_720p");
        assert_eq!(plan.waveform.unwrap().levels.len(), 12);
    }

    #[test]
    fn rejects_mime_content_mismatch() {
        let mut value = report();
        value.declared_mime = "video/mp4".into();
        assert!(matches!(
            validate_probe(&value),
            Err(MediaPlanError::MimeMismatch { .. })
        ));
    }

    #[test]
    fn rejects_zero_and_huge_duration() {
        let mut value = report();
        value.duration_ticks = 0;
        assert_eq!(validate_probe(&value), Err(MediaPlanError::InvalidDuration));
        value.duration_ticks = MAX_DURATION_TICKS + 1;
        assert_eq!(validate_probe(&value), Err(MediaPlanError::InvalidDuration));
    }

    #[test]
    fn still_png_has_no_invented_timing_or_derivatives() {
        let mut value = report();
        value.declared_mime = "image/png".into();
        value.detected_mime = "image/png".into();
        value.width = 32;
        value.height = 16;
        value.duration_ticks = 0;
        value.fps_num = 0;
        value.has_video = false;
        value.has_audio = false;
        value.video_codec = None;
        value.audio_codec = None;
        let plan = plan_derivatives(&value).unwrap();
        assert!(plan.proxy.is_none() && plan.waveform.is_none());
        value.width = 2049;
        assert_eq!(
            validate_probe(&value),
            Err(MediaPlanError::InvalidDimensions)
        );
        value.width = 32;
        value.duration_ticks = 1;
        assert_eq!(validate_probe(&value), Err(MediaPlanError::InvalidDuration));
    }
}
