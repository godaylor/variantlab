use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

pub const CODEC_POLICY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CodecProviderKind {
    BrowserWebCodecs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ExportPreset {
    WebmVp9Opus,
}

impl ExportPreset {
    pub fn extension(self) -> &'static str {
        match self {
            Self::WebmVp9Opus => "webm",
        }
    }

    pub fn video_codec(self) -> &'static str {
        match self {
            Self::WebmVp9Opus => "vp09.00.10.08",
        }
    }

    pub fn audio_codec(self) -> &'static str {
        match self {
            Self::WebmVp9Opus => "opus",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CodecCapability {
    pub schema_version: u32,
    pub provider: CodecProviderKind,
    pub preset: ExportPreset,
    pub video_supported: bool,
    pub audio_supported: bool,
    pub streaming_sink_supported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StorageCapability {
    #[ts(type = "number")]
    pub available_bytes: u64,
    #[ts(type = "number")]
    pub required_bytes: u64,
    pub opfs_supported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderPreflight {
    pub ready: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CodecPolicyError {
    #[error("codec capability schema {0} is unsupported")]
    UnsupportedSchema(u32),
}

pub fn preflight(
    codec: &CodecCapability,
    storage: &StorageCapability,
) -> Result<RenderPreflight, CodecPolicyError> {
    if codec.schema_version != CODEC_POLICY_SCHEMA_VERSION {
        return Err(CodecPolicyError::UnsupportedSchema(codec.schema_version));
    }
    let mut blockers = Vec::new();
    if !codec.video_supported || !codec.audio_supported {
        blockers.push("unsupported_codec".to_owned());
    }
    if !codec.streaming_sink_supported {
        blockers.push("streaming_sink_unavailable".to_owned());
    }
    if !storage.opfs_supported {
        blockers.push("opfs_unavailable".to_owned());
    }
    if storage.available_bytes < storage.required_bytes {
        blockers.push("out_of_space".to_owned());
    }
    blockers.sort();
    blockers.dedup();
    Ok(RenderPreflight {
        ready: blockers.is_empty(),
        blockers,
        warnings: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codec() -> CodecCapability {
        CodecCapability {
            schema_version: CODEC_POLICY_SCHEMA_VERSION,
            provider: CodecProviderKind::BrowserWebCodecs,
            preset: ExportPreset::WebmVp9Opus,
            video_supported: true,
            audio_supported: true,
            streaming_sink_supported: true,
        }
    }

    #[test]
    fn preflight_returns_typed_sorted_blockers() {
        let result = preflight(
            &CodecCapability {
                video_supported: false,
                ..codec()
            },
            &StorageCapability {
                available_bytes: 2,
                required_bytes: 10,
                opfs_supported: false,
            },
        )
        .unwrap();
        assert!(!result.ready);
        assert_eq!(
            result.blockers,
            vec!["opfs_unavailable", "out_of_space", "unsupported_codec"]
        );
    }

    #[test]
    fn webm_profile_is_patent_conservative_default() {
        assert_eq!(ExportPreset::WebmVp9Opus.extension(), "webm");
        assert_eq!(ExportPreset::WebmVp9Opus.audio_codec(), "opus");
    }
}
