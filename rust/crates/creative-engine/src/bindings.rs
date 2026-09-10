use crate::CreativeError;
use studio_model::{Campaign, MasterRenderBinding, SlotRenderTarget, SlotValue, TrackKind};

fn invalid(code: &str) -> CreativeError {
    CreativeError::InvalidBinding(code.into())
}

pub fn validate_slot_binding(
    campaign: &Campaign,
    binding: &MasterRenderBinding,
) -> Result<(), CreativeError> {
    let slot = campaign
        .slots
        .iter()
        .find(|slot| slot.id == binding.slot_id)
        .ok_or_else(|| CreativeError::SlotNotFound(binding.slot_id.clone()))?;
    let scene_id = match &binding.target {
        SlotRenderTarget::Clip { scene_id, .. } | SlotRenderTarget::Overlay { scene_id, .. } => {
            scene_id
        }
    };
    let timeline = campaign
        .master_sequence
        .scenes
        .iter()
        .find(|scene| &scene.id == scene_id)
        .and_then(|scene| scene.timeline.as_ref())
        .ok_or_else(|| invalid("scene_timeline_missing"))?;
    match &binding.target {
        SlotRenderTarget::Clip { clip_id, .. } => {
            let clip = timeline
                .tracks
                .iter()
                .filter(|track| track.kind == TrackKind::Video)
                .flat_map(|track| &track.clips)
                .find(|clip| &clip.id == clip_id)
                .ok_or_else(|| invalid("video_clip_missing"))?;
            let SlotValue::Media {
                asset_id,
                duration_ticks,
            } = &slot.master_value
            else {
                return Err(invalid("media_slot_required"));
            };
            if &clip.asset_id != asset_id
                || clip.duration_ticks != *duration_ticks
                || clip.duration_ticks != slot.duration_ticks
            {
                return Err(invalid("master_asset_or_duration_mismatch"));
            }
            if campaign
                .render_bindings
                .iter()
                .any(|other| other.slot_id != binding.slot_id && other.target == binding.target)
            {
                return Err(invalid("clip_already_bound"));
            }
        }
        SlotRenderTarget::Overlay {
            start_ticks,
            end_ticks,
            rect,
            text_style,
            ..
        } => {
            let duration = timeline.duration_ticks;
            if *start_ticks < 0 || end_ticks <= start_ticks || *end_ticks > duration {
                return Err(invalid("overlay_time_out_of_scene"));
            }
            if rect.width == 0
                || rect.height == 0
                || u32::from(rect.x) + u32::from(rect.width) > 10000
                || u32::from(rect.y) + u32::from(rect.height) > 10000
            {
                return Err(invalid("overlay_rectangle_out_of_canvas"));
            }
            match (&slot.master_value, text_style) {
                (SlotValue::Text { .. }, Some(style)) => {
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
                        return Err(invalid("explicit_pinned_text_style_required"));
                    }
                }
                (SlotValue::Logo { .. }, None) => {}
                _ => return Err(invalid("overlay_slot_style_mismatch")),
            }
        }
    }
    Ok(())
}

pub fn set_slot_binding(
    campaign: &mut Campaign,
    binding: MasterRenderBinding,
) -> Result<(), CreativeError> {
    validate_slot_binding(campaign, &binding)?;
    campaign
        .render_bindings
        .retain(|other| other.slot_id != binding.slot_id);
    campaign.render_bindings.push(binding);
    campaign
        .render_bindings
        .sort_by(|a, b| a.slot_id.cmp(&b.slot_id));
    Ok(())
}

pub fn clear_slot_binding(campaign: &mut Campaign, slot_id: &str) -> Result<(), CreativeError> {
    if !campaign.slots.iter().any(|slot| slot.id == slot_id) {
        return Err(CreativeError::SlotNotFound(slot_id.into()));
    }
    campaign
        .render_bindings
        .retain(|binding| binding.slot_id != slot_id);
    Ok(())
}
