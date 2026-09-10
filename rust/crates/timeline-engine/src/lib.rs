use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use studio_model::{
    ClipPlacement, TICKS_PER_SECOND, Timeline, TimelineClip, TimelineEdit, TimelinePatch,
    TimelineTrack, TrackKind, TrimEdge,
};
use thiserror::Error;
use ts_rs::TS;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TimelineError {
    #[error("timeline frame rate must be positive")]
    InvalidFrameRate,
    #[error("track {0} was not found")]
    TrackNotFound(String),
    #[error("clip {0} was not found")]
    ClipNotFound(String),
    #[error("clip IDs must be unique")]
    DuplicateClipId,
    #[error("clip duration and source duration must be positive")]
    InvalidDuration,
    #[error("clip position or source offset is outside the valid range")]
    InvalidRange,
    #[error("clip type does not match the target track")]
    TrackKindMismatch,
    #[error("cross-track move requires clips from one source track")]
    MixedSourceTracks,
    #[error("split must be strictly inside every selected clip")]
    InvalidSplit,
    #[error("split result IDs must be unique and supplied by the caller")]
    InvalidSplitIds,
    #[error("timeline edit made no change")]
    NoOp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimelineEditResult {
    pub timeline: Timeline,
    pub changed_clip_ids: Vec<String>,
    #[ts(type = "number")]
    pub dirty_start_ticks: i64,
    #[ts(type = "number")]
    pub dirty_end_ticks: i64,
    #[ts(type = "number | null")]
    pub snapped_to_ticks: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimelinePreviewResult {
    pub placements: Vec<ClipPlacement>,
    pub removed_clip_ids: Vec<String>,
    #[ts(type = "number | null")]
    pub snapped_to_ticks: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VisibleTimelineQuery {
    #[ts(type = "number")]
    pub start_ticks: i64,
    #[ts(type = "number")]
    pub end_ticks: i64,
    pub first_track: usize,
    pub last_track: usize,
    #[ts(type = "number")]
    pub overscan_ticks: i64,
    pub max_nodes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VisibleTimelineClip {
    pub track_index: usize,
    pub track_id: String,
    pub clip: TimelineClip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VisibleTimelineResult {
    pub clips: Vec<VisibleTimelineClip>,
    pub total_matching: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StressTimelineInput {
    #[ts(type = "number")]
    pub duration_ticks: i64,
    pub track_count: usize,
    pub clip_count: usize,
    pub fps_num: u32,
    pub fps_den: u32,
}

pub fn frame_ticks(timeline: &Timeline) -> Result<i64, TimelineError> {
    if timeline.fps_num == 0 || timeline.fps_den == 0 {
        return Err(TimelineError::InvalidFrameRate);
    }
    let numerator = i128::from(TICKS_PER_SECOND) * i128::from(timeline.fps_den);
    let denominator = i128::from(timeline.fps_num);
    Ok(((numerator + denominator / 2) / denominator).max(1) as i64)
}

pub fn validate_timeline(timeline: &Timeline) -> Result<(), TimelineError> {
    frame_ticks(timeline)?;
    let mut ids = BTreeSet::new();
    for track in &timeline.tracks {
        for clip in &track.clips {
            if !ids.insert(clip.id.as_str()) {
                return Err(TimelineError::DuplicateClipId);
            }
            validate_clip(clip)?;
        }
    }
    Ok(())
}

pub fn apply_edit(
    timeline: &Timeline,
    edit: &TimelineEdit,
) -> Result<TimelineEditResult, TimelineError> {
    validate_timeline(timeline)?;
    let before = placements(timeline);
    let mut next = timeline.clone();
    let snapped_to_ticks = match edit {
        TimelineEdit::InsertClip { track_id, clip } => {
            validate_clip(clip)?;
            if before.contains_key(&clip.id) {
                return Err(TimelineError::DuplicateClipId);
            }
            let track = track_mut(&mut next, track_id)?;
            ensure_track_kind(track, clip)?;
            track.clips.push(clip.clone());
            None
        }
        TimelineEdit::MoveClips {
            clip_ids,
            delta_ticks,
            target_track_id,
            playhead_ticks,
            snap_tolerance_ticks,
            disable_snapping,
            ripple,
        } => move_clips(
            &mut next,
            clip_ids,
            *delta_ticks,
            target_track_id.as_deref(),
            *playhead_ticks,
            *snap_tolerance_ticks,
            *disable_snapping,
            *ripple,
        )?,
        TimelineEdit::TrimClip {
            clip_id,
            edge,
            target_ticks,
            playhead_ticks,
            snap_tolerance_ticks,
            disable_snapping,
            ripple,
        } => trim_clip(
            &mut next,
            clip_id,
            *edge,
            *target_ticks,
            *playhead_ticks,
            *snap_tolerance_ticks,
            *disable_snapping,
            *ripple,
        )?,
        TimelineEdit::SplitClips { at_ticks, splits } => {
            split_clips(&mut next, *at_ticks, splits)?;
            None
        }
        TimelineEdit::DeleteClips { clip_ids, ripple } => {
            delete_clips(&mut next, clip_ids, *ripple)?;
            None
        }
    };
    normalize(&mut next);
    validate_timeline(&next)?;
    let after = placements(&next);
    if before == after {
        return Err(TimelineError::NoOp);
    }
    let changed_clip_ids = changed_ids(&before, &after);
    let (dirty_start_ticks, dirty_end_ticks) = dirty_range(&before, &after, &changed_clip_ids);
    Ok(TimelineEditResult {
        timeline: next,
        changed_clip_ids,
        dirty_start_ticks,
        dirty_end_ticks,
        snapped_to_ticks,
    })
}

pub fn preview_edit(
    timeline: &Timeline,
    edit: &TimelineEdit,
) -> Result<TimelinePreviewResult, TimelineError> {
    match edit {
        TimelineEdit::MoveClips {
            clip_ids,
            delta_ticks,
            target_track_id,
            playhead_ticks,
            snap_tolerance_ticks,
            disable_snapping,
            ripple: false,
        } => {
            return preview_move_clips(
                timeline,
                clip_ids,
                *delta_ticks,
                target_track_id.as_deref(),
                *playhead_ticks,
                *snap_tolerance_ticks,
                *disable_snapping,
            );
        }
        TimelineEdit::TrimClip {
            clip_id,
            edge,
            target_ticks,
            playhead_ticks,
            snap_tolerance_ticks,
            disable_snapping,
            ripple: false,
        } => {
            return preview_trim_clip(
                timeline,
                clip_id,
                *edge,
                *target_ticks,
                *playhead_ticks,
                *snap_tolerance_ticks,
                *disable_snapping,
            );
        }
        _ => {}
    }
    let result = apply_edit(timeline, edit)?;
    let after = placements(&result.timeline);
    let mut changed = result.changed_clip_ids.clone();
    changed.sort();
    let placements = changed
        .iter()
        .filter_map(|clip_id| after.get(clip_id).cloned())
        .collect();
    let removed_clip_ids = changed
        .into_iter()
        .filter(|clip_id| !after.contains_key(clip_id))
        .collect();
    Ok(TimelinePreviewResult {
        placements,
        removed_clip_ids,
        snapped_to_ticks: result.snapped_to_ticks,
    })
}

#[allow(clippy::too_many_arguments)]
fn preview_move_clips(
    timeline: &Timeline,
    ids: &[String],
    raw_delta: i64,
    target_track_id: Option<&str>,
    playhead_ticks: i64,
    snap_tolerance_ticks: i64,
    disable_snapping: bool,
) -> Result<TimelinePreviewResult, TimelineError> {
    let selected = selected_placements_compact(timeline, ids)?;
    let selected_ids: BTreeSet<&str> = selected.iter().map(|item| item.clip.id.as_str()).collect();
    let source_tracks: BTreeSet<&str> =
        selected.iter().map(|item| item.track_id.as_str()).collect();
    if target_track_id.is_some() && source_tracks.len() != 1 {
        return Err(TimelineError::MixedSourceTracks);
    }
    let first_start = selected
        .iter()
        .map(|item| item.clip.start_ticks)
        .min()
        .unwrap_or(0);
    let last_end = selected
        .iter()
        .map(|item| item.clip.start_ticks + item.clip.duration_ticks)
        .max()
        .unwrap_or(first_start);
    let clamped_delta = raw_delta.max(-first_start);
    let (delta, snapped_to_ticks) = if disable_snapping {
        (clamped_delta, None)
    } else {
        snap_group_delta_compact(
            timeline,
            &selected_ids,
            first_start,
            last_end,
            clamped_delta,
            playhead_ticks,
            snap_tolerance_ticks.max(0),
        )
    };
    let destination_id = target_track_id
        .unwrap_or(selected[0].track_id.as_str())
        .to_owned();
    let destination = timeline
        .tracks
        .iter()
        .find(|track| track.id == destination_id)
        .ok_or_else(|| TimelineError::TrackNotFound(destination_id.clone()))?;
    if destination.kind == TrackKind::Audio && selected.iter().any(|item| !item.clip.has_audio) {
        return Err(TimelineError::TrackKindMismatch);
    }
    if delta == 0 && selected.iter().all(|item| item.track_id == destination_id) {
        return Err(TimelineError::NoOp);
    }
    let placements = selected
        .into_iter()
        .map(|placement| {
            let mut clip = placement.clip;
            clip.start_ticks = (clip.start_ticks + delta).max(0);
            ClipPlacement {
                track_id: destination_id.clone(),
                clip,
            }
        })
        .collect();
    Ok(TimelinePreviewResult {
        placements,
        removed_clip_ids: Vec::new(),
        snapped_to_ticks,
    })
}

#[allow(clippy::too_many_arguments)]
fn preview_trim_clip(
    timeline: &Timeline,
    clip_id: &str,
    edge: TrimEdge,
    raw_target: i64,
    playhead_ticks: i64,
    tolerance: i64,
    disable_snapping: bool,
) -> Result<TimelinePreviewResult, TimelineError> {
    let frame = frame_ticks(timeline)?;
    let placement = find_placement(timeline, clip_id)
        .ok_or_else(|| TimelineError::ClipNotFound(clip_id.to_owned()))?;
    let old_end = placement.clip.start_ticks + placement.clip.duration_ticks;
    let min_target = match edge {
        TrimEdge::Start => placement.clip.start_ticks,
        TrimEdge::End => placement.clip.start_ticks + frame,
    };
    let max_target = match edge {
        TrimEdge::Start => old_end - frame,
        TrimEdge::End => {
            placement.clip.start_ticks + placement.clip.source_duration_ticks
                - placement.clip.source_offset_ticks
        }
    };
    let mut target = raw_target.clamp(min_target, max_target);
    let mut snapped_to_ticks = None;
    if !disable_snapping
        && let Some(candidate) = nearest_target_compact(
            timeline,
            &BTreeSet::from([clip_id]),
            target,
            playhead_ticks,
            tolerance.max(0),
        )
    {
        target = candidate.clamp(min_target, max_target);
        snapped_to_ticks = Some(target);
    }
    let original_clip = placement.clip.clone();
    let mut clip = placement.clip;
    match edge {
        TrimEdge::Start => {
            let shift = target - clip.start_ticks;
            clip.start_ticks = target;
            clip.source_offset_ticks += shift;
            clip.duration_ticks -= shift;
        }
        TrimEdge::End => clip.duration_ticks = target - clip.start_ticks,
    }
    if clip == original_clip {
        return Err(TimelineError::NoOp);
    }
    Ok(TimelinePreviewResult {
        placements: vec![ClipPlacement {
            track_id: placement.track_id,
            clip,
        }],
        removed_clip_ids: Vec::new(),
        snapped_to_ticks,
    })
}

fn find_placement(timeline: &Timeline, clip_id: &str) -> Option<ClipPlacement> {
    timeline.tracks.iter().find_map(|track| {
        track
            .clips
            .iter()
            .find(|clip| clip.id == clip_id)
            .map(|clip| ClipPlacement {
                track_id: track.id.clone(),
                clip: clip.clone(),
            })
    })
}

fn selected_placements_compact(
    timeline: &Timeline,
    ids: &[String],
) -> Result<Vec<ClipPlacement>, TimelineError> {
    let requested: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
    if requested.is_empty() {
        return Err(TimelineError::NoOp);
    }
    let mut selected = Vec::with_capacity(requested.len());
    for track in &timeline.tracks {
        for clip in &track.clips {
            if requested.contains(clip.id.as_str()) {
                selected.push(ClipPlacement {
                    track_id: track.id.clone(),
                    clip: clip.clone(),
                });
            }
        }
    }
    if selected.len() != requested.len() {
        let found: BTreeSet<&str> = selected.iter().map(|item| item.clip.id.as_str()).collect();
        let missing = requested
            .into_iter()
            .find(|id| !found.contains(id))
            .unwrap_or("unknown");
        return Err(TimelineError::ClipNotFound(missing.to_owned()));
    }
    selected.sort_by_key(|placement| (placement.clip.start_ticks, placement.clip.id.clone()));
    Ok(selected)
}

fn nearest_target_compact(
    timeline: &Timeline,
    excluded: &BTreeSet<&str>,
    value: i64,
    playhead_ticks: i64,
    tolerance: i64,
) -> Option<i64> {
    let mut best: Option<(i64, i64)> = None;
    let mut consider = |target: i64| {
        let distance = (target - value).abs();
        if distance <= tolerance && best.is_none_or(|current| (distance, target) < current) {
            best = Some((distance, target));
        }
    };
    consider(0);
    consider(playhead_ticks.max(0));
    for track in &timeline.tracks {
        for clip in &track.clips {
            if !excluded.contains(clip.id.as_str()) {
                consider(clip.start_ticks);
                consider(clip.start_ticks + clip.duration_ticks);
            }
        }
    }
    best.map(|(_, target)| target)
}

fn snap_group_delta_compact(
    timeline: &Timeline,
    selected_ids: &BTreeSet<&str>,
    first_start: i64,
    last_end: i64,
    raw_delta: i64,
    playhead_ticks: i64,
    tolerance: i64,
) -> (i64, Option<i64>) {
    let start = first_start + raw_delta;
    let end = last_end + raw_delta;
    let left = nearest_target_compact(timeline, selected_ids, start, playhead_ticks, tolerance)
        .map(|target| (target - start, target));
    let right = nearest_target_compact(timeline, selected_ids, end, playhead_ticks, tolerance)
        .map(|target| (target - end, target));
    let candidate = match (left, right) {
        (Some(a), Some(b)) => Some(if (a.0.abs(), a.1) <= (b.0.abs(), b.1) {
            a
        } else {
            b
        }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    };
    candidate
        .map(|(adjustment, target)| ((raw_delta + adjustment).max(-first_start), Some(target)))
        .unwrap_or((raw_delta.max(-first_start), None))
}

pub fn patches(before: &Timeline, after: &Timeline) -> (TimelinePatch, TimelinePatch) {
    let before_map = placements(before);
    let after_map = placements(after);
    (
        patch_between(&before_map, &after_map),
        patch_between(&after_map, &before_map),
    )
}

pub fn apply_patch(timeline: &mut Timeline, patch: &TimelinePatch) -> Result<(), TimelineError> {
    let affected: BTreeSet<&str> = patch
        .remove_clip_ids
        .iter()
        .map(String::as_str)
        .chain(
            patch
                .upsert
                .iter()
                .map(|placement| placement.clip.id.as_str()),
        )
        .collect();
    for track in &mut timeline.tracks {
        track
            .clips
            .retain(|clip| !affected.contains(clip.id.as_str()));
    }
    for placement in &patch.upsert {
        validate_clip(&placement.clip)?;
        let track = track_mut(timeline, &placement.track_id)?;
        ensure_track_kind(track, &placement.clip)?;
        track.clips.push(placement.clip.clone());
    }
    normalize(timeline);
    validate_timeline(timeline)
}

pub fn visible_timeline(
    timeline: &Timeline,
    query: &VisibleTimelineQuery,
) -> Result<VisibleTimelineResult, TimelineError> {
    validate_timeline(timeline)?;
    Ok(visible_timeline_from_validated(timeline, query))
}

pub fn visible_timeline_from_validated(
    timeline: &Timeline,
    query: &VisibleTimelineQuery,
) -> VisibleTimelineResult {
    let start = query
        .start_ticks
        .saturating_sub(query.overscan_ticks)
        .max(0);
    let end = query
        .end_ticks
        .saturating_add(query.overscan_ticks)
        .max(start);
    let last_track = query
        .last_track
        .min(timeline.tracks.len().saturating_sub(1));
    let mut clips = Vec::new();
    let mut total_matching = 0;
    if query.first_track <= last_track {
        for track_index in query.first_track..=last_track {
            let track = &timeline.tracks[track_index];
            for clip in &track.clips {
                if clip.start_ticks >= end {
                    break;
                }
                if clip.start_ticks + clip.duration_ticks <= start {
                    continue;
                }
                total_matching += 1;
                if clips.len() < query.max_nodes {
                    clips.push(VisibleTimelineClip {
                        track_index,
                        track_id: track.id.clone(),
                        clip: clip.clone(),
                    });
                }
            }
        }
    }
    VisibleTimelineResult {
        truncated: total_matching > clips.len(),
        clips,
        total_matching,
    }
}

pub fn create_stress_timeline(input: &StressTimelineInput) -> Result<Timeline, TimelineError> {
    if input.duration_ticks <= 0
        || input.track_count == 0
        || input.fps_num == 0
        || input.fps_den == 0
    {
        return Err(TimelineError::InvalidRange);
    }
    let mut tracks = Vec::with_capacity(input.track_count);
    for index in 0..input.track_count {
        let kind = if index % 4 == 3 {
            TrackKind::Audio
        } else {
            TrackKind::Video
        };
        tracks.push(TimelineTrack {
            id: format!("stress-track-{index}"),
            name: format!(
                "{} {}",
                if kind == TrackKind::Audio {
                    "Audio"
                } else {
                    "Video"
                },
                index + 1
            ),
            kind,
            height: if kind == TrackKind::Audio { 48 } else { 60 },
            clips: Vec::new(),
        });
    }
    let per_track = (input.clip_count / input.track_count).max(1) as i64;
    let clip_ticks = (input.duration_ticks / per_track).max(1);
    for index in 0..input.clip_count {
        let track_index = index % input.track_count;
        let lane_index = index / input.track_count;
        let start_ticks =
            (lane_index as i64 * clip_ticks).min(input.duration_ticks.saturating_sub(1));
        let duration_ticks = clip_ticks.min(input.duration_ticks - start_ticks).max(1);
        let has_audio = tracks[track_index].kind == TrackKind::Audio;
        tracks[track_index].clips.push(TimelineClip {
            id: format!("stress-clip-{index}"),
            asset_id: "stress-source".to_owned(),
            label: format!("Cut {:05}", index + 1),
            start_ticks,
            duration_ticks,
            source_offset_ticks: (index as i64 * 2_003)
                % (input.duration_ticks - duration_ticks + 1),
            source_duration_ticks: input.duration_ticks,
            has_audio,
        });
    }
    let mut timeline = Timeline {
        fps_num: input.fps_num,
        fps_den: input.fps_den,
        duration_ticks: input.duration_ticks,
        tracks,
    };
    normalize(&mut timeline);
    validate_timeline(&timeline)?;
    Ok(timeline)
}

fn validate_clip(clip: &TimelineClip) -> Result<(), TimelineError> {
    if clip.duration_ticks <= 0 || clip.source_duration_ticks <= 0 {
        return Err(TimelineError::InvalidDuration);
    }
    if clip.start_ticks < 0
        || clip.source_offset_ticks < 0
        || clip.source_offset_ticks + clip.duration_ticks > clip.source_duration_ticks
    {
        return Err(TimelineError::InvalidRange);
    }
    Ok(())
}

fn ensure_track_kind(track: &TimelineTrack, clip: &TimelineClip) -> Result<(), TimelineError> {
    if track.kind == TrackKind::Video || clip.has_audio {
        Ok(())
    } else {
        Err(TimelineError::TrackKindMismatch)
    }
}

fn track_mut<'a>(
    timeline: &'a mut Timeline,
    id: &str,
) -> Result<&'a mut TimelineTrack, TimelineError> {
    timeline
        .tracks
        .iter_mut()
        .find(|track| track.id == id)
        .ok_or_else(|| TimelineError::TrackNotFound(id.to_owned()))
}

fn placements(timeline: &Timeline) -> BTreeMap<String, ClipPlacement> {
    let mut result = BTreeMap::new();
    for track in &timeline.tracks {
        for clip in &track.clips {
            result.insert(
                clip.id.clone(),
                ClipPlacement {
                    track_id: track.id.clone(),
                    clip: clip.clone(),
                },
            );
        }
    }
    result
}

fn selected_placements(
    timeline: &Timeline,
    ids: &[String],
) -> Result<Vec<ClipPlacement>, TimelineError> {
    let all = placements(timeline);
    let mut selected = Vec::with_capacity(ids.len());
    let mut unique = BTreeSet::new();
    for id in ids {
        if !unique.insert(id) {
            continue;
        }
        selected.push(
            all.get(id)
                .cloned()
                .ok_or_else(|| TimelineError::ClipNotFound(id.clone()))?,
        );
    }
    if selected.is_empty() {
        return Err(TimelineError::NoOp);
    }
    selected.sort_by_key(|placement| (placement.clip.start_ticks, placement.clip.id.clone()));
    Ok(selected)
}

fn normalize(timeline: &mut Timeline) {
    let mut duration = 0;
    for track in &mut timeline.tracks {
        track.clips.sort_by(|left, right| {
            (left.start_ticks, left.id.as_str()).cmp(&(right.start_ticks, right.id.as_str()))
        });
        duration = duration.max(
            track
                .clips
                .iter()
                .map(|clip| clip.start_ticks + clip.duration_ticks)
                .max()
                .unwrap_or(0),
        );
    }
    timeline.duration_ticks = duration;
}

fn changed_ids(
    before: &BTreeMap<String, ClipPlacement>,
    after: &BTreeMap<String, ClipPlacement>,
) -> Vec<String> {
    before
        .keys()
        .chain(after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|id| before.get(*id) != after.get(*id))
        .cloned()
        .collect()
}

fn dirty_range(
    before: &BTreeMap<String, ClipPlacement>,
    after: &BTreeMap<String, ClipPlacement>,
    ids: &[String],
) -> (i64, i64) {
    let mut start = i64::MAX;
    let mut end = 0;
    for id in ids {
        for placement in [before.get(id), after.get(id)].into_iter().flatten() {
            start = start.min(placement.clip.start_ticks);
            end = end.max(placement.clip.start_ticks + placement.clip.duration_ticks);
        }
    }
    if start == i64::MAX {
        (0, 0)
    } else {
        (start, end)
    }
}

fn patch_between(
    from: &BTreeMap<String, ClipPlacement>,
    to: &BTreeMap<String, ClipPlacement>,
) -> TimelinePatch {
    let ids: BTreeSet<&String> = from.keys().chain(to.keys()).collect();
    let mut upsert = Vec::new();
    let mut remove_clip_ids = Vec::new();
    for id in ids {
        if from.get(id) == to.get(id) {
            continue;
        }
        match to.get(id) {
            Some(placement) => upsert.push(placement.clone()),
            None => remove_clip_ids.push(id.clone()),
        }
    }
    TimelinePatch {
        upsert,
        remove_clip_ids,
    }
}

fn snap_targets(timeline: &Timeline, excluded: &[&str], playhead_ticks: i64) -> Vec<i64> {
    let excluded: BTreeSet<&str> = excluded.iter().copied().collect();
    let mut targets = BTreeSet::from([0, playhead_ticks.max(0)]);
    for track in &timeline.tracks {
        for clip in &track.clips {
            if !excluded.contains(clip.id.as_str()) {
                targets.insert(clip.start_ticks);
                targets.insert(clip.start_ticks + clip.duration_ticks);
            }
        }
    }
    targets.into_iter().collect()
}

fn nearest_target(value: i64, targets: &[i64], tolerance: i64) -> Option<i64> {
    targets
        .iter()
        .copied()
        .filter_map(|target| {
            let distance = (target - value).abs();
            (distance <= tolerance).then_some((distance, target))
        })
        .min()
        .map(|(_, target)| target)
}

fn snap_group_delta(
    timeline: &Timeline,
    selected_ids: &BTreeSet<&str>,
    first_start: i64,
    last_end: i64,
    raw_delta: i64,
    playhead_ticks: i64,
    tolerance: i64,
) -> (i64, Option<i64>) {
    let excluded = selected_ids.iter().copied().collect::<Vec<_>>();
    let targets = snap_targets(timeline, &excluded, playhead_ticks);
    let start = first_start + raw_delta;
    let end = last_end + raw_delta;
    let left = nearest_target(start, &targets, tolerance).map(|target| (target - start, target));
    let right = nearest_target(end, &targets, tolerance).map(|target| (target - end, target));
    let candidate = match (left, right) {
        (Some(a), Some(b)) => {
            if (a.0.abs(), a.1) <= (b.0.abs(), b.1) {
                Some(a)
            } else {
                Some(b)
            }
        }
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    };
    candidate
        .map(|(adjustment, target)| ((raw_delta + adjustment).max(-first_start), Some(target)))
        .unwrap_or((raw_delta.max(-first_start), None))
}

#[allow(clippy::too_many_arguments)]
fn move_clips(
    timeline: &mut Timeline,
    ids: &[String],
    raw_delta: i64,
    target_track_id: Option<&str>,
    playhead_ticks: i64,
    snap_tolerance_ticks: i64,
    disable_snapping: bool,
    ripple: bool,
) -> Result<Option<i64>, TimelineError> {
    let selected = selected_placements(timeline, ids)?;
    let selected_ids: BTreeSet<&str> = selected.iter().map(|item| item.clip.id.as_str()).collect();
    let source_tracks: BTreeSet<&str> =
        selected.iter().map(|item| item.track_id.as_str()).collect();
    if target_track_id.is_some() && source_tracks.len() != 1 {
        return Err(TimelineError::MixedSourceTracks);
    }
    let first_start = selected
        .iter()
        .map(|item| item.clip.start_ticks)
        .min()
        .unwrap_or(0);
    let last_end = selected
        .iter()
        .map(|item| item.clip.start_ticks + item.clip.duration_ticks)
        .max()
        .unwrap_or(first_start);
    let clamped_delta = raw_delta.max(-first_start);
    let (delta, snapped_to) = if disable_snapping {
        (clamped_delta, None)
    } else {
        snap_group_delta(
            timeline,
            &selected_ids,
            first_start,
            last_end,
            clamped_delta,
            playhead_ticks,
            snap_tolerance_ticks.max(0),
        )
    };
    let destination_id = target_track_id
        .unwrap_or(selected[0].track_id.as_str())
        .to_owned();
    let destination_kind = timeline
        .tracks
        .iter()
        .find(|track| track.id == destination_id)
        .ok_or_else(|| TimelineError::TrackNotFound(destination_id.clone()))?
        .kind;
    if destination_kind == TrackKind::Audio && selected.iter().any(|item| !item.clip.has_audio) {
        return Err(TimelineError::TrackKindMismatch);
    }
    if ripple {
        close_ripple_gaps(timeline, &selected);
        let span = last_end - first_start;
        let insertion = (first_start + delta).max(0);
        if let Some(destination) = timeline
            .tracks
            .iter_mut()
            .find(|track| track.id == destination_id)
        {
            for clip in &mut destination.clips {
                if !selected_ids.contains(clip.id.as_str()) && clip.start_ticks >= insertion {
                    clip.start_ticks += span;
                }
            }
        }
    }
    for track in &mut timeline.tracks {
        track
            .clips
            .retain(|clip| !selected_ids.contains(clip.id.as_str()));
    }
    let destination = track_mut(timeline, &destination_id)?;
    for placement in selected {
        let mut clip = placement.clip;
        clip.start_ticks = (clip.start_ticks + delta).max(0);
        destination.clips.push(clip);
    }
    Ok(snapped_to)
}

#[allow(clippy::too_many_arguments)]
fn trim_clip(
    timeline: &mut Timeline,
    clip_id: &str,
    edge: TrimEdge,
    raw_target: i64,
    playhead_ticks: i64,
    tolerance: i64,
    disable_snapping: bool,
    ripple: bool,
) -> Result<Option<i64>, TimelineError> {
    let frame = frame_ticks(timeline)?;
    let placement = placements(timeline)
        .get(clip_id)
        .cloned()
        .ok_or_else(|| TimelineError::ClipNotFound(clip_id.to_owned()))?;
    let old_end = placement.clip.start_ticks + placement.clip.duration_ticks;
    let min_target = match edge {
        TrimEdge::Start => placement.clip.start_ticks,
        TrimEdge::End => placement.clip.start_ticks + frame,
    };
    let max_target = match edge {
        TrimEdge::Start => old_end - frame,
        TrimEdge::End => {
            placement.clip.start_ticks + placement.clip.source_duration_ticks
                - placement.clip.source_offset_ticks
        }
    };
    let mut target = raw_target.clamp(min_target, max_target);
    let mut snapped = None;
    if !disable_snapping {
        let targets = snap_targets(timeline, &[clip_id], playhead_ticks);
        if let Some(candidate) = nearest_target(target, &targets, tolerance.max(0)) {
            target = candidate.clamp(min_target, max_target);
            snapped = Some(target);
        }
    }
    let track = track_mut(timeline, &placement.track_id)?;
    let clip = track
        .clips
        .iter_mut()
        .find(|clip| clip.id == clip_id)
        .ok_or_else(|| TimelineError::ClipNotFound(clip_id.to_owned()))?;
    match edge {
        TrimEdge::Start => {
            let shift = target - clip.start_ticks;
            clip.start_ticks = target;
            clip.source_offset_ticks += shift;
            clip.duration_ticks -= shift;
        }
        TrimEdge::End => clip.duration_ticks = target - clip.start_ticks,
    }
    let new_end = clip.start_ticks + clip.duration_ticks;
    let duration_delta = new_end - old_end;
    if ripple && duration_delta != 0 {
        for other in &mut track.clips {
            if other.id != clip_id && other.start_ticks >= old_end {
                other.start_ticks = (other.start_ticks + duration_delta).max(0);
            }
        }
    }
    Ok(snapped)
}

fn split_clips(
    timeline: &mut Timeline,
    at_ticks: i64,
    splits: &[studio_model::SplitRequest],
) -> Result<(), TimelineError> {
    if splits.is_empty() {
        return Err(TimelineError::NoOp);
    }
    let existing: BTreeSet<String> = placements(timeline).into_keys().collect();
    let mut new_ids = BTreeSet::new();
    if splits.iter().any(|split| {
        split.right_clip_id.trim().is_empty()
            || existing.contains(&split.right_clip_id)
            || !new_ids.insert(split.right_clip_id.clone())
    }) {
        return Err(TimelineError::InvalidSplitIds);
    }
    for split in splits {
        let placement = placements(timeline)
            .get(&split.clip_id)
            .cloned()
            .ok_or_else(|| TimelineError::ClipNotFound(split.clip_id.clone()))?;
        let old_end = placement.clip.start_ticks + placement.clip.duration_ticks;
        if at_ticks <= placement.clip.start_ticks || at_ticks >= old_end {
            return Err(TimelineError::InvalidSplit);
        }
        let track = track_mut(timeline, &placement.track_id)?;
        let left = track
            .clips
            .iter_mut()
            .find(|clip| clip.id == split.clip_id)
            .ok_or_else(|| TimelineError::ClipNotFound(split.clip_id.clone()))?;
        let left_duration = at_ticks - left.start_ticks;
        let mut right = left.clone();
        right.id = split.right_clip_id.clone();
        right.label = format!("{} · B", right.label);
        right.start_ticks = at_ticks;
        right.duration_ticks -= left_duration;
        right.source_offset_ticks += left_duration;
        left.duration_ticks = left_duration;
        track.clips.push(right);
    }
    Ok(())
}

fn delete_clips(
    timeline: &mut Timeline,
    ids: &[String],
    ripple: bool,
) -> Result<(), TimelineError> {
    let selected = selected_placements(timeline, ids)?;
    if ripple {
        close_ripple_gaps(timeline, &selected);
    }
    let selected_ids: BTreeSet<&str> = selected.iter().map(|item| item.clip.id.as_str()).collect();
    for track in &mut timeline.tracks {
        track
            .clips
            .retain(|clip| !selected_ids.contains(clip.id.as_str()));
    }
    Ok(())
}

fn close_ripple_gaps(timeline: &mut Timeline, selected: &[ClipPlacement]) {
    let mut by_track: BTreeMap<&str, Vec<(i64, i64)>> = BTreeMap::new();
    for placement in selected {
        by_track
            .entry(placement.track_id.as_str())
            .or_default()
            .push((placement.clip.start_ticks, placement.clip.duration_ticks));
    }
    let selected_ids: BTreeSet<&str> = selected.iter().map(|item| item.clip.id.as_str()).collect();
    for track in &mut timeline.tracks {
        let Some(intervals) = by_track.get(track.id.as_str()) else {
            continue;
        };
        for clip in &mut track.clips {
            if selected_ids.contains(clip.id.as_str()) {
                continue;
            }
            let shift: i64 = intervals
                .iter()
                .filter(|(start, duration)| start + duration <= clip.start_ticks)
                .map(|(_, duration)| duration)
                .sum();
            clip.start_ticks = (clip.start_ticks - shift).max(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use studio_model::{SplitRequest, TimelineEdit};

    fn clip(id: &str, start: i64, duration: i64) -> TimelineClip {
        TimelineClip {
            id: id.to_owned(),
            asset_id: "asset".to_owned(),
            label: id.to_owned(),
            start_ticks: start,
            duration_ticks: duration,
            source_offset_ticks: 0,
            source_duration_ticks: 10 * TICKS_PER_SECOND,
            has_audio: false,
        }
    }

    fn timeline() -> Timeline {
        Timeline {
            fps_num: 30_000,
            fps_den: 1_001,
            duration_ticks: 3 * TICKS_PER_SECOND,
            tracks: vec![
                TimelineTrack {
                    id: "v1".to_owned(),
                    name: "Video 1".to_owned(),
                    kind: TrackKind::Video,
                    height: 60,
                    clips: vec![
                        clip("a", 0, TICKS_PER_SECOND),
                        clip("b", 2 * TICKS_PER_SECOND, TICKS_PER_SECOND),
                    ],
                },
                TimelineTrack {
                    id: "v2".to_owned(),
                    name: "Video 2".to_owned(),
                    kind: TrackKind::Video,
                    height: 52,
                    clips: vec![],
                },
            ],
        }
    }

    #[test]
    fn split_and_inverse_patch_restore_identity() {
        let before = timeline();
        let result = apply_edit(
            &before,
            &TimelineEdit::SplitClips {
                at_ticks: TICKS_PER_SECOND / 2,
                splits: vec![SplitRequest {
                    clip_id: "a".into(),
                    right_clip_id: "a-right".into(),
                }],
            },
        )
        .unwrap();
        let (forward, inverse) = patches(&before, &result.timeline);
        let mut restored = before.clone();
        apply_patch(&mut restored, &forward).unwrap();
        assert_eq!(restored, result.timeline);
        apply_patch(&mut restored, &inverse).unwrap();
        assert_eq!(restored, before);
    }

    #[test]
    fn move_snaps_group_edge_and_can_cross_tracks() {
        let result = apply_edit(
            &timeline(),
            &TimelineEdit::MoveClips {
                clip_ids: vec!["a".into()],
                delta_ticks: 47_500,
                target_track_id: Some("v2".into()),
                playhead_ticks: TICKS_PER_SECOND,
                snap_tolerance_ticks: 1_000,
                disable_snapping: false,
                ripple: false,
            },
        )
        .unwrap();
        let moved = &result.timeline.tracks[1].clips[0];
        assert_eq!(moved.start_ticks, TICKS_PER_SECOND);
        assert_eq!(result.snapped_to_ticks, Some(TICKS_PER_SECOND));
    }

    #[test]
    fn compact_move_preview_matches_full_apply_placements() {
        let edit = TimelineEdit::MoveClips {
            clip_ids: vec!["a".into()],
            delta_ticks: 47_500,
            target_track_id: Some("v2".into()),
            playhead_ticks: TICKS_PER_SECOND,
            snap_tolerance_ticks: 1_000,
            disable_snapping: false,
            ripple: false,
        };
        let full = apply_edit(&timeline(), &edit).unwrap();
        let preview = preview_edit(&timeline(), &edit).unwrap();
        assert_eq!(preview.snapped_to_ticks, full.snapped_to_ticks);
        assert_eq!(
            preview.placements,
            vec![placements(&full.timeline)["a"].clone()]
        );
        assert!(preview.removed_clip_ids.is_empty());
    }

    #[test]
    fn ripple_trim_closes_following_gap() {
        let result = apply_edit(
            &timeline(),
            &TimelineEdit::TrimClip {
                clip_id: "a".into(),
                edge: TrimEdge::End,
                target_ticks: TICKS_PER_SECOND / 2,
                playhead_ticks: 0,
                snap_tolerance_ticks: 0,
                disable_snapping: true,
                ripple: true,
            },
        )
        .unwrap();
        assert_eq!(
            result.timeline.tracks[0].clips[1].start_ticks,
            TICKS_PER_SECOND + TICKS_PER_SECOND / 2
        );
    }

    #[test]
    fn visible_query_is_bounded_to_three_hundred_nodes() {
        let stress = create_stress_timeline(&StressTimelineInput {
            duration_ticks: 2 * 60 * 60 * TICKS_PER_SECOND,
            track_count: 20,
            clip_count: 10_000,
            fps_num: 30_000,
            fps_den: 1_001,
        })
        .unwrap();
        let visible = visible_timeline(
            &stress,
            &VisibleTimelineQuery {
                start_ticks: 0,
                end_ticks: stress.duration_ticks,
                first_track: 0,
                last_track: 19,
                overscan_ticks: 0,
                max_nodes: 300,
            },
        )
        .unwrap();
        assert_eq!(visible.clips.len(), 300);
        assert_eq!(visible.total_matching, 10_000);
        assert!(visible.truncated);
    }

    #[test]
    fn rational_frame_tick_is_integer_and_stable() {
        assert_eq!(frame_ticks(&timeline()).unwrap(), 1_602);
    }

    proptest! {
        #[test]
        fn randomized_moves_never_create_negative_time(delta in -200_000i64..200_000i64) {
            let result = apply_edit(&timeline(), &TimelineEdit::MoveClips {
                clip_ids: vec!["a".into()],
                delta_ticks: delta,
                target_track_id: None,
                playhead_ticks: 0,
                snap_tolerance_ticks: 0,
                disable_snapping: true,
                ripple: false,
            });
            if let Ok(applied) = result {
                prop_assert!(applied.timeline.tracks.iter().flat_map(|track| &track.clips)
                    .all(|clip| clip.start_ticks >= 0 && clip.duration_ticks > 0));
            }
        }
    }
}
