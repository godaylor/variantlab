import type {
	BulkAssignmentPreview,
	CodecCapability,
	DeliverableArtifact,
	DeliverableManifest,
	DestinationKind,
	LocalRenderBatch,
	NamingContext,
	PersistedRenderJob,
	RenderJobEvent,
	RenderJobSpec,
	RenderPreflight,
	StorageCapability,
	CommandEnvelope,
	CommandPayload,
	CreateCampaignInput,
	DerivativePlan,
	JobEvent,
	JobKind,
	JobSpec,
	PersistedJob,
	PrepareResult,
	PreparedCommit,
	ProbeReport,
	RenderManifest,
	RenderCropRect,
	CanvasSpec,
	CropOverride,
	ResolvedVariant,
	SceneScope,
	SlotAssignment,
	StressTimelineInput,
	StudioState,
	Timeline,
	TimelineEdit,
	TimelineEditResult,
	TimelinePreviewResult,
	VariantScope,
	VariantProjectionPage,
	ThumbnailSchedule,
	VisibleTimelineQuery,
	VisibleTimelineResult,
} from "@variantlab/studio-contract";
import {
	creativePreviewAssignments,
	jobApplyEvent,
	jobBuildIdempotencyKey,
	jobCreate,
	mediaPlanDerivatives,
	renderApplyEvent,
	renderBuildArtifactReceipt,
	renderCodecPreflight,
	renderCreateLocalBatch,
	renderFilename,
	renderManifestChecksum,
	renderSourceCrop,
	renderNormalizeDeliverableManifest,
	renderUniqueFilenames,
	studioCreateCampaign,
	studioPrepareCommand,
	studioSnapshotHash,
	timelineCreateStressFixture,
	timelineApplyEdit,
	timelineDefault,
	timelineSessionPreviewEdit,
	timelineSessionRelease,
	timelineSessionSetBase,
	timelineSessionVisibleClips,
	timelineVisibleClips,
	variantBuildRenderManifest,
	variantProjectionPage,
	variantThumbnailSchedule,
	variantResolve,
} from "variantlab-wasm";

const SCHEMA_VERSION = 1;

export function buildRenderSourceCrop({ canvas, crop, sourceWidth, sourceHeight }: { canvas: CanvasSpec; crop: CropOverride; sourceWidth: number; sourceHeight: number }): RenderCropRect {
	return parseContract<RenderCropRect>({ json: renderSourceCrop(JSON.stringify({ canvas, crop }), sourceWidth, sourceHeight), label: "RenderCropRect contract" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStudioState(value: unknown): value is StudioState {
	if (!isRecord(value) || !isRecord(value.campaign)) return false;
	const masterSequence = value.campaign.master_sequence;
	return (
		typeof value.schema_version === "number" &&
		typeof value.campaign.id === "string" &&
		typeof value.campaign.revision === "number" &&
		isRecord(masterSequence) &&
		typeof masterSequence.id === "string" &&
		Array.isArray(masterSequence.scenes) &&
		Array.isArray(value.history) &&
		Array.isArray(value.redo)
	);
}

function isPreparedCommit(value: unknown): value is PreparedCommit {
	return (
		isRecord(value) &&
		isStudioState(value.next_state) &&
		isRecord(value.envelope) &&
		typeof value.revision === "number" &&
		typeof value.snapshot_hash === "string" &&
		typeof value.label === "string"
	);
}

function isPrepareResult(value: unknown): value is PrepareResult {
	if (!isRecord(value) || typeof value.status !== "string") return false;
	if (value.status === "prepared") return isPreparedCommit(value.commit);
	return (
		value.status === "no_op" &&
		typeof value.reason === "string" &&
		isStudioState(value.state)
	);
}

function parseJson(json: string): unknown {
	return JSON.parse(json);
}

function parseContract<T>({ json, label }: { json: string; label: string }): T {
	const value: unknown = parseJson(json);
	if (!isRecord(value)) throw new Error(`Rust returned an invalid ${label}`);
	// Rust is the source of truth for these generated contracts; every facade
	// performs the structural checks needed before the value reaches UI code.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as T;
}

export function createCampaign(input: CreateCampaignInput): StudioState {
	const value = parseJson(studioCreateCampaign(JSON.stringify(input)));
	if (!isStudioState(value)) {
		throw new Error("Rust returned an invalid StudioState contract");
	}
	return value;
}

export function prepareCommand({
	state,
	envelope,
}: {
	state: StudioState;
	envelope: CommandEnvelope;
}): PrepareResult {
	const value = parseJson(
		studioPrepareCommand(JSON.stringify(state), JSON.stringify(envelope)),
	);
	if (!isPrepareResult(value)) {
		throw new Error("Rust returned an invalid PrepareResult contract");
	}
	return value;
}

export function snapshotHash(state: StudioState): string {
	return studioSnapshotHash(JSON.stringify(state));
}

export function resolveVariant({
	state,
	cellId,
}: {
	state: StudioState;
	cellId: string;
}): ResolvedVariant {
	return parseContract<ResolvedVariant>({
		json: variantResolve(JSON.stringify(state), cellId),
		label: "ResolvedVariant contract",
	});
}

export function queryVariantProjectionPage({
	state,
	page,
	pageSize,
}: {
	state: StudioState;
	page: number;
	pageSize: number;
}): VariantProjectionPage {
	return parseContract<VariantProjectionPage>({
		json: variantProjectionPage(JSON.stringify(state), page, pageSize),
		label: "VariantProjectionPage contract",
	});
}

export function planVariantThumbnails({
	visibleCellIds,
	focusedCellId,
	priorActiveIds,
	maxJobs,
}: {
	visibleCellIds: string[];
	focusedCellId: string | null;
	priorActiveIds: string[];
	maxJobs: number;
}): ThumbnailSchedule {
	return parseContract<ThumbnailSchedule>({
		json: variantThumbnailSchedule(
			JSON.stringify(visibleCellIds),
			focusedCellId ?? "",
			JSON.stringify(priorActiveIds),
			maxJobs,
		),
		label: "ThumbnailSchedule contract",
	});
}
export function buildVariantRenderManifest({
	state,
	cellId,
}: {
	state: StudioState;
	cellId: string;
}): RenderManifest {
	return parseContract<RenderManifest>({
		json: variantBuildRenderManifest(JSON.stringify(state), cellId),
		label: "RenderManifest contract",
	});
}

export function checksumRenderManifest(manifest: RenderManifest): string {
	return renderManifestChecksum(JSON.stringify(manifest));
}

export function createLocalRenderBatch({
	specs,
	succeededKeys,
	now,
}: {
	specs: RenderJobSpec[];
	succeededKeys: string[];
	now: string;
}): LocalRenderBatch {
	return parseContract<LocalRenderBatch>({
		json: renderCreateLocalBatch(
			JSON.stringify(specs),
			JSON.stringify(succeededKeys),
			now,
		),
		label: "LocalRenderBatch contract",
	});
}

export function applyRenderJobEvent({
	job,
	event,
	now,
}: {
	job: PersistedRenderJob;
	event: RenderJobEvent;
	now: string;
}): PersistedRenderJob {
	return parseContract<PersistedRenderJob>({
		json: renderApplyEvent(JSON.stringify(job), JSON.stringify(event), now),
		label: "PersistedRenderJob transition contract",
	});
}

export function preflightLocalRender({
	codec,
	storage,
}: {
	codec: CodecCapability;
	storage: StorageCapability;
}): RenderPreflight {
	return parseContract<RenderPreflight>({
		json: renderCodecPreflight(JSON.stringify(codec), JSON.stringify(storage)),
		label: "RenderPreflight contract",
	});
}

export function previewRenderFilename({
	template,
	context,
}: {
	template: string;
	context: NamingContext;
}): string {
	return renderFilename(template, JSON.stringify(context));
}

export function buildRenderIdempotencyKey({
	manifestSha256,
	optionsJson,
}: {
	manifestSha256: string;
	optionsJson: string;
}): string {
	return jobBuildIdempotencyKey(
		"render",
		manifestSha256,
		optionsJson,
		"variantlab-m7-v1",
	);
}

export function uniqueRenderFilenames(names: string[]): string[] {
	const value: unknown = JSON.parse(
		renderUniqueFilenames(JSON.stringify(names)),
	);
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string")
	) {
		throw new Error("Rust returned invalid collision-resolved filenames");
	}
	return value;
}

export function buildDeliverableArtifact({
	manifest,
	cellId,
	preset,
	filename,
	byteLength,
	sha256,
}: {
	manifest: RenderManifest;
	cellId: string;
	preset: string;
	filename: string;
	byteLength: number;
	sha256: string;
}): DeliverableArtifact {
	return parseContract<DeliverableArtifact>({
		json: renderBuildArtifactReceipt(
			JSON.stringify(manifest),
			cellId,
			preset,
			filename,
			"video/webm",
			String(byteLength),
			sha256,
		),
		label: "DeliverableArtifact contract",
	});
}

export function normalizeDeliverableManifest(input: {
	schema_version: number;
	campaign_id: string;
	campaign_revision: number;
	master_sequence_id: string;
	preset: string;
	destination: DestinationKind;
	artifacts: DeliverableArtifact[];
	provenance: Record<string, string>;
}): DeliverableManifest {
	return parseContract<DeliverableManifest>({
		json: renderNormalizeDeliverableManifest(JSON.stringify(input)),
		label: "DeliverableManifest contract",
	});
}

export function previewCreativeAssignments({
	state,
	assignments,
}: {
	state: StudioState;
	assignments: SlotAssignment[];
}): BulkAssignmentPreview {
	return parseContract<BulkAssignmentPreview>({
		json: creativePreviewAssignments(
			JSON.stringify(state),
			JSON.stringify(assignments),
		),
		label: "BulkAssignmentPreview contract",
	});
}

export function defaultTimeline(): Timeline {
	return parseContract<Timeline>({
		json: timelineDefault(),
		label: "Timeline contract",
	});
}

export function createStressTimeline(input: StressTimelineInput): Timeline {
	return parseContract<Timeline>({
		json: timelineCreateStressFixture(JSON.stringify(input)),
		label: "stress Timeline contract",
	});
}

export function applyTimelineEdit({
	timeline,
	edit,
}: {
	timeline: Timeline;
	edit: TimelineEdit;
}): TimelineEditResult {
	return parseContract<TimelineEditResult>({
		json: timelineApplyEdit(JSON.stringify(timeline), JSON.stringify(edit)),
		label: "TimelineEditResult contract",
	});
}

export function queryVisibleTimeline({
	timeline,
	query,
}: {
	timeline: Timeline;
	query: VisibleTimelineQuery;
}): VisibleTimelineResult {
	return parseContract<VisibleTimelineResult>({
		json: timelineVisibleClips(JSON.stringify(timeline), JSON.stringify(query)),
		label: "VisibleTimelineResult contract",
	});
}

export function setTimelineSessionBase({
	sessionId,
	timeline,
}: {
	sessionId: string;
	timeline: Timeline;
}): void {
	timelineSessionSetBase(sessionId, JSON.stringify(timeline));
}

export function queryTimelineSession({
	sessionId,
	query,
}: {
	sessionId: string;
	query: VisibleTimelineQuery;
}): VisibleTimelineResult {
	return parseContract<VisibleTimelineResult>({
		json: timelineSessionVisibleClips(sessionId, JSON.stringify(query)),
		label: "session VisibleTimelineResult contract",
	});
}

export function previewTimelineSession({
	sessionId,
	edit,
}: {
	sessionId: string;
	edit: TimelineEdit;
}): TimelinePreviewResult {
	return parseContract<TimelinePreviewResult>({
		json: timelineSessionPreviewEdit(sessionId, JSON.stringify(edit)),
		label: "TimelinePreviewResult contract",
	});
}

export function releaseTimelineSession(sessionId: string): void {
	timelineSessionRelease(sessionId);
}

export function planMediaDerivatives(report: ProbeReport): DerivativePlan {
	return parseContract<DerivativePlan>({
		json: mediaPlanDerivatives(JSON.stringify(report)),
		label: "DerivativePlan contract",
	});
}

export function buildJobSpec({
	jobId,
	campaignId,
	assetHash,
	kind,
	normalizedOptionsJson,
	priority,
	engineVersion = "variantlab-m2-v1",
}: {
	jobId: string;
	campaignId: string;
	assetHash: string;
	kind: JobKind;
	normalizedOptionsJson: string;
	priority: number;
	engineVersion?: string;
}): JobSpec {
	return {
		schema_version: 1,
		job_id: jobId,
		campaign_id: campaignId,
		asset_hash: assetHash,
		kind,
		idempotency_key: jobBuildIdempotencyKey(
			kind,
			assetHash,
			normalizedOptionsJson,
			engineVersion,
		),
		engine_version: engineVersion,
		normalized_options_json: normalizedOptionsJson,
		priority,
	};
}

export function createPersistedJob({
	spec,
	now,
}: {
	spec: JobSpec;
	now: string;
}): PersistedJob {
	return parseContract<PersistedJob>({
		json: jobCreate(JSON.stringify(spec), now),
		label: "PersistedJob contract",
	});
}

export function applyJobEvent({
	job,
	event,
	now,
}: {
	job: PersistedJob;
	event: JobEvent;
	now: string;
}): PersistedJob {
	return parseContract<PersistedJob>({
		json: jobApplyEvent(JSON.stringify(job), JSON.stringify(event), now),
		label: "PersistedJob transition contract",
	});
}

export function buildCommandEnvelope({
	state,
	sceneScope,
	variantScope,
	payload,
	now,
	commandId,
	transactionId,
	deviceId,
}: {
	state: StudioState;
	sceneScope: SceneScope;
	variantScope: VariantScope;
	payload: CommandPayload;
	now: string;
	commandId: string;
	transactionId: string;
	deviceId: string;
}): CommandEnvelope {
	return {
		schema_version: SCHEMA_VERSION,
		command_id: commandId,
		transaction_id: transactionId,
		campaign_id: state.campaign.id,
		master_sequence_id: state.campaign.master_sequence.id,
		scene_scope: sceneScope,
		variant_scope: variantScope,
		history_scope: {
			campaign_id: state.campaign.id,
			master_sequence_id: state.campaign.master_sequence.id,
			scene_scope: sceneScope,
			variant_scope: variantScope,
		},
		base_revision: state.campaign.revision,
		actor_id: "local-user",
		device_id: deviceId,
		issued_at: now,
		payload,
	};
}

export function buildSceneCommandEnvelope({
	state,
	sceneId,
	payload,
	now,
	commandId,
	transactionId,
	deviceId,
}: {
	state: StudioState;
	sceneId: string;
	payload: CommandPayload;
	now: string;
	commandId: string;
	transactionId: string;
	deviceId: string;
}): CommandEnvelope {
	return buildCommandEnvelope({
		state,
		sceneScope: { kind: "scene", scene_id: sceneId },
		variantScope: { kind: "master" },
		payload,
		now,
		commandId,
		transactionId,
		deviceId,
	});
}
