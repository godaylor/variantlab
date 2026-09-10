import type {
	DerivativePlan,
	JobEvent,
	JobFailure,
	JobKind,
	PersistedJob,
} from "@variantlab/studio-contract";
import {
	applyJobEvent,
	buildJobSpec,
	createPersistedJob,
	planMediaDerivatives,
} from "./domain";
import {
	commitStagedOriginal,
	derivativeByKey,
	jobByIdempotencyKey,
	listJobs,
	listMediaAssets,
	saveDerivative,
	saveJob,
	saveMediaAsset,
	stageOriginal,
	type StoredMediaAsset,
} from "./media-store";

type PipelineSnapshot = {
	jobs: PersistedJob[];
	assets: StoredMediaAsset[];
	importProgress: number | null;
	notice: string;
};

type PipelineListener = (snapshot: PipelineSnapshot) => void;

type ProbeOptions = {
	byteLength: number;
	declaredMime: string;
	detectedMime: string;
	name: string;
	originalPath: string;
	sceneId: string;
};

type WorkerMessage =
	| { type: "progress"; jobId: string; phase: string; completed: number; total: number }
	| { type: "succeeded"; jobId: string; artifactPath: string; byteLength: number; metadataJson: string }
	| { type: "cancelled"; jobId: string }
	| { type: "failed"; jobId: string; code: string; message: string; retryable: boolean };

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

function typedFailure({
	code,
	message,
	retryable,
}: {
	code: string;
	message: string;
	retryable: boolean;
}): JobFailure {
	const action =
		code === "proxy_encoder_unavailable"
			? "Open in a browser with VP9/VP8 WebCodecs support or use a connected proxy provider"
			: code === "mime_mismatch"
				? "Choose the original unmodified media file"
				: "Retry this job";
	return { code, message, retryable, action };
}

function stableOptions(value: Record<string, unknown>): string {
	return JSON.stringify(
		Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))),
	);
}

function parsePersistedJson<T>({ json, label }: { json: string; label: string }): T {
	const value: unknown = JSON.parse(json);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Persisted ${label} is invalid`);
	}
	// The payload was produced from a generated Rust contract before persistence.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as T;
}

export class MediaJobPipeline {
	private campaignId = "";
	private jobs = new Map<string, PersistedJob>();
	private assets: StoredMediaAsset[] = [];
	private listeners = new Set<PipelineListener>();
	private worker: Worker | null = null;
	private activeJobId: string | null = null;
	private playbackActive = false;
	private pauseIntent = new Set<string>();
	private cancelIntent = new Set<string>();
	private lastProgressAt = new Map<string, number>();
	private workerMessageChain: Promise<void> = Promise.resolve();
	private importProgress: number | null = null;
	private notice = "Media jobs are idle.";
	private readonly workerStartDelayMs =
		typeof window !== "undefined" && process.env.NODE_ENV !== "production"
			? Math.min(10_000, Math.max(0, Number(new URLSearchParams(window.location.search).get("m2WorkerDelayMs") ?? 0) || 0))
			: 0;

	constructor() {
		if (typeof window !== "undefined") this.createWorker();
	}

	subscribe(listener: PipelineListener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => this.listeners.delete(listener);
	}

	async initialize(campaignId: string): Promise<void> {
		if (!this.worker && typeof window !== "undefined") this.createWorker();
		this.campaignId = campaignId;
		const [storedJobs, assets] = await Promise.all([
			listJobs(campaignId),
			listMediaAssets(campaignId),
		]);
		this.assets = assets;
		this.jobs.clear();
		for (const stored of storedJobs) {
			let job = stored;
			if (["preparing", "running", "pausing", "cancelling"].includes(job.state)) {
				job = applyJobEvent({
					job,
					event: { event: "recover_after_reload" },
					now: new Date().toISOString(),
				});
				await saveJob(job);
			}
			this.jobs.set(job.spec.job_id, job);
		}
		this.notice = storedJobs.some((job) => !TERMINAL_STATES.has(job.state))
			? "Recovered local jobs. They were paused while the tab was closed."
			: "Media jobs are ready.";
		this.emit();
		void this.startNext();
	}

	async importFile({ file, sceneId }: { file: File; sceneId: string }): Promise<void> {
		if (!this.campaignId) throw new Error("Open a campaign before importing media");
		this.importProgress = 0;
		this.notice = "Copying the original to protected staging storage.";
		this.emit();
		const stagingId = crypto.randomUUID();
		let staged;
		let originalPath: string;
		try {
			staged = await stageOriginal({
				file,
				stagingId,
				onProgress: (completed, total) => {
					this.importProgress = Math.round((completed / Math.max(1, total)) * 100);
					this.emit();
				},
			});
			originalPath = await commitStagedOriginal(staged);
		} catch (error) {
			this.importProgress = null;
			this.notice = "Import stopped before the asset manifest was committed.";
			this.emit();
			throw error;
		}
		const normalizedOptionsJson = stableOptions({
			byteLength: staged.byteLength,
			declaredMime: file.type || "application/octet-stream",
			detectedMime: staged.detectedMime,
			name: file.name,
			originalPath,
			sceneId,
		});
		const spec = buildJobSpec({
			jobId: crypto.randomUUID(),
			campaignId: this.campaignId,
			assetHash: staged.assetHash,
			kind: "probe",
			normalizedOptionsJson,
			priority: 0,
		});
		const existing = await jobByIdempotencyKey(spec.idempotency_key);
		if (existing) {
			this.jobs.set(existing.spec.job_id, existing);
			this.importProgress = null;
			this.notice =
				existing.state === "succeeded"
					? "This original is already verified; no duplicate asset or derivative was created."
					: "The existing import job was restored instead of creating a duplicate.";
			this.emit();
			if (existing.state === "queued") void this.startNext();
			return;
		}
		const job = createPersistedJob({ spec, now: new Date().toISOString() });
		await saveJob(job);
		this.jobs.set(job.spec.job_id, job);
		this.importProgress = null;
		this.notice = "Original copied. Content probe is queued before the asset becomes visible.";
		this.emit();
		void this.startNext();
	}

	private async runProbe(job: PersistedJob): Promise<void> {
		try {
			let current = await this.transition({ job, event: { event: "start_preparing" } });
			current = await this.transition({ job: current, event: { event: "start_running" } });
			const options = parsePersistedJson<ProbeOptions>({ json: current.spec.normalized_options_json, label: "probe options" });
			this.worker?.postMessage({
				type: "probe",
				job: current,
				originalPath: options.originalPath,
				assetHash: current.spec.asset_hash,
				declaredMime: options.declaredMime,
				detectedMime: options.detectedMime,
			});
		} catch (error) {
			const current = this.jobs.get(job.spec.job_id);
			if (current && ["preparing", "running"].includes(current.state)) {
				const message = error instanceof Error ? error.message : "Content probe failed";
				await this.transition({ job: current, event: {
					event: "fail",
					failure: typedFailure({
						code: message.includes("does not match detected content") ? "mime_mismatch" : "probe_failed",
						message,
						retryable: !message.includes("does not match detected content"),
					}),
				} });
			}
			this.notice = "Import failed before the asset manifest was committed.";
			this.activeJobId = null;
			this.emit();
			void this.startNext();
		}
	}

	private async completeProbe({
		job,
		message,
	}: {
		job: PersistedJob;
		message: Extract<WorkerMessage, { type: "succeeded" }>;
	}): Promise<void> {
		const options = parsePersistedJson<ProbeOptions>({ json: job.spec.normalized_options_json, label: "probe options" });
		const report = parsePersistedJson<StoredMediaAsset["probe"]>({ json: message.metadataJson, label: "probe report" });
		const plan = planMediaDerivatives(report);
		const asset: StoredMediaAsset = {
			asset_id: `${job.spec.campaign_id}:${job.spec.asset_hash}`,
			campaign_id: job.spec.campaign_id,
			scene_id: options.sceneId,
			asset_hash: job.spec.asset_hash,
			name: options.name,
			declared_mime: options.declaredMime,
			detected_mime: options.detectedMime,
			byte_length: options.byteLength,
			original_path: options.originalPath,
			probe: report,
			plan,
			created_at: new Date().toISOString(),
		};
		await saveMediaAsset(asset);
		this.assets = await listMediaAssets(this.campaignId);
		await this.transition({ job, event: {
			event: "succeed",
			artifact_path: options.originalPath,
		} });
		this.notice = "Probe passed. Playback can use the original while proxy and waveform continue.";
		await this.enqueueDerivatives({ asset, plan });
		this.activeJobId = null;
		this.emit();
		void this.startNext();
	}

	private async enqueueDerivatives({
		asset,
		plan,
	}: {
		asset: StoredMediaAsset;
		plan: DerivativePlan;
	}): Promise<void> {
		const specifications: Array<{
			kind: Exclude<JobKind, "probe">;
			options: Record<string, unknown>;
			priority: number;
		}> = [];
		if (plan.proxy) {
			specifications.push({ kind: "proxy", options: plan.proxy, priority: 20 });
		}
		if (plan.waveform) {
			specifications.push({
				kind: "waveform",
				options: plan.waveform,
				priority: 30,
			});
		}
		for (const item of specifications) {
			const normalizedOptionsJson = stableOptions(item.options);
			const spec = buildJobSpec({
				jobId: crypto.randomUUID(),
				campaignId: asset.campaign_id,
				assetHash: asset.asset_hash,
				kind: item.kind,
				normalizedOptionsJson,
				priority: item.priority,
			});
			if (await derivativeByKey(spec.idempotency_key)) continue;
			const existing = await jobByIdempotencyKey(spec.idempotency_key);
			if (existing) {
				this.jobs.set(existing.spec.job_id, existing);
				continue;
			}
			const job = createPersistedJob({ spec, now: new Date().toISOString() });
			await saveJob(job);
			this.jobs.set(job.spec.job_id, job);
		}
		this.emit();
	}

	private async startNext(): Promise<void> {
		if (this.activeJobId || !this.campaignId) return;
		const next = [...this.jobs.values()]
			.filter((job) => job.state === "queued")
			.toSorted(
				(left, right) =>
					left.spec.priority - right.spec.priority ||
					left.created_at.localeCompare(right.created_at),
			)[0];
		if (!next) return;
		if (this.playbackActive && next.spec.kind !== "probe") {
			this.notice = "Proxy and waveform are yielding to active playback.";
			this.emit();
			return;
		}
		this.activeJobId = next.spec.job_id;
		if (next.spec.kind === "probe") {
			void this.runProbe(next);
			return;
		}
		const asset = this.assets.find(
			(candidate) => candidate.asset_hash === next.spec.asset_hash,
		);
		if (!asset) {
			const preparing = await this.transition({ job: next, event: { event: "start_preparing" } });
			await this.transition({ job: preparing, event: {
				event: "fail",
				failure: typedFailure({
					code: "missing_asset",
					message: "The immutable source manifest is missing.",
					retryable: false,
				}),
			} });
			this.activeJobId = null;
			void this.startNext();
			return;
		}
		let current = await this.transition({ job: next, event: { event: "start_preparing" } });
		current = await this.transition({ job: current, event: { event: "start_running" } });
		if (this.workerStartDelayMs > 0) {
			await new Promise((resolve) => window.setTimeout(resolve, this.workerStartDelayMs));
			const latest = this.jobs.get(current.spec.job_id);
			if (!latest || latest.state !== "running" || this.activeJobId !== latest.spec.job_id) return;
			current = latest;
		}
		this.worker?.postMessage({
			type: "run",
			job: current,
			originalPath: asset.original_path,
			probe: asset.probe,
			plan: asset.plan,
		});
	}

	async cancel(jobId: string): Promise<void> {
		const job = this.jobs.get(jobId);
		if (!job || TERMINAL_STATES.has(job.state)) return;
		const current = await this.transition({ job, event: { event: "request_cancel" } });
		this.cancelIntent.add(jobId);
		if (this.activeJobId === jobId) {
			this.worker?.postMessage({ type: "cancel", jobId });
		} else {
			await this.transition({ job: current, event: { event: "confirm_cancelled" } });
			this.cancelIntent.delete(jobId);
			if (this.activeJobId === jobId) this.activeJobId = null;
			void this.startNext();
		}
	}

	async pause(jobId: string): Promise<void> {
		const job = this.jobs.get(jobId);
		if (!job || job.state !== "running" || job.spec.kind === "probe") return;
		await this.transition({ job, event: { event: "request_pause" } });
		this.pauseIntent.add(jobId);
		this.worker?.postMessage({ type: "cancel", jobId });
	}

	async resume(jobId: string): Promise<void> {
		const job = this.jobs.get(jobId);
		if (!job || job.state !== "paused") return;
		await this.transition({ job, event: { event: "resume" } });
		void this.startNext();
	}

	async retry(jobId: string): Promise<void> {
		const job = this.jobs.get(jobId);
		if (!job || job.state !== "failed") return;
		await this.transition({ job, event: { event: "retry" } });
		void this.startNext();
	}

	setPlaybackActive(active: boolean): void {
		this.playbackActive = active;
		if (active && this.activeJobId) {
			const job = this.jobs.get(this.activeJobId);
			if (job?.state === "running" && job.spec.kind !== "probe") {
				void this.pause(job.spec.job_id);
			}
		} else if (!active) {
			const paused = [...this.jobs.values()].filter(
				(job) => job.state === "paused" && this.pauseIntent.has(job.spec.job_id),
			);
			for (const job of paused) {
				this.pauseIntent.delete(job.spec.job_id);
				void this.resume(job.spec.job_id);
			}
			void this.startNext();
		}
	}

	dispose(): void {
		this.worker?.terminate();
		this.worker = null;
		this.listeners.clear();
	}

	crashActiveWorkerForTest(): void {
		if (process.env.NODE_ENV === "production") throw new Error("Worker crash injection is disabled in production");
		this.worker?.terminate();
		void this.handleWorkerCrash();
	}

	private async transition({
		job,
		event,
	}: {
		job: PersistedJob;
		event: JobEvent;
	}): Promise<PersistedJob> {
		const next = applyJobEvent({ job, event, now: new Date().toISOString() });
		this.jobs.set(next.spec.job_id, next);
		await saveJob(next);
		this.emit();
		return next;
	}

	private createWorker(): void {
		this.worker?.terminate();
		this.worker = new Worker(new URL("./media-worker.ts", import.meta.url), {
			type: "module",
			name: "variantlab-media-worker",
		});
		this.worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
			this.workerMessageChain = this.workerMessageChain
				.then(() => this.handleWorkerMessage(event.data))
				.catch((error: unknown) => {
					console.error("[variantlab] media worker message failed", error);
				});
		});
		this.worker.addEventListener("error", () => {
			void this.handleWorkerCrash();
		});
	}

	private async handleWorkerMessage(message: WorkerMessage): Promise<void> {
		const job = this.jobs.get(message.jobId);
		if (!job) return;
		if (message.type === "progress") {
			const now = performance.now();
			if (now - (this.lastProgressAt.get(message.jobId) ?? 0) < 150) return;
			this.lastProgressAt.set(message.jobId, now);
			await this.transition({ job, event: {
				event: "progress",
				phase: message.phase,
				completed_units: Math.max(0, message.completed),
				total_units: Math.max(1, message.total),
			} });
			return;
		}
		if (message.type === "cancelled") {
			if (this.pauseIntent.has(message.jobId)) {
				await this.transition({ job, event: { event: "confirm_paused" } });
			} else {
				await this.transition({ job, event: { event: "confirm_cancelled" } });
				this.cancelIntent.delete(message.jobId);
			}
			this.activeJobId = null;
			void this.startNext();
			return;
		}
		if (message.type === "failed") {
			await this.transition({ job, event: {
				event: "fail",
				failure: typedFailure(message),
			} });
			this.notice = job.spec.kind === "probe"
				? `Import failed before the asset manifest was committed: ${message.message}`
				: message.message;
			this.activeJobId = null;
			this.emit();
			void this.startNext();
			return;
		}
		if (job.spec.kind === "probe") {
			try {
				await this.completeProbe({ job, message });
			} catch (error) {
				const detail = error instanceof Error ? error.message : "Content probe validation failed";
				await this.transition({ job, event: {
					event: "fail",
					failure: typedFailure({
						code: detail.includes("does not match detected content") ? "mime_mismatch" : "probe_failed",
						message: detail,
						retryable: !detail.includes("does not match detected content"),
					}),
				} });
				this.notice = "Import failed before the asset manifest was committed.";
				this.activeJobId = null;
				this.emit();
				void this.startNext();
			}
			return;
		}
		if (job.spec.kind !== "proxy" && job.spec.kind !== "waveform") {
			throw new Error("Only proxy or waveform jobs may persist media derivatives");
		}
		await saveDerivative({
			idempotency_key: job.spec.idempotency_key,
			job_id: job.spec.job_id,
			campaign_id: job.spec.campaign_id,
			asset_hash: job.spec.asset_hash,
			kind: job.spec.kind,
			artifact_path: message.artifactPath,
			byte_length: message.byteLength,
			metadata_json: message.metadataJson,
			created_at: new Date().toISOString(),
		});
		await this.transition({ job, event: {
			event: "succeed",
			artifact_path: message.artifactPath,
		} });
		this.notice = `${job.spec.kind === "proxy" ? "Proxy" : "Waveform"} derivative is ready.`;
		this.activeJobId = null;
		void this.startNext();
	}

	private async handleWorkerCrash(): Promise<void> {
		const job = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
		if (job && ["preparing", "running", "pausing", "cancelling"].includes(job.state)) {
			await this.transition({ job, event: {
				event: "fail",
				failure: typedFailure({
					code: "worker_crash",
					message: "The browser media worker stopped unexpectedly.",
					retryable: true,
				}),
			} });
		}
		this.activeJobId = null;
		this.createWorker();
		void this.startNext();
	}

	private snapshot(): PipelineSnapshot {
		return {
			jobs: [...this.jobs.values()].toSorted((left, right) =>
				left.created_at.localeCompare(right.created_at),
			),
			assets: [...this.assets],
			importProgress: this.importProgress,
			notice: this.notice,
		};
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

export type { PipelineSnapshot };
