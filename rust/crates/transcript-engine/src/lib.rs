use std::collections::{BTreeMap, BTreeSet};

use studio_model::{
    CaptionCue, CaptionTrack, FontManifest, LocaleProfile, TextDiagnostic, TextDiagnosticKind,
    TranscriptArtifact, TranscriptWord,
};
use thiserror::Error;

pub const MAX_LOCALE_PROFILES: usize = 12;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TranscriptError {
    #[error("transcript identity is incomplete")]
    EmptyIdentity,
    #[error("word timing must be ordered, non-negative and non-overlapping")]
    InvalidWordTiming,
    #[error("caption cue timing must be ordered and contain its words")]
    InvalidCueTiming,
    #[error("transcript model provenance is incomplete")]
    MissingModelProvenance,
    #[error("font manifest provenance is incomplete")]
    MissingFontProvenance,
    #[error("locale profile limit of 12 was reached")]
    LocaleLimit,
    #[error("locale profile {0} already exists")]
    DuplicateLocale(String),
    #[error("font {0} is not present in the pinned manifest")]
    UnknownFont(String),
    #[error("caption cue {0} was not found")]
    CueNotFound(String),
}

pub fn validate_artifact(artifact: &TranscriptArtifact) -> Result<(), TranscriptError> {
    if artifact.id.trim().is_empty() || artifact.asset_hash.trim().is_empty() {
        return Err(TranscriptError::EmptyIdentity);
    }
    if artifact.model.id.trim().is_empty()
        || artifact.model.revision.trim().is_empty()
        || artifact.model.license.trim().is_empty()
    {
        return Err(TranscriptError::MissingModelProvenance);
    }
    let mut previous_end = 0;
    for word in &artifact.words {
        if word.id.trim().is_empty()
            || word.text.trim().is_empty()
            || word.start_ticks < previous_end
            || word.end_ticks <= word.start_ticks
        {
            return Err(TranscriptError::InvalidWordTiming);
        }
        previous_end = word.end_ticks;
    }
    Ok(())
}

pub fn segment_words(
    artifact: &TranscriptArtifact,
    max_words: usize,
    max_duration_ticks: i64,
) -> Result<CaptionTrack, TranscriptError> {
    validate_artifact(artifact)?;
    let mut cues = Vec::new();
    let mut current: Vec<&TranscriptWord> = Vec::new();
    for word in &artifact.words {
        let too_long = current
            .first()
            .is_some_and(|first| word.end_ticks - first.start_ticks > max_duration_ticks.max(1));
        if current.len() >= max_words.max(1) || too_long {
            cues.push(cue_from_words(&artifact.id, cues.len(), &current));
            current.clear();
        }
        current.push(word);
    }
    if !current.is_empty() {
        cues.push(cue_from_words(&artifact.id, cues.len(), &current));
    }
    let track = CaptionTrack {
        id: format!("caption-track-{}", artifact.id),
        source_artifact_id: artifact.id.clone(),
        locale_profile_id: None,
        cues,
        version: 1,
        placement: None,
    };
    validate_track(&track, artifact)?;
    Ok(track)
}

fn cue_from_words(artifact_id: &str, index: usize, words: &[&TranscriptWord]) -> CaptionCue {
    CaptionCue {
        id: format!("{artifact_id}-cue-{index}"),
        start_ticks: words.first().map_or(0, |word| word.start_ticks),
        end_ticks: words.last().map_or(0, |word| word.end_ticks),
        word_ids: words.iter().map(|word| word.id.clone()).collect(),
        text: words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        edited: false,
    }
}

pub fn validate_track(
    track: &CaptionTrack,
    artifact: &TranscriptArtifact,
) -> Result<(), TranscriptError> {
    let words: BTreeMap<_, _> = artifact
        .words
        .iter()
        .map(|word| (word.id.as_str(), word))
        .collect();
    let mut previous_end = 0;
    for cue in &track.cues {
        if cue.id.trim().is_empty()
            || cue.start_ticks < previous_end
            || cue.end_ticks <= cue.start_ticks
            || cue.word_ids.is_empty()
        {
            return Err(TranscriptError::InvalidCueTiming);
        }
        for word_id in &cue.word_ids {
            let Some(word) = words.get(word_id.as_str()) else {
                return Err(TranscriptError::InvalidCueTiming);
            };
            if word.start_ticks < cue.start_ticks || word.end_ticks > cue.end_ticks {
                return Err(TranscriptError::InvalidCueTiming);
            }
        }
        previous_end = cue.end_ticks;
    }
    Ok(())
}

pub fn validate_caption_placement(
    campaign: &studio_model::Campaign,
    track_id: &str,
    placement: &studio_model::CaptionPlacement,
) -> Result<(), String> {
    let track = campaign
        .caption_tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or("caption_track_missing")?;
    let artifact = campaign
        .transcript_artifacts
        .iter()
        .find(|artifact| artifact.id == track.source_artifact_id)
        .ok_or("caption_artifact_missing")?;
    let clip = campaign
        .master_sequence
        .scenes
        .iter()
        .find(|scene| scene.id == placement.scene_id)
        .and_then(|scene| scene.timeline.as_ref())
        .and_then(|timeline| {
            timeline
                .tracks
                .iter()
                .flat_map(|track| &track.clips)
                .find(|clip| clip.id == placement.clip_id)
        })
        .ok_or("caption_source_clip_missing")?;
    if clip.asset_id != artifact.asset_hash {
        return Err("caption_source_asset_mismatch".into());
    }
    let rect = &placement.rect;
    let style = &placement.text_style;
    if rect.width == 0
        || rect.height == 0
        || u32::from(rect.x) + u32::from(rect.width) > 10000
        || u32::from(rect.y) + u32::from(rect.height) > 10000
    {
        return Err("caption_rectangle_out_of_canvas".into());
    }
    if style.font_id.trim().is_empty()
        || style.font_sha256.len() != 64
        || !style
            .font_sha256
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || !(1..=512).contains(&style.font_size_px)
        || style.line_height_px < style.font_size_px
        || style.line_height_px > 1024
        || !(1..=100).contains(&style.max_lines)
    {
        return Err("caption_explicit_pinned_style_required".into());
    }
    Ok(())
}

pub fn edit_caption(
    track: &mut CaptionTrack,
    cue_id: &str,
    text: String,
) -> Result<(), TranscriptError> {
    let cue = track
        .cues
        .iter_mut()
        .find(|cue| cue.id == cue_id)
        .ok_or_else(|| TranscriptError::CueNotFound(cue_id.to_owned()))?;
    if cue.text != text {
        cue.text = text;
        cue.edited = true;
        track.version += 1;
    }
    Ok(())
}

pub fn validate_font_manifest(manifest: &FontManifest) -> Result<(), TranscriptError> {
    if manifest.version == 0
        || manifest.fonts.is_empty()
        || manifest.fonts.iter().any(|font| {
            font.id.trim().is_empty()
                || font.family.trim().is_empty()
                || font.revision.trim().is_empty()
                || font.license.trim().is_empty()
                || font.unicode_ranges.is_empty()
        })
    {
        return Err(TranscriptError::MissingFontProvenance);
    }
    Ok(())
}

pub fn validate_locale_profile(
    existing: &[LocaleProfile],
    profile: &LocaleProfile,
    manifest: &FontManifest,
) -> Result<(), TranscriptError> {
    validate_font_manifest(manifest)?;
    if existing.len() >= MAX_LOCALE_PROFILES {
        return Err(TranscriptError::LocaleLimit);
    }
    if existing.iter().any(|item| item.id == profile.id) {
        return Err(TranscriptError::DuplicateLocale(profile.id.clone()));
    }
    let known: BTreeSet<_> = manifest.fonts.iter().map(|font| font.id.as_str()).collect();
    if let Some(font) = profile
        .font_fallback_ids
        .iter()
        .find(|font| !known.contains(font.as_str()))
    {
        return Err(TranscriptError::UnknownFont(font.clone()));
    }
    Ok(())
}

pub fn diagnose_track(
    track: &CaptionTrack,
    profile: &LocaleProfile,
    manifest: &FontManifest,
    safe_width_px: u32,
) -> Result<Vec<TextDiagnostic>, TranscriptError> {
    validate_font_manifest(manifest)?;
    let fonts: Vec<_> = profile
        .font_fallback_ids
        .iter()
        .filter_map(|id| manifest.fonts.iter().find(|font| font.id == *id))
        .collect();
    let mut diagnostics = Vec::new();
    for cue in &track.cues {
        if let Some(character) = cue.text.chars().find(|character| {
            !character.is_control()
                && !character.is_whitespace()
                && !fonts.iter().any(|font| {
                    font.unicode_ranges.iter().any(|range| {
                        let scalar = u32::from(*character);
                        scalar >= range.start && scalar <= range.end
                    })
                })
        }) {
            diagnostics.push(TextDiagnostic {
                id: format!("{}:missing-glyph:{:x}", cue.id, u32::from(character)),
                kind: TextDiagnosticKind::MissingGlyph,
                cue_id: cue.id.clone(),
                text_slot_id: format!("caption:{}", cue.id),
                message: format!(
                    "No pinned fallback font covers U+{:04X}",
                    u32::from(character)
                ),
                fix: "Add a licensed font with the required Unicode range".to_owned(),
            });
        }
        let width = cue.text.chars().count() as u32 * profile.caption_style.font_size_px * 3 / 5;
        if width > safe_width_px.saturating_mul(profile.caption_style.max_lines) {
            diagnostics.push(TextDiagnostic {
                id: format!("{}:overflow", cue.id),
                kind: TextDiagnosticKind::Overflow,
                cue_id: cue.id.clone(),
                text_slot_id: format!("caption:{}", cue.id),
                message: "Caption exceeds the safe-area line capacity".to_owned(),
                fix: "Shorten the caption or select a smaller permitted size".to_owned(),
            });
        }
        let duration_milli =
            ((cue.end_ticks - cue.start_ticks).max(1) as u64 * 1000 / 48_000) as u32;
        let speed_milli = cue.text.chars().count() as u32 * 1_000_000 / duration_milli.max(1);
        if speed_milli > profile.caption_style.max_chars_per_second * 1000 {
            diagnostics.push(TextDiagnostic {
                id: format!("{}:readability", cue.id),
                kind: TextDiagnosticKind::Readability,
                cue_id: cue.id.clone(),
                text_slot_id: format!("caption:{}", cue.id),
                message: "Caption reading speed exceeds the locale limit".to_owned(),
                fix: "Shorten the copy or split it at a word boundary".to_owned(),
            });
        }
    }
    diagnostics.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_model::{CaptionStyle, FontFace, ModelProvenance, UnicodeRange};

    fn artifact() -> TranscriptArtifact {
        TranscriptArtifact {
            id: "transcript-1".into(),
            asset_hash: "a".repeat(64),
            locale: "en-US".into(),
            words: vec![
                TranscriptWord {
                    id: "w1".into(),
                    text: "Create".into(),
                    start_ticks: 0,
                    end_ticks: 20_000,
                    confidence_milli: 990,
                },
                TranscriptWord {
                    id: "w2".into(),
                    text: "variants".into(),
                    start_ticks: 20_000,
                    end_ticks: 45_000,
                    confidence_milli: 970,
                },
                TranscriptWord {
                    id: "w3".into(),
                    text: "today".into(),
                    start_ticks: 50_000,
                    end_ticks: 75_000,
                    confidence_milli: 960,
                },
            ],
            model: ModelProvenance {
                id: "openai/whisper-tiny".into(),
                revision: "m5-pinned".into(),
                license: "MIT".into(),
            },
            created_at: "2026-08-28T00:00:00Z".into(),
        }
    }

    fn manifest() -> FontManifest {
        FontManifest {
            version: 1,
            fonts: vec![FontFace {
                id: "inter-latin".into(),
                family: "Inter".into(),
                revision: "4.1".into(),
                license: "OFL-1.1".into(),
                unicode_ranges: vec![UnicodeRange {
                    start: 0x20,
                    end: 0x024f,
                }],
            }],
        }
    }

    fn profile() -> LocaleProfile {
        LocaleProfile {
            id: "locale-en".into(),
            name: "English".into(),
            locale: "en-US".into(),
            text_values: vec![],
            font_fallback_ids: vec!["inter-latin".into()],
            caption_style: CaptionStyle {
                font_size_px: 42,
                max_lines: 2,
                max_chars_per_second: 20,
            },
            version: 1,
        }
    }

    #[test]
    fn word_alignment_segmentation_and_edit_preserve_timing() {
        let artifact = artifact();
        let mut track = segment_words(&artifact, 2, 48_000).unwrap();
        let before = (
            track.cues[0].start_ticks,
            track.cues[0].end_ticks,
            track.cues[0].word_ids.clone(),
        );
        let cue_id = track.cues[0].id.clone();
        edit_caption(&mut track, &cue_id, "Create controlled variants".into()).unwrap();
        assert_eq!(
            before,
            (
                track.cues[0].start_ticks,
                track.cues[0].end_ticks,
                track.cues[0].word_ids.clone()
            )
        );
        assert!(track.cues[0].edited);
    }

    #[test]
    fn rejects_overlap_and_incomplete_provenance() {
        let mut invalid = artifact();
        invalid.words[1].start_ticks = 10;
        assert_eq!(
            validate_artifact(&invalid),
            Err(TranscriptError::InvalidWordTiming)
        );
        let mut invalid = artifact();
        invalid.model.license.clear();
        assert_eq!(
            validate_artifact(&invalid),
            Err(TranscriptError::MissingModelProvenance)
        );
    }

    #[test]
    fn unicode_rtl_cjk_combining_and_long_copy_have_diagnostics() {
        let mut track = segment_words(&artifact(), 3, 96_000).unwrap();
        track.cues[0].text =
            "Russian Arabic CJK combining mark and sehr lange deutsche headline".into();
        let diagnostics = diagnose_track(&track, &profile(), &manifest(), 180).unwrap();
        assert!(
            diagnostics
                .iter()
                .any(|item| item.kind == TextDiagnosticKind::Overflow)
        );
        assert!(
            diagnostics
                .iter()
                .any(|item| item.kind == TextDiagnosticKind::Readability)
        );
        track.cues[0].text = "Русский العربية 漢字 é".into();
        assert!(
            diagnose_track(&track, &profile(), &manifest(), 180)
                .unwrap()
                .iter()
                .any(|item| item.kind == TextDiagnosticKind::MissingGlyph)
        );
    }

    #[test]
    fn validates_font_fallback_and_locale_limit() {
        let mut unknown = profile();
        unknown.font_fallback_ids = vec!["system-only".into()];
        assert_eq!(
            validate_locale_profile(&[], &unknown, &manifest()),
            Err(TranscriptError::UnknownFont("system-only".into()))
        );
        let existing = (0..MAX_LOCALE_PROFILES)
            .map(|index| LocaleProfile {
                id: format!("locale-{index}"),
                ..profile()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            validate_locale_profile(
                &existing,
                &LocaleProfile {
                    id: "locale-over".into(),
                    ..profile()
                },
                &manifest()
            ),
            Err(TranscriptError::LocaleLimit)
        );
    }
}
