#[cfg(target_arch = "wasm32")]
mod compositor;
#[cfg(target_arch = "wasm32")]
mod effects;
#[cfg(target_arch = "wasm32")]
mod gpu;
#[cfg(target_arch = "wasm32")]
mod masks;
#[cfg(target_arch = "wasm32")]
mod perf;

#[cfg(target_arch = "wasm32")]
pub use compositor::*;
#[cfg(target_arch = "wasm32")]
pub use effects::*;
#[cfg(target_arch = "wasm32")]
pub use gpu::*;
#[cfg(target_arch = "wasm32")]
pub use masks::*;
#[cfg(target_arch = "wasm32")]
pub use perf::*;
pub use time::*;

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
};
use wasm_bindgen::prelude::wasm_bindgen;

thread_local! {
    static TIMELINE_SESSIONS: RefCell<BTreeMap<String, studio_model::Timeline>> =
        const { RefCell::new(BTreeMap::new()) };
}

#[wasm_bindgen(js_name = studioCreateCampaign)]
pub fn studio_create_campaign(input_json: &str) -> Result<String, String> {
    let input: studio_model::CreateCampaignInput =
        serde_json::from_str(input_json).map_err(|error| error.to_string())?;
    let state = studio_model::create_campaign(input).map_err(|error| error.to_string())?;
    serde_json::to_string(&state).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = studioPlanConnectedSync)]
pub fn studio_plan_connected_sync(
    campaign_id: &str,
    request: &str,
    base: &str,
    head: &str,
    foreign_writer_lease: bool,
) -> Result<String, String> {
    edit_engine::plan_connected_sync(campaign_id, request, base, head, foreign_writer_lease)
}

#[wasm_bindgen(js_name = studioPrepareCommand)]
pub fn studio_prepare_command(state_json: &str, envelope_json: &str) -> Result<String, String> {
    edit_engine::prepare_command_json(state_json, envelope_json).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = studioSnapshotHash)]
pub fn studio_snapshot_hash(state_json: &str) -> Result<String, String> {
    let state: studio_model::StudioState =
        serde_json::from_str(state_json).map_err(|error| error.to_string())?;
    studio_model::snapshot_hash(&state).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = variantResolve)]
pub fn variant_resolve(state_json: &str, cell_id: &str) -> Result<String, String> {
    let state: studio_model::StudioState =
        serde_json::from_str(state_json).map_err(|error| error.to_string())?;
    let resolved = variant_engine::resolve(&state, cell_id).map_err(|error| error.to_string())?;
    serde_json::to_string(&resolved).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = variantProjectionPage)]
pub fn variant_projection_page(
    state_json: &str,
    page: u32,
    page_size: u32,
) -> Result<String, String> {
    let state: studio_model::StudioState =
        serde_json::from_str(state_json).map_err(|error| error.to_string())?;
    let projection = variant_engine::projection_page(&state, page, page_size)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&projection).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = variantThumbnailSchedule)]
pub fn variant_thumbnail_schedule(
    visible_cell_ids_json: &str,
    focused_cell_id: &str,
    prior_active_ids_json: &str,
    max_jobs: u32,
) -> Result<String, String> {
    let visible: Vec<String> =
        serde_json::from_str(visible_cell_ids_json).map_err(|error| error.to_string())?;
    let prior: Vec<String> =
        serde_json::from_str(prior_active_ids_json).map_err(|error| error.to_string())?;
    let focused = (!focused_cell_id.is_empty()).then_some(focused_cell_id);
    let schedule = variant_engine::thumbnail_schedule(&visible, focused, &prior, max_jobs)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&schedule).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = variantBrandKitFingerprint)]
pub fn variant_brand_kit_fingerprint(brand_kit_json: &str) -> Result<String, String> {
    let brand_kit: studio_model::BrandKit =
        serde_json::from_str(brand_kit_json).map_err(|error| error.to_string())?;
    variant_engine::brand_kit_fingerprint(&brand_kit).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = variantBuildRenderManifest)]
pub fn variant_build_render_manifest(state_json: &str, cell_id: &str) -> Result<String, String> {
    let state: studio_model::StudioState =
        serde_json::from_str(state_json).map_err(|error| error.to_string())?;
    let manifest =
        render_plan::build_manifest(&state, cell_id).map_err(|error| error.to_string())?;
    serde_json::to_string(&manifest).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderManifestChecksum)]
pub fn render_manifest_checksum(manifest_json: &str) -> Result<String, String> {
    let manifest: render_plan::RenderManifest =
        serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    render_plan::manifest_checksum(&manifest).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderFramePlan)]
pub fn render_frame_plan(manifest_json: &str, tick: f64) -> Result<String, String> {
    if !tick.is_finite() || tick.fract() != 0.0 || tick.abs() > 9_007_199_254_740_991.0 {
        return Err("invalid_frame_tick".into());
    }
    let manifest: render_plan::RenderManifest =
        serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    serde_json::to_string(&render_plan::render_frame_plan(&manifest, tick as i64)?)
        .map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderTiming)]
pub fn render_timing(manifest_json: &str) -> Result<String, String> {
    let manifest: render_plan::RenderManifest =
        serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    serde_json::to_string(&render_plan::render_timing(&manifest)).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderSourceCrop)]
pub fn render_source_crop(
    geometry_json: &str,
    source_width: u32,
    source_height: u32,
) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct Geometry {
        canvas: studio_model::CanvasSpec,
        crop: studio_model::CropOverride,
    }
    let geometry: Geometry =
        serde_json::from_str(geometry_json).map_err(|error| error.to_string())?;
    let rect = render_plan::render_source_crop(
        geometry.canvas,
        geometry.crop,
        source_width,
        source_height,
    )?;
    serde_json::to_string(&rect).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderRequiredAssets)]
pub fn render_required_assets(manifest_json: &str) -> Result<String, String> {
    let manifest: render_plan::RenderManifest =
        serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    serde_json::to_string(&render_plan::render_required_assets(&manifest)?)
        .map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderOverlays)]
pub fn render_overlays(manifest_json: &str) -> Result<String, String> {
    let manifest = serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    serde_json::to_string(&render_plan::render_overlays(&manifest)?)
        .map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderUntaggedVideoColorSpace)]
pub fn render_untagged_video_color_space() -> String {
    render_plan::untagged_video_color_space().to_string()
}

#[wasm_bindgen(js_name = appendSyncOutbox)]
pub fn append_sync_outbox(outbox_json: &str, command_json: &str) -> Result<String, String> {
    let outbox = serde_json::from_str(outbox_json).map_err(|error| format!("{error}"))?;
    let command = serde_json::from_str(command_json).map_err(|error| format!("{error}"))?;
    serde_json::to_string(&edit_engine::append_sync_outbox(outbox, command)?)
        .map_err(|error| format!("{error}"))
}

#[wasm_bindgen(js_name = acknowledgeSyncOutbox)]
pub fn acknowledge_sync_outbox(
    outbox_json: &str,
    request_id: &str,
    receipt_json: &str,
) -> Result<String, String> {
    let outbox = serde_json::from_str(outbox_json).map_err(|error| format!("{error}"))?;
    let receipt = serde_json::from_str(receipt_json).map_err(|error| format!("{error}"))?;
    serde_json::to_string(&edit_engine::acknowledge_sync_outbox(
        outbox, request_id, receipt,
    )?)
    .map_err(|error| format!("{error}"))
}

#[wasm_bindgen(js_name = forkRecovered)]
pub fn fork_recovered(
    state_json: &str,
    id: String,
    name: String,
    at: String,
) -> Result<String, String> {
    let state = serde_json::from_str(state_json).map_err(|error| format!("{error}"))?;
    serde_json::to_string(&edit_engine::fork_recovered(state, id, name, at)?)
        .map_err(|error| format!("{error}"))
}

#[wasm_bindgen(js_name = renderTextOverlay)]
pub fn render_text_overlay(manifest_json: &str, slot_id: &str) -> Result<Vec<u8>, String> {
    let manifest = serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    render_plan::raster_manifest_text(&manifest, slot_id)
}

#[wasm_bindgen(js_name = probeLogoPng)]
pub fn probe_logo_png(bytes: &[u8]) -> Result<String, String> {
    serde_json::to_string(&render_plan::probe_logo_png(bytes)?).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderLogoOverlay)]
pub fn render_logo_overlay(
    manifest_json: &str,
    slot_id: &str,
    bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let manifest = serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    render_plan::raster_manifest_logo(&manifest, slot_id, bytes)
}

#[wasm_bindgen(js_name = renderCreateLocalBatch)]
pub fn render_create_local_batch(
    specs_json: &str,
    succeeded_keys_json: &str,
    now: String,
) -> Result<String, String> {
    let specs: Vec<job_contracts::RenderJobSpec> =
        serde_json::from_str(specs_json).map_err(|error| error.to_string())?;
    let succeeded: BTreeSet<String> =
        serde_json::from_str(succeeded_keys_json).map_err(|error| error.to_string())?;
    let batch = job_contracts::create_local_render_batch(specs, &succeeded, now)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&batch).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderApplyEvent)]
pub fn render_apply_event(job_json: &str, event_json: &str, now: String) -> Result<String, String> {
    let job: job_contracts::PersistedRenderJob =
        serde_json::from_str(job_json).map_err(|error| error.to_string())?;
    let event: job_contracts::RenderJobEvent =
        serde_json::from_str(event_json).map_err(|error| error.to_string())?;
    let next =
        job_contracts::apply_render_event(&job, event, now).map_err(|error| error.to_string())?;
    serde_json::to_string(&next).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderCodecPreflight)]
pub fn render_codec_preflight(codec_json: &str, storage_json: &str) -> Result<String, String> {
    let codec: codec_policy::CodecCapability =
        serde_json::from_str(codec_json).map_err(|error| error.to_string())?;
    let storage: codec_policy::StorageCapability =
        serde_json::from_str(storage_json).map_err(|error| error.to_string())?;
    let result = codec_policy::preflight(&codec, &storage).map_err(|error| error.to_string())?;
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderFilename)]
pub fn render_filename(template: &str, context_json: &str) -> Result<String, String> {
    let context: render_plan::NamingContext =
        serde_json::from_str(context_json).map_err(|error| error.to_string())?;
    render_plan::render_filename(template, &context).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderUniqueFilenames)]
pub fn render_unique_filenames(names_json: &str) -> Result<String, String> {
    let names: Vec<String> = serde_json::from_str(names_json).map_err(|error| error.to_string())?;
    serde_json::to_string(&render_plan::unique_filenames(&names)).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderBuildArtifactReceipt)]
pub fn render_build_artifact_receipt(
    manifest_json: &str,
    cell_id: String,
    preset: String,
    filename: String,
    media_type: String,
    byte_length: &str,
    sha256: String,
) -> Result<String, String> {
    let manifest: render_plan::RenderManifest =
        serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    let byte_length = byte_length
        .parse::<u64>()
        .map_err(|error| error.to_string())?;
    let artifact = render_plan::build_artifact_receipt(
        &manifest,
        cell_id,
        preset,
        filename,
        media_type,
        byte_length,
        sha256,
    )
    .map_err(|error| error.to_string())?;
    serde_json::to_string(&artifact).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderNormalizeDeliverableManifest)]
pub fn render_normalize_deliverable_manifest(manifest_json: &str) -> Result<String, String> {
    let manifest: render_plan::DeliverableManifest =
        serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    let manifest =
        render_plan::normalize_deliverable_manifest(manifest).map_err(|error| error.to_string())?;
    serde_json::to_string(&manifest).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = renderValidateBundleReceipts)]
pub fn render_validate_bundle_receipts(
    bundle_json: &str,
    receipts_json: &str,
    new_campaign_id: &str,
) -> Result<String, String> {
    let bundle: render_plan::EditableCampaignBundle =
        serde_json::from_str(bundle_json).map_err(|error| error.to_string())?;
    let receipts: Vec<render_plan::BundleEntryReceipt> =
        serde_json::from_str(receipts_json).map_err(|error| error.to_string())?;
    let staged = render_plan::validate_bundle_receipts(&bundle, &receipts, new_campaign_id)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&staged).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = creativePreviewAssignments)]
pub fn creative_preview_assignments(
    state_json: &str,
    assignments_json: &str,
) -> Result<String, String> {
    let state: studio_model::StudioState =
        serde_json::from_str(state_json).map_err(|error| error.to_string())?;
    let assignments: Vec<studio_model::SlotAssignment> =
        serde_json::from_str(assignments_json).map_err(|error| error.to_string())?;
    let preview = creative_engine::preview_assignments(&state.campaign, &assignments)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&preview).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = timelineVisibleClips)]
pub fn timeline_visible_clips(timeline_json: &str, query_json: &str) -> Result<String, String> {
    let timeline: studio_model::Timeline =
        serde_json::from_str(timeline_json).map_err(|error| error.to_string())?;
    let query: timeline_engine::VisibleTimelineQuery =
        serde_json::from_str(query_json).map_err(|error| error.to_string())?;
    let result =
        timeline_engine::visible_timeline(&timeline, &query).map_err(|error| error.to_string())?;
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = timelineApplyEdit)]
pub fn timeline_apply_edit(timeline_json: &str, edit_json: &str) -> Result<String, String> {
    let timeline: studio_model::Timeline =
        serde_json::from_str(timeline_json).map_err(|error| error.to_string())?;
    let edit: studio_model::TimelineEdit =
        serde_json::from_str(edit_json).map_err(|error| error.to_string())?;
    let result =
        timeline_engine::apply_edit(&timeline, &edit).map_err(|error| error.to_string())?;
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = timelineSessionSetBase)]
pub fn timeline_session_set_base(session_id: &str, timeline_json: &str) -> Result<(), String> {
    let timeline: studio_model::Timeline =
        serde_json::from_str(timeline_json).map_err(|error| error.to_string())?;
    timeline_engine::validate_timeline(&timeline).map_err(|error| error.to_string())?;
    TIMELINE_SESSIONS.with(|sessions| {
        sessions
            .borrow_mut()
            .insert(session_id.to_owned(), timeline);
    });
    Ok(())
}

#[wasm_bindgen(js_name = timelineSessionVisibleClips)]
pub fn timeline_session_visible_clips(
    session_id: &str,
    query_json: &str,
) -> Result<String, String> {
    let query: timeline_engine::VisibleTimelineQuery =
        serde_json::from_str(query_json).map_err(|error| error.to_string())?;
    TIMELINE_SESSIONS.with(|sessions| {
        let sessions = sessions.borrow();
        let timeline = sessions
            .get(session_id)
            .ok_or_else(|| format!("timeline session {session_id} is not initialized"))?;
        let result = timeline_engine::visible_timeline_from_validated(timeline, &query);
        serde_json::to_string(&result).map_err(|error| error.to_string())
    })
}

#[wasm_bindgen(js_name = timelineSessionPreviewEdit)]
pub fn timeline_session_preview_edit(session_id: &str, edit_json: &str) -> Result<String, String> {
    let edit: studio_model::TimelineEdit =
        serde_json::from_str(edit_json).map_err(|error| error.to_string())?;
    TIMELINE_SESSIONS.with(|sessions| {
        let sessions = sessions.borrow();
        let timeline = sessions
            .get(session_id)
            .ok_or_else(|| format!("timeline session {session_id} is not initialized"))?;
        let result =
            timeline_engine::preview_edit(timeline, &edit).map_err(|error| error.to_string())?;
        serde_json::to_string(&result).map_err(|error| error.to_string())
    })
}

#[wasm_bindgen(js_name = timelineSessionRelease)]
pub fn timeline_session_release(session_id: &str) {
    TIMELINE_SESSIONS.with(|sessions| {
        sessions.borrow_mut().remove(session_id);
    });
}

#[wasm_bindgen(js_name = timelineDefault)]
pub fn timeline_default() -> Result<String, String> {
    serde_json::to_string(&studio_model::Timeline::default()).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = timelineCreateStressFixture)]
pub fn timeline_create_stress_fixture(input_json: &str) -> Result<String, String> {
    let input: timeline_engine::StressTimelineInput =
        serde_json::from_str(input_json).map_err(|error| error.to_string())?;
    let timeline =
        timeline_engine::create_stress_timeline(&input).map_err(|error| error.to_string())?;
    serde_json::to_string(&timeline).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = mediaPlanDerivatives)]
pub fn media_plan_derivatives(probe_json: &str) -> Result<String, String> {
    let report: media_plan::ProbeReport =
        serde_json::from_str(probe_json).map_err(|error| error.to_string())?;
    let plan = media_plan::plan_derivatives(&report).map_err(|error| error.to_string())?;
    serde_json::to_string(&plan).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = transcriptSegment)]
pub fn transcript_segment(
    artifact_json: &str,
    max_words: usize,
    max_duration_ticks: i64,
) -> Result<String, String> {
    let artifact: studio_model::TranscriptArtifact =
        serde_json::from_str(artifact_json).map_err(|error| error.to_string())?;
    let track = transcript_engine::segment_words(&artifact, max_words, max_duration_ticks)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&track).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = transcriptDiagnose)]
pub fn transcript_diagnose(
    track_json: &str,
    profile_json: &str,
    manifest_json: &str,
    safe_width_px: u32,
) -> Result<String, String> {
    let track: studio_model::CaptionTrack =
        serde_json::from_str(track_json).map_err(|error| error.to_string())?;
    let profile: studio_model::LocaleProfile =
        serde_json::from_str(profile_json).map_err(|error| error.to_string())?;
    let manifest: studio_model::FontManifest =
        serde_json::from_str(manifest_json).map_err(|error| error.to_string())?;
    let diagnostics = transcript_engine::diagnose_track(&track, &profile, &manifest, safe_width_px)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&diagnostics).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = jobBuildIdempotencyKey)]
pub fn job_build_idempotency_key(
    kind: &str,
    asset_hash: &str,
    normalized_options_json: &str,
    engine_version: &str,
) -> Result<String, String> {
    let kind = match kind {
        "probe" => job_contracts::JobKind::Probe,
        "proxy" => job_contracts::JobKind::Proxy,
        "waveform" => job_contracts::JobKind::Waveform,
        "transcription" => job_contracts::JobKind::Transcription,
        "thumbnail" => job_contracts::JobKind::Thumbnail,
        "render" => job_contracts::JobKind::Render,
        _ => return Err(format!("unknown job kind {kind}")),
    };
    Ok(job_contracts::build_idempotency_key(
        kind,
        asset_hash,
        normalized_options_json,
        engine_version,
    ))
}

#[wasm_bindgen(js_name = jobCreate)]
pub fn job_create(spec_json: &str, now: String) -> Result<String, String> {
    job_contracts::create_job_json(spec_json, now).map_err(|error| error.to_string())
}

#[wasm_bindgen(js_name = jobApplyEvent)]
pub fn job_apply_event(job_json: &str, event_json: &str, now: String) -> Result<String, String> {
    job_contracts::apply_event_json(job_json, event_json, now).map_err(|error| error.to_string())
}

#[cfg(test)]
mod studio_contract_tests {
    #[test]
    fn untagged_sdr_decode_policy_matches_native_contract() {
        assert_eq!(
            super::render_untagged_video_color_space(),
            render_plan::untagged_video_color_space().to_string()
        );
        assert_eq!(
            render_plan::untagged_video_color_space()["matrix"],
            "smpte170m"
        );
        assert_eq!(
            render_plan::untagged_video_color_space()["fullRange"],
            false
        );
    }
    #[test]
    fn shared_crop_facade_matches_native() {
        for position in [-10000, -5000, 0, 5000, 10000] {
            let canvas = studio_model::CanvasSpec {
                width: 1080,
                height: 1920,
            };
            let crop = studio_model::CropOverride {
                x_basis_points: position,
                y_basis_points: position,
                scale_basis_points: 20000,
            };
            let geometry = serde_json::json!({"canvas":canvas,"crop":crop}).to_string();
            assert_eq!(
                super::render_source_crop(&geometry, 640, 360).unwrap(),
                serde_json::to_string(
                    &render_plan::render_source_crop(canvas, crop, 640, 360).unwrap()
                )
                .unwrap()
            );
        }
    }
    use super::*;

    #[test]
    fn wasm_facade_matches_native_snapshot_hash() {
        let input = r#"{
            "campaign_id":"campaign-1",
            "campaign_name":"Launch",
            "master_sequence_id":"sequence-1",
            "created_at":"2026-08-27T00:00:00Z",
            "scenes":[{
                "id":"scene-a",
                "name":"Scene A",
                "created_at":"2026-08-27T00:00:00Z",
                "updated_at":"2026-08-27T00:00:00Z"
            }],
            "imported_from":null
        }"#;
        let state_json = studio_create_campaign(input).unwrap();
        let state: studio_model::StudioState = serde_json::from_str(&state_json).unwrap();
        assert_eq!(
            studio_snapshot_hash(&state_json).unwrap(),
            studio_model::snapshot_hash(&state).unwrap()
        );
    }

    #[test]
    fn timeline_query_facade_matches_native_interval_result() {
        let input = timeline_engine::StressTimelineInput {
            duration_ticks: 2 * 60 * 60 * studio_model::TICKS_PER_SECOND,
            track_count: 20,
            clip_count: 10_000,
            fps_num: 30_000,
            fps_den: 1_001,
        };
        let timeline_json =
            timeline_create_stress_fixture(&serde_json::to_string(&input).unwrap()).unwrap();
        let query = timeline_engine::VisibleTimelineQuery {
            start_ticks: 0,
            end_ticks: 60 * studio_model::TICKS_PER_SECOND,
            first_track: 0,
            last_track: 19,
            overscan_ticks: studio_model::TICKS_PER_SECOND,
            max_nodes: 300,
        };
        let wasm = timeline_visible_clips(&timeline_json, &serde_json::to_string(&query).unwrap())
            .unwrap();
        let timeline: studio_model::Timeline = serde_json::from_str(&timeline_json).unwrap();
        let native = timeline_engine::visible_timeline(&timeline, &query).unwrap();
        assert_eq!(wasm, serde_json::to_string(&native).unwrap());
    }

    #[test]
    fn variant_resolve_and_render_manifest_facades_match_native() {
        let input = r#"{
            "campaign_id":"campaign-1",
            "campaign_name":"Launch",
            "master_sequence_id":"sequence-1",
            "created_at":"2026-08-28T00:00:00Z",
            "scenes":[{
                "id":"scene-a",
                "name":"Scene A",
                "created_at":"2026-08-28T00:00:00Z",
                "updated_at":"2026-08-28T00:00:00Z"
            }],
            "imported_from":null
        }"#;
        let state_json = studio_create_campaign(input).unwrap();
        let mut state: studio_model::StudioState = serde_json::from_str(&state_json).unwrap();
        variant_engine::create_delivery_profile(
            &mut state.campaign,
            studio_model::DeliveryProfile {
                id: "profile-vertical".into(),
                name: "9:16".into(),
                canvas: studio_model::CanvasSpec {
                    width: 1080,
                    height: 1920,
                },
                safe_area: studio_model::SafeArea {
                    top_basis_points: 800,
                    right_basis_points: 600,
                    bottom_basis_points: 1400,
                    left_basis_points: 600,
                },
                locale: "en".into(),
                layout_constraints: vec!["safe_area".into()],
                version: 1,
                locale_profile_id: None,
            },
            "cell-vertical".into(),
        )
        .unwrap();
        creative_engine::create_slots(
            &mut state.campaign,
            vec![studio_model::Slot {
                id: "hook".into(),
                name: "Hook".into(),
                kind: studio_model::SlotKind::Hook,
                master_entity_id: "clip-master".into(),
                master_value: studio_model::SlotValue::Media {
                    asset_id: "asset-master".into(),
                    duration_ticks: 96_000,
                },
                duration_ticks: 96_000,
                fit_policy: studio_model::SlotFitPolicy::ExactDuration,
                style_fingerprint: "style-v1".into(),
                version: 1,
            }],
        )
        .unwrap();
        creative_engine::create_creative_sets(
            &mut state.campaign,
            vec![studio_model::CreativeSet {
                id: "hook-a".into(),
                name: "Hook A".into(),
                replacements: Vec::new(),
                version: 1,
            }],
            vec![studio_model::VariantCell {
                id: "hook-a-vertical".into(),
                creative_set_id: "hook-a".into(),
                delivery_profile_id: "profile-vertical".into(),
                layout_override: None,
                version: 1,
            }],
        )
        .unwrap();
        let assignments = vec![studio_model::SlotAssignment {
            creative_set_id: "hook-a".into(),
            slot_id: "hook".into(),
            value: studio_model::SlotValue::Media {
                asset_id: "asset-hook-a".into(),
                duration_ticks: 96_000,
            },
        }];
        let state_json = serde_json::to_string(&state).unwrap();
        assert_eq!(
            variant_resolve(&state_json, "cell-vertical").unwrap(),
            serde_json::to_string(&variant_engine::resolve(&state, "cell-vertical").unwrap())
                .unwrap()
        );
        assert_eq!(
            variant_resolve(&state_json, "hook-a-vertical").unwrap(),
            serde_json::to_string(&variant_engine::resolve(&state, "hook-a-vertical").unwrap())
                .unwrap()
        );
        assert_eq!(
            creative_preview_assignments(
                &state_json,
                &serde_json::to_string(&assignments).unwrap()
            )
            .unwrap(),
            serde_json::to_string(
                &creative_engine::preview_assignments(&state.campaign, &assignments).unwrap()
            )
            .unwrap()
        );
        assert_eq!(
            variant_build_render_manifest(&state_json, "cell-vertical").unwrap(),
            serde_json::to_string(&render_plan::build_manifest(&state, "cell-vertical").unwrap())
                .unwrap()
        );
    }

    #[test]
    fn m6_projection_brand_thumbnail_and_job_facades_match_native() {
        let input = r#"{
            "campaign_id":"campaign-m6",
            "campaign_name":"Matrix",
            "master_sequence_id":"sequence-m6",
            "created_at":"2026-08-28T00:00:00Z",
            "scenes":[{
                "id":"scene-a",
                "name":"Scene A",
                "created_at":"2026-08-28T00:00:00Z",
                "updated_at":"2026-08-28T00:00:00Z"
            }],
            "imported_from":null
        }"#;
        let mut state: studio_model::StudioState =
            serde_json::from_str(&studio_create_campaign(input).unwrap()).unwrap();
        variant_engine::add_delivery_profiles(
            &mut state.campaign,
            vec![studio_model::DeliveryProfile {
                id: "profile-square".into(),
                name: "1:1".into(),
                canvas: studio_model::CanvasSpec {
                    width: 1080,
                    height: 1080,
                },
                safe_area: studio_model::SafeArea {
                    top_basis_points: 800,
                    right_basis_points: 800,
                    bottom_basis_points: 800,
                    left_basis_points: 800,
                },
                locale: "en".into(),
                layout_constraints: vec!["text_size_px:24".into()],
                version: 1,
                locale_profile_id: None,
            }],
        )
        .unwrap();
        variant_engine::enable_variant_cells(
            &mut state.campaign,
            vec![studio_model::VariantCell {
                id: "cell-square".into(),
                creative_set_id: "master".into(),
                delivery_profile_id: "profile-square".into(),
                layout_override: None,
                version: 1,
            }],
        )
        .unwrap();
        let kit = studio_model::BrandKit {
            id: "kit-m6".into(),
            name: "Kit".into(),
            version: 1,
            fingerprint: String::new(),
            provenance: studio_model::BrandKitProvenance {
                source: "brand-ops".into(),
                revision: "r1".into(),
                asset_hash: "b".repeat(64),
            },
            logo_required: false,
            allowed_color_tokens: Vec::new(),
            allowed_font_ids: Vec::new(),
            minimum_text_size_px: 20,
            custom_safe_regions: Vec::new(),
            master_duration: None,
        };
        let kit_json = serde_json::to_string(&kit).unwrap();
        assert_eq!(
            variant_brand_kit_fingerprint(&kit_json).unwrap(),
            variant_engine::brand_kit_fingerprint(&kit).unwrap()
        );
        variant_engine::set_brand_kit(&mut state.campaign, kit).unwrap();
        let state_json = serde_json::to_string(&state).unwrap();
        assert_eq!(
            variant_projection_page(&state_json, 0, 80).unwrap(),
            serde_json::to_string(&variant_engine::projection_page(&state, 0, 80).unwrap())
                .unwrap()
        );
        let visible = vec!["cell-square".to_owned(), "cell-other".to_owned()];
        let prior = vec!["cell-offscreen".to_owned()];
        assert_eq!(
            variant_thumbnail_schedule(
                &serde_json::to_string(&visible).unwrap(),
                "cell-square",
                &serde_json::to_string(&prior).unwrap(),
                2,
            )
            .unwrap(),
            serde_json::to_string(
                &variant_engine::thumbnail_schedule(&visible, Some("cell-square"), &prior, 2,)
                    .unwrap()
            )
            .unwrap()
        );
        let options = r#"{"cell_id":"cell-square"}"#;
        assert_eq!(
            job_build_idempotency_key("thumbnail", "a", options, "m6-v1").unwrap(),
            job_contracts::build_idempotency_key(
                job_contracts::JobKind::Thumbnail,
                "a",
                options,
                "m6-v1",
            )
        );
    }

    #[test]
    fn transcript_facade_matches_native_segmentation() {
        let artifact = studio_model::TranscriptArtifact {
            id: "transcript-parity".into(),
            asset_hash: "a".repeat(64),
            locale: "en-US".into(),
            words: vec![
                studio_model::TranscriptWord {
                    id: "w1".into(),
                    text: "Create".into(),
                    start_ticks: 0,
                    end_ticks: 24_000,
                    confidence_milli: 990,
                },
                studio_model::TranscriptWord {
                    id: "w2".into(),
                    text: "variants".into(),
                    start_ticks: 24_000,
                    end_ticks: 48_000,
                    confidence_milli: 980,
                },
            ],
            model: studio_model::ModelProvenance {
                id: "openai/whisper-tiny".into(),
                revision: "m5-pinned".into(),
                license: "MIT".into(),
            },
            created_at: "2026-08-28T00:00:00Z".into(),
        };
        let artifact_json = serde_json::to_string(&artifact).unwrap();
        assert_eq!(
            transcript_segment(&artifact_json, 3, 96_000).unwrap(),
            serde_json::to_string(&transcript_engine::segment_words(&artifact, 3, 96_000).unwrap())
                .unwrap()
        );
    }
    #[test]
    fn m7_render_job_package_and_preflight_facades_match_native() {
        let input = r#"{
            "campaign_id":"campaign-m7",
            "campaign_name":"Export",
            "master_sequence_id":"sequence-m7",
            "created_at":"2026-09-03T00:00:00Z",
            "scenes":[{
                "id":"scene-a",
                "name":"Scene A",
                "created_at":"2026-09-03T00:00:00Z",
                "updated_at":"2026-09-03T00:00:00Z"
            }],
            "imported_from":null
        }"#;
        let mut state: studio_model::StudioState =
            serde_json::from_str(&studio_create_campaign(input).unwrap()).unwrap();
        state.campaign.master_sequence.scenes[0].timeline = Some(studio_model::Timeline {
            duration_ticks: 96_000,
            ..Default::default()
        });
        variant_engine::create_delivery_profile(
            &mut state.campaign,
            studio_model::DeliveryProfile {
                id: "profile-vertical".into(),
                name: "9:16".into(),
                canvas: studio_model::CanvasSpec {
                    width: 1080,
                    height: 1920,
                },
                safe_area: studio_model::SafeArea {
                    top_basis_points: 800,
                    right_basis_points: 600,
                    bottom_basis_points: 1400,
                    left_basis_points: 600,
                },
                locale: "en".into(),
                layout_constraints: vec!["safe_area".into()],
                version: 1,
                locale_profile_id: None,
            },
            "cell-m7".into(),
        )
        .unwrap();
        let state_json = serde_json::to_string(&state).unwrap();
        let manifest = render_plan::build_manifest(&state, "cell-m7").unwrap();
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        assert_eq!(
            render_manifest_checksum(&manifest_json).unwrap(),
            render_plan::manifest_checksum(&manifest).unwrap()
        );
        assert_eq!(
            render_timing(&manifest_json).unwrap(),
            serde_json::to_string(&render_plan::render_timing(&manifest)).unwrap()
        );
        let capability = codec_policy::CodecCapability {
            schema_version: 1,
            provider: codec_policy::CodecProviderKind::BrowserWebCodecs,
            preset: codec_policy::ExportPreset::WebmVp9Opus,
            video_supported: true,
            audio_supported: true,
            streaming_sink_supported: true,
        };
        let storage = codec_policy::StorageCapability {
            available_bytes: 10_000,
            required_bytes: 1_000,
            opfs_supported: true,
        };
        assert_eq!(
            render_codec_preflight(
                &serde_json::to_string(&capability).unwrap(),
                &serde_json::to_string(&storage).unwrap()
            )
            .unwrap(),
            serde_json::to_string(&codec_policy::preflight(&capability, &storage).unwrap())
                .unwrap()
        );
        let context = render_plan::NamingContext {
            campaign: "Campaign".into(),
            creative_set: "Master".into(),
            profile: "9x16".into(),
            cell: "cell-m7".into(),
        };
        assert_eq!(
            render_filename(
                "{campaign}_{creative_set}_{profile}.webm",
                &serde_json::to_string(&context).unwrap()
            )
            .unwrap(),
            render_plan::render_filename("{campaign}_{creative_set}_{profile}.webm", &context)
                .unwrap()
        );
        assert_eq!(
            variant_build_render_manifest(&state_json, "cell-m7").unwrap(),
            manifest_json
        );
    }
}
