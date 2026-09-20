/* tslint:disable */
/* eslint-disable */
export interface FloorToFrameOptions {
    time: MediaTime;
    rate: FrameRate;
}

export interface FormatTimecodeOptions {
    time: MediaTime;
    format?: TimeCodeFormat;
    rate?: FrameRate;
}

export interface FrameRate {
    numerator: number;
    denominator: number;
}

export interface GuessTimecodeFormatOptions {
    timeCode: string;
}

export interface IsFrameAlignedOptions {
    time: MediaTime;
    rate: FrameRate;
}

export interface LastFrameTimeOptions {
    duration: MediaTime;
    rate: FrameRate;
}

export interface MediaTimeAddOptions {
    lhs: MediaTime;
    rhs: MediaTime;
}

export interface MediaTimeClampOptions {
    time: MediaTime;
    min: MediaTime;
    max: MediaTime;
}

export interface MediaTimeFromFrameOptions {
    frame: number;
    rate: FrameRate;
}

export interface MediaTimeFromSecondsOptions {
    seconds: number;
}

export interface MediaTimeMaxOptions {
    lhs: MediaTime;
    rhs: MediaTime;
}

export interface MediaTimeMinOptions {
    lhs: MediaTime;
    rhs: MediaTime;
}

export interface MediaTimeSubOptions {
    lhs: MediaTime;
    rhs: MediaTime;
}

export interface MediaTimeToFrameOptions {
    time: MediaTime;
    rate: FrameRate;
}

export interface MediaTimeToSecondsOptions {
    time: MediaTime;
}

export interface ParseTimecodeOptions {
    timeCode: string;
    format?: TimeCodeFormat;
    rate?: FrameRate;
}

export interface RoundToFrameOptions {
    time: MediaTime;
    rate: FrameRate;
}

export interface SnappedSeekTimeOptions {
    time: MediaTime;
    duration: MediaTime;
    rate: FrameRate;
}

export type MediaTime = number;

export type TimeCodeFormat = "MM:SS" | "HH:MM:SS" | "HH:MM:SS:CS" | "HH:MM:SS:FF";


/**
 * Isolated rendering instance owned by one preview, export, thumbnail, or editor surface.
 */
export class CompositorSession {
    free(): void;
    [Symbol.dispose](): void;
    canvas(): HTMLCanvasElement;
    constructor(width: number, height: number);
    releaseTexture(id: string): void;
    renderFrame(options: any): void;
    resize(width: number, height: number): void;
    uploadTexture(options: any): void;
}

export function TICKS_PER_SECOND(): number;

export function acknowledgeSyncOutbox(outbox_json: string, request_id: string, receipt_json: string): string;

export function appendSyncOutbox(outbox_json: string, command_json: string): string;

export function applyEffectPasses(options: any): OffscreenCanvas;

export function applyMaskFeather(options: any): OffscreenCanvas;

export function campaignOriginalHashes(state_json: string): string;

export function creativePreviewAssignments(state_json: string, assignments_json: string): string;

export function floorToFrame(arg0: FloorToFrameOptions): MediaTime | undefined;

export function forkRecovered(state_json: string, id: string, name: string, at: string): string;

export function formatTimecode(arg0: FormatTimecodeOptions): string | undefined;

export function getLastFrameProfile(): Array<any>;

export function guessTimecodeFormat(arg0: GuessTimecodeFormatOptions): TimeCodeFormat | undefined;

export function initializeGpu(): Promise<void>;

export function isFrameAligned(arg0: IsFrameAlignedOptions): boolean | undefined;

export function jobApplyEvent(job_json: string, event_json: string, now: string): string;

export function jobBuildIdempotencyKey(kind: string, asset_hash: string, normalized_options_json: string, engine_version: string): string;

export function jobCreate(spec_json: string, now: string): string;

export function lastFrameTime(arg0: LastFrameTimeOptions): MediaTime | undefined;

export function mediaPlanDerivatives(probe_json: string): string;

export function mediaTimeAdd(arg0: MediaTimeAddOptions): MediaTime;

export function mediaTimeClamp(arg0: MediaTimeClampOptions): MediaTime;

export function mediaTimeFromFrame(arg0: MediaTimeFromFrameOptions): MediaTime | undefined;

export function mediaTimeFromSeconds(arg0: MediaTimeFromSecondsOptions): MediaTime | undefined;

export function mediaTimeMax(arg0: MediaTimeMaxOptions): MediaTime;

export function mediaTimeMin(arg0: MediaTimeMinOptions): MediaTime;

export function mediaTimeSub(arg0: MediaTimeSubOptions): MediaTime;

export function mediaTimeToFrame(arg0: MediaTimeToFrameOptions): bigint | undefined;

export function mediaTimeToSeconds(arg0: MediaTimeToSecondsOptions): number;

export function parseTimecode(arg0: ParseTimecodeOptions): MediaTime | undefined;

export function probeLogoPng(bytes: Uint8Array): string;

export function renderApplyEvent(job_json: string, event_json: string, now: string): string;

export function renderBuildArtifactReceipt(manifest_json: string, cell_id: string, preset: string, filename: string, media_type: string, byte_length: string, sha256: string): string;

export function renderCodecPreflight(codec_json: string, storage_json: string): string;

export function renderCreateConnectedBatch(owner: string, batch_id: string, specs_json: string, now: string): string;

export function renderCreateLocalBatch(specs_json: string, succeeded_keys_json: string, now: string): string;

export function renderFilename(template: string, context_json: string): string;

export function renderFramePlan(manifest_json: string, tick: number): string;

export function renderLogoOverlay(manifest_json: string, slot_id: string, bytes: Uint8Array): Uint8Array;

export function renderManifestChecksum(manifest_json: string): string;

export function renderNormalizeDeliverableManifest(manifest_json: string): string;

export function renderOverlays(manifest_json: string): string;

export function renderRequiredAssets(manifest_json: string): string;

export function renderSourceCrop(geometry_json: string, source_width: number, source_height: number): string;

export function renderTextOverlay(manifest_json: string, slot_id: string): Uint8Array;

export function renderTiming(manifest_json: string): string;

export function renderUniqueFilenames(names_json: string): string;

export function renderUntaggedVideoColorSpace(): string;

export function renderValidateBundleReceipts(bundle_json: string, receipts_json: string, new_campaign_id: string): string;

export function renderValidateConnectedRequest(request_json: string): string;

export function roundToFrame(arg0: RoundToFrameOptions): MediaTime | undefined;

export function snappedSeekTime(arg0: SnappedSeekTimeOptions): MediaTime | undefined;

export function studioCreateCampaign(input_json: string): string;

export function studioPlanConnectedSync(campaign_id: string, request: string, base: string, head: string, foreign_writer_lease: boolean): string;

export function studioPrepareCommand(state_json: string, envelope_json: string): string;

export function studioSnapshotHash(state_json: string): string;

export function timelineApplyEdit(timeline_json: string, edit_json: string): string;

export function timelineCreateStressFixture(input_json: string): string;

export function timelineDefault(): string;

export function timelineSessionPreviewEdit(session_id: string, edit_json: string): string;

export function timelineSessionRelease(session_id: string): void;

export function timelineSessionSetBase(session_id: string, timeline_json: string): void;

export function timelineSessionVisibleClips(session_id: string, query_json: string): string;

export function timelineVisibleClips(timeline_json: string, query_json: string): string;

export function transcriptDiagnose(track_json: string, profile_json: string, manifest_json: string, safe_width_px: number): string;

export function transcriptSegment(artifact_json: string, max_words: number, max_duration_ticks: bigint): string;

export function variantBrandKitFingerprint(brand_kit_json: string): string;

export function variantBuildRenderManifest(state_json: string, cell_id: string): string;

export function variantProjectionPage(state_json: string, page: number, page_size: number): string;

export function variantResolve(state_json: string, cell_id: string): string;

export function variantThumbnailSchedule(visible_cell_ids_json: string, focused_cell_id: string, prior_active_ids_json: string, max_jobs: number): string;
