use crate::{RenderManifest, RenderPlanError, manifest_checksum};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use studio_model::{StudioState, TICKS_PER_SECOND, snapshot_hash};
use thiserror::Error;
use ts_rs::TS;

pub const RENDER_PACKAGE_SCHEMA_VERSION: u32 = 1;
pub const CAMPAIGN_BUNDLE_SCHEMA_VERSION: u32 = 1;
pub const MAX_BUNDLE_ENTRIES: usize = 512;
pub const MAX_BUNDLE_EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_EXPANSION_RATIO: u64 = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DestinationKind {
    BrowserDownload,
    UserGrantedDirectory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NamingContext {
    pub campaign: String,
    pub creative_set: String,
    pub profile: String,
    pub cell: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderTiming {
    #[ts(type = "number")]
    pub duration_ticks: i64,
    #[ts(type = "number")]
    pub frame_count: u64,
    #[ts(type = "number")]
    pub audio_sample_count: u64,
    #[ts(type = "number")]
    pub trailing_frame_duration_ticks: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeliverableArtifact {
    pub cell_id: String,
    pub campaign_revision: u32,
    pub preset: String,
    pub filename: String,
    pub media_type: String,
    #[ts(type = "number")]
    pub byte_length: u64,
    pub sha256: String,
    pub render_manifest_sha256: String,
    pub timing: RenderTiming,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeliverableManifest {
    pub schema_version: u32,
    pub campaign_id: String,
    pub campaign_revision: u32,
    pub master_sequence_id: String,
    pub preset: String,
    pub destination: DestinationKind,
    pub artifacts: Vec<DeliverableArtifact>,
    pub provenance: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BundleEntry {
    pub path: String,
    #[ts(type = "number")]
    pub compressed_bytes: u64,
    #[ts(type = "number")]
    pub expanded_bytes: u64,
    pub sha256: String,
    pub provenance: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct BundleEntryReceipt {
    pub path: String,
    #[ts(type = "number")]
    pub expanded_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EditableCampaignBundle {
    pub schema_version: u32,
    pub snapshot_json: String,
    pub snapshot_sha256: String,
    pub entries: Vec<BundleEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StagedCampaignImport {
    pub new_campaign_id: String,
    pub snapshot_sha256: String,
    pub asset_hashes: Vec<String>,
    pub imported_state_json: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PackageError {
    #[error("naming template contains an unknown token: {0}")]
    UnknownToken(String),
    #[error("filename is empty or unsafe")]
    UnsafeFilename,
    #[error("campaign bundle schema {0} is unsupported")]
    UnknownBundleSchema(u32),
    #[error("campaign bundle entry count exceeds {MAX_BUNDLE_ENTRIES}")]
    TooManyEntries,
    #[error("campaign bundle expanded size exceeds the limit")]
    ExpansionLimit,
    #[error("campaign bundle contains an unsafe path")]
    UnsafePath,
    #[error("campaign bundle contains a duplicate canonical path")]
    DuplicatePath,
    #[error("campaign bundle contains a missing or corrupt asset")]
    CorruptAsset,
    #[error("campaign bundle snapshot is invalid")]
    InvalidSnapshot,
    #[error("campaign bundle must not contain secrets or signed URLs")]
    SecretMaterial,
    #[error("render manifest failed: {0}")]
    Render(String),
    #[error("deliverable artifact receipt is invalid")]
    InvalidArtifact,
}

pub fn render_timing(manifest: &RenderManifest) -> RenderTiming {
    let duration = manifest.sequence_duration_ticks.max(0) as u64;
    let frame_den = TICKS_PER_SECOND as u64 * manifest.fps_den as u64;
    let frame_num = duration.saturating_mul(manifest.fps_num as u64);
    let frame_count = if frame_num == 0 {
        0
    } else {
        frame_num.div_ceil(frame_den)
    };
    let frame_ticks_num = TICKS_PER_SECOND as i128 * manifest.fps_den as i128;
    let covered_ticks = if frame_count == 0 {
        0
    } else {
        ((frame_count - 1) as i128 * frame_ticks_num / manifest.fps_num as i128) as i64
    };
    RenderTiming {
        duration_ticks: manifest.sequence_duration_ticks,
        frame_count,
        audio_sample_count: duration,
        trailing_frame_duration_ticks: (manifest.sequence_duration_ticks - covered_ticks).max(0),
    }
}

pub fn render_filename(template: &str, context: &NamingContext) -> Result<String, PackageError> {
    let values = [
        ("campaign", context.campaign.as_str()),
        ("creative_set", context.creative_set.as_str()),
        ("profile", context.profile.as_str()),
        ("cell", context.cell.as_str()),
    ];
    let mut rendered = template.to_owned();
    let mut cursor = 0;
    while let Some(start) = rendered[cursor..].find('{') {
        let start = cursor + start;
        let Some(end_rel) = rendered[start..].find('}') else {
            return Err(PackageError::UnknownToken(rendered[start..].to_owned()));
        };
        let end = start + end_rel;
        let token = rendered[start + 1..end].to_owned();
        let Some((_, value)) = values.iter().find(|(name, _)| *name == token) else {
            return Err(PackageError::UnknownToken(token));
        };
        rendered.replace_range(start..=end, value);
        cursor = start + value.len();
    }
    normalize_filename(&rendered)
}

pub fn normalize_filename(value: &str) -> Result<String, PackageError> {
    if value.contains("..") || value.contains('/') || value.contains('\\') {
        return Err(PackageError::UnsafeFilename);
    }
    let normalized = value
        .trim()
        .trim_end_matches(['.', ' '])
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>();
    let stem = normalized
        .split('.')
        .next()
        .unwrap_or_default()
        .to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if normalized.is_empty() || reserved {
        return Err(PackageError::UnsafeFilename);
    }
    Ok(normalized)
}

pub fn unique_filenames(names: &[String]) -> Vec<String> {
    let mut seen = BTreeMap::<String, u32>::new();
    names
        .iter()
        .map(|name| {
            let key = name.to_lowercase();
            let count = seen.entry(key).or_default();
            *count += 1;
            if *count == 1 {
                return name.clone();
            }
            let (stem, extension) = name.rsplit_once('.').unwrap_or((name, ""));
            if extension.is_empty() {
                format!("{stem}-{}", *count)
            } else {
                format!("{stem}-{}.{}", *count, extension)
            }
        })
        .collect()
}

pub fn build_artifact(
    manifest: &RenderManifest,
    cell_id: String,
    preset: String,
    filename: String,
    media_type: String,
    bytes: &[u8],
) -> Result<DeliverableArtifact, PackageError> {
    build_artifact_receipt(
        manifest,
        cell_id,
        preset,
        filename,
        media_type,
        bytes.len() as u64,
        hex_digest(bytes),
    )
}

pub fn build_artifact_receipt(
    manifest: &RenderManifest,
    cell_id: String,
    preset: String,
    filename: String,
    media_type: String,
    byte_length: u64,
    sha256: String,
) -> Result<DeliverableArtifact, PackageError> {
    if cell_id.trim().is_empty()
        || preset.trim().is_empty()
        || filename.trim().is_empty()
        || media_type.trim().is_empty()
        || byte_length == 0
        || sha256.len() != 64
    {
        return Err(PackageError::InvalidArtifact);
    }
    let render_manifest_sha256 = manifest_checksum(manifest)
        .map_err(|error: RenderPlanError| PackageError::Render(error.to_string()))?;
    Ok(DeliverableArtifact {
        cell_id,
        campaign_revision: manifest.campaign_revision,
        preset,
        filename,
        media_type,
        byte_length,
        sha256,
        render_manifest_sha256,
        timing: render_timing(manifest),
    })
}

pub fn normalize_deliverable_manifest(
    mut manifest: DeliverableManifest,
) -> Result<DeliverableManifest, PackageError> {
    let mut cell_ids = BTreeSet::new();
    if manifest.schema_version != RENDER_PACKAGE_SCHEMA_VERSION
        || manifest.campaign_id.trim().is_empty()
        || manifest.master_sequence_id.trim().is_empty()
        || manifest.preset.trim().is_empty()
        || manifest.artifacts.is_empty()
        || manifest.artifacts.iter().any(|artifact| {
            artifact.sha256.len() != 64
                || artifact.render_manifest_sha256.len() != 64
                || artifact.campaign_revision != manifest.campaign_revision
                || artifact.preset != manifest.preset
                || !cell_ids.insert(artifact.cell_id.clone())
        })
    {
        return Err(PackageError::InvalidArtifact);
    }
    manifest
        .artifacts
        .sort_by(|left, right| left.cell_id.cmp(&right.cell_id));
    Ok(manifest)
}

pub fn validate_bundle(
    bundle: &EditableCampaignBundle,
    entry_bytes: &BTreeMap<String, Vec<u8>>,
    new_campaign_id: &str,
) -> Result<StagedCampaignImport, PackageError> {
    let receipts = entry_bytes
        .iter()
        .map(|(path, bytes)| BundleEntryReceipt {
            path: path.clone(),
            expanded_bytes: bytes.len() as u64,
            sha256: hex_digest(bytes),
        })
        .collect::<Vec<_>>();
    validate_bundle_receipts(bundle, &receipts, new_campaign_id)
}

pub fn validate_bundle_receipts(
    bundle: &EditableCampaignBundle,
    receipts: &[BundleEntryReceipt],
    new_campaign_id: &str,
) -> Result<StagedCampaignImport, PackageError> {
    if bundle.schema_version != CAMPAIGN_BUNDLE_SCHEMA_VERSION {
        return Err(PackageError::UnknownBundleSchema(bundle.schema_version));
    }
    if bundle.entries.len() > MAX_BUNDLE_ENTRIES {
        return Err(PackageError::TooManyEntries);
    }
    if new_campaign_id.trim().is_empty() {
        return Err(PackageError::InvalidSnapshot);
    }
    let contains_secret = |value: &str| {
        let lower = value.to_ascii_lowercase();
        lower.contains("signed_url")
            || lower.contains("session_secret")
            || lower.contains("authorization")
    };
    if contains_secret(&bundle.snapshot_json)
        || bundle
            .entries
            .iter()
            .any(|entry| contains_secret(&entry.path) || contains_secret(&entry.provenance))
    {
        return Err(PackageError::SecretMaterial);
    }
    let mut state: StudioState =
        serde_json::from_str(&bundle.snapshot_json).map_err(|_| PackageError::InvalidSnapshot)?;
    let actual_snapshot = snapshot_hash(&state).map_err(|_| PackageError::InvalidSnapshot)?;
    if actual_snapshot != bundle.snapshot_sha256 {
        return Err(PackageError::InvalidSnapshot);
    }
    let mut paths = BTreeSet::new();
    let mut expanded_total = 0_u64;
    let mut asset_hashes = Vec::new();
    for entry in &bundle.entries {
        let path = normalize_bundle_path(&entry.path)?;
        if !paths.insert(path.to_lowercase()) {
            return Err(PackageError::DuplicatePath);
        }
        expanded_total = expanded_total.saturating_add(entry.expanded_bytes);
        if expanded_total > MAX_BUNDLE_EXPANDED_BYTES
            || (entry.compressed_bytes > 0
                && entry.expanded_bytes / entry.compressed_bytes.max(1) > MAX_EXPANSION_RATIO)
        {
            return Err(PackageError::ExpansionLimit);
        }
        let Some(receipt) = receipts.iter().find(|receipt| receipt.path == entry.path) else {
            return Err(PackageError::CorruptAsset);
        };
        if receipt.expanded_bytes != entry.expanded_bytes || receipt.sha256 != entry.sha256 {
            return Err(PackageError::CorruptAsset);
        }
        if entry.provenance.trim().is_empty() {
            return Err(PackageError::CorruptAsset);
        }
        asset_hashes.push(entry.sha256.clone());
    }
    state.campaign.id = new_campaign_id.to_owned();
    asset_hashes.sort();
    asset_hashes.dedup();
    let imported_state_json =
        serde_json::to_string(&state).map_err(|_| PackageError::InvalidSnapshot)?;
    Ok(StagedCampaignImport {
        new_campaign_id: state.campaign.id,
        snapshot_sha256: bundle.snapshot_sha256.clone(),
        asset_hashes,
        imported_state_json,
    })
}

fn normalize_bundle_path(path: &str) -> Result<String, PackageError> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path.contains(':')
    {
        return Err(PackageError::UnsafePath);
    }
    Ok(path.to_owned())
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_manifest;
    use studio_model::{
        CanvasSpec, CreateCampaignInput, DeliveryProfile, SafeArea, Scene, SceneInclusion,
        Timeline, canonical_snapshot, create_campaign,
    };
    use variant_engine::create_delivery_profile;

    fn state() -> StudioState {
        let mut state = create_campaign(CreateCampaignInput {
            campaign_id: "campaign-1".into(),
            campaign_name: "Launch".into(),
            master_sequence_id: "sequence-1".into(),
            created_at: "2026-09-03T00:00:00Z".into(),
            scenes: vec![
                Scene {
                    id: "scene-a".into(),
                    name: "A".into(),
                    created_at: "t0".into(),
                    updated_at: "t0".into(),
                    timeline: Some(Timeline {
                        duration_ticks: 48_000,
                        ..Default::default()
                    }),
                },
                Scene {
                    id: "scene-b".into(),
                    name: "B".into(),
                    created_at: "t0".into(),
                    updated_at: "t0".into(),
                    timeline: Some(Timeline {
                        duration_ticks: 24_000,
                        ..Default::default()
                    }),
                },
                Scene {
                    id: "scene-c".into(),
                    name: "C".into(),
                    created_at: "t0".into(),
                    updated_at: "t0".into(),
                    timeline: Some(Timeline {
                        duration_ticks: 48_000,
                        ..Default::default()
                    }),
                },
            ],
            imported_from: None,
        })
        .unwrap();
        state.campaign.scene_inclusions.push(SceneInclusion {
            scene_id: "scene-b".into(),
            included: false,
        });
        create_delivery_profile(
            &mut state.campaign,
            DeliveryProfile {
                id: "profile".into(),
                name: "Vertical".into(),
                canvas: CanvasSpec {
                    width: 1080,
                    height: 1920,
                },
                safe_area: SafeArea {
                    top_basis_points: 0,
                    right_basis_points: 0,
                    bottom_basis_points: 0,
                    left_basis_points: 0,
                },
                locale: "en".into(),
                layout_constraints: vec![],
                version: 1,
                locale_profile_id: None,
            },
            "cell".into(),
        )
        .unwrap();
        state
    }

    #[test]
    fn multi_scene_timing_excludes_scene_without_reordering() {
        let state = state();
        let manifest = build_manifest(&state, "cell").unwrap();
        assert_eq!(
            manifest
                .scenes
                .iter()
                .map(|scene| scene.scene_id.as_str())
                .collect::<Vec<_>>(),
            vec!["scene-a", "scene-b", "scene-c"]
        );
        assert_eq!(
            manifest
                .scenes
                .iter()
                .map(|scene| scene.included)
                .collect::<Vec<_>>(),
            vec![true, false, true]
        );
        assert_eq!(manifest.sequence_duration_ticks, 96_000);
        assert_eq!(render_timing(&manifest).audio_sample_count, 96_000);
        assert_eq!(render_timing(&manifest).frame_count, 60);
    }

    #[test]
    fn naming_is_deterministic_unicode_safe_and_collision_aware() {
        let context = NamingContext {
            campaign: "Запуск".into(),
            creative_set: "Hook A".into(),
            profile: "9x16".into(),
            cell: "cell".into(),
        };
        let name = render_filename("{campaign}_{creative_set}_{profile}.webm", &context).unwrap();
        assert_eq!(name, "Запуск_Hook A_9x16.webm");
        assert_eq!(
            unique_filenames(&[name.clone(), name.clone()]),
            vec![name.clone(), "Запуск_Hook A_9x16-2.webm".to_owned()]
        );
        assert_eq!(
            normalize_filename("../escape.webm"),
            Err(PackageError::UnsafeFilename)
        );
        assert_eq!(
            normalize_filename("CON.webm"),
            Err(PackageError::UnsafeFilename)
        );
    }

    #[test]
    fn editable_bundle_round_trip_is_atomic_and_rejects_corruption() {
        let state = state();
        let snapshot_json = canonical_snapshot(&state).unwrap();
        let snapshot_sha256 = snapshot_hash(&state).unwrap();
        let bytes = b"owned-fixture".to_vec();
        let entry = BundleEntry {
            path: "media/original.bin".into(),
            compressed_bytes: bytes.len() as u64,
            expanded_bytes: bytes.len() as u64,
            sha256: hex_digest(&bytes),
            provenance: "repository-generated".into(),
        };
        let bundle = EditableCampaignBundle {
            schema_version: CAMPAIGN_BUNDLE_SCHEMA_VERSION,
            snapshot_json,
            snapshot_sha256: snapshot_sha256.clone(),
            entries: vec![entry.clone()],
        };
        let files = BTreeMap::from([(entry.path.clone(), bytes.clone())]);
        let staged = validate_bundle(&bundle, &files, "campaign-imported").unwrap();
        assert_eq!(staged.snapshot_sha256, snapshot_sha256);
        let corrupt = BTreeMap::from([(entry.path, b"corrupt".to_vec())]);
        assert_eq!(
            validate_bundle(&bundle, &corrupt, "partial-must-not-exist"),
            Err(PackageError::CorruptAsset)
        );
    }

    #[test]
    fn bundle_rejects_unknown_schema_and_traversal() {
        let state = state();
        let snapshot_json = canonical_snapshot(&state).unwrap();
        let snapshot_sha256 = snapshot_hash(&state).unwrap();
        let mut bundle = EditableCampaignBundle {
            schema_version: 9,
            snapshot_json,
            snapshot_sha256,
            entries: vec![],
        };
        assert_eq!(
            validate_bundle(&bundle, &BTreeMap::new(), "new"),
            Err(PackageError::UnknownBundleSchema(9))
        );
        bundle.schema_version = CAMPAIGN_BUNDLE_SCHEMA_VERSION;
        bundle.entries = vec![BundleEntry {
            path: "../secret".into(),
            compressed_bytes: 1,
            expanded_bytes: 1,
            sha256: "00".into(),
            provenance: "fixture".into(),
        }];
        assert_eq!(
            validate_bundle(&bundle, &BTreeMap::new(), "new"),
            Err(PackageError::UnsafePath)
        );
    }
    #[test]
    fn deliverable_manifest_rejects_mixed_revisions_presets_and_duplicate_cells() {
        let manifest = build_manifest(&state(), "cell").unwrap();
        let artifact = build_artifact_receipt(
            &manifest,
            "cell".into(),
            "webm_vp9_opus".into(),
            "cell.webm".into(),
            "video/webm".into(),
            1,
            "a".repeat(64),
        )
        .unwrap();
        assert_eq!(artifact.campaign_revision, manifest.campaign_revision);
        assert_eq!(artifact.preset, "webm_vp9_opus");

        let package = DeliverableManifest {
            schema_version: RENDER_PACKAGE_SCHEMA_VERSION,
            campaign_id: "campaign-1".into(),
            campaign_revision: manifest.campaign_revision,
            master_sequence_id: manifest.master_sequence_id.clone(),
            preset: "webm_vp9_opus".into(),
            destination: DestinationKind::BrowserDownload,
            artifacts: vec![artifact.clone()],
            provenance: BTreeMap::new(),
        };
        assert!(normalize_deliverable_manifest(package.clone()).is_ok());

        let mut duplicate = package.clone();
        duplicate.artifacts.push(artifact.clone());
        assert_eq!(
            normalize_deliverable_manifest(duplicate),
            Err(PackageError::InvalidArtifact)
        );
        let mut wrong_revision = package.clone();
        wrong_revision.artifacts[0].campaign_revision += 1;
        assert_eq!(
            normalize_deliverable_manifest(wrong_revision),
            Err(PackageError::InvalidArtifact)
        );
        let mut wrong_preset = package;
        wrong_preset.artifacts[0].preset = "other".into();
        assert_eq!(
            normalize_deliverable_manifest(wrong_preset),
            Err(PackageError::InvalidArtifact)
        );
    }

    #[test]
    fn bundle_rejects_duplicate_paths_entry_and_expansion_limits_and_secrets() {
        let state = state();
        let snapshot_json = canonical_snapshot(&state).unwrap();
        let snapshot_sha256 = snapshot_hash(&state).unwrap();
        let entry = BundleEntry {
            path: "media/A.bin".into(),
            compressed_bytes: 1,
            expanded_bytes: 1,
            sha256: "a".repeat(64),
            provenance: "repository-generated".into(),
        };
        let base = EditableCampaignBundle {
            schema_version: CAMPAIGN_BUNDLE_SCHEMA_VERSION,
            snapshot_json,
            snapshot_sha256,
            entries: vec![entry.clone()],
        };
        let receipt = |path: &str, bytes: u64| BundleEntryReceipt {
            path: path.into(),
            expanded_bytes: bytes,
            sha256: "a".repeat(64),
        };

        let mut duplicate = base.clone();
        let mut second = entry.clone();
        second.path = "media/a.bin".into();
        duplicate.entries.push(second);
        assert_eq!(
            validate_bundle_receipts(
                &duplicate,
                &[receipt("media/A.bin", 1), receipt("media/a.bin", 1)],
                "new"
            ),
            Err(PackageError::DuplicatePath)
        );

        let mut too_many = base.clone();
        too_many.entries = vec![entry.clone(); MAX_BUNDLE_ENTRIES + 1];
        assert_eq!(
            validate_bundle_receipts(&too_many, &[], "new"),
            Err(PackageError::TooManyEntries)
        );

        let mut too_large = base.clone();
        too_large.entries[0].expanded_bytes = MAX_BUNDLE_EXPANDED_BYTES + 1;
        too_large.entries[0].compressed_bytes = MAX_BUNDLE_EXPANDED_BYTES + 1;
        assert_eq!(
            validate_bundle_receipts(
                &too_large,
                &[receipt("media/A.bin", MAX_BUNDLE_EXPANDED_BYTES + 1)],
                "new"
            ),
            Err(PackageError::ExpansionLimit)
        );

        let mut expansion_bomb = base.clone();
        expansion_bomb.entries[0].expanded_bytes = MAX_EXPANSION_RATIO + 1;
        assert_eq!(
            validate_bundle_receipts(
                &expansion_bomb,
                &[receipt("media/A.bin", MAX_EXPANSION_RATIO + 1)],
                "new"
            ),
            Err(PackageError::ExpansionLimit)
        );

        for forbidden in ["signed_url", "session_secret", "authorization"] {
            let mut secret = base.clone();
            secret.entries[0].provenance = format!("{{\"{forbidden}\":\"hidden\"}}");
            assert_eq!(
                validate_bundle_receipts(&secret, &[receipt("media/A.bin", 1)], "new"),
                Err(PackageError::SecretMaterial)
            );
        }
    }
}
