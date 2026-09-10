/// <reference lib="webworker" />

import type {
	PersistedRenderJob,
	RenderManifest,
	RenderTiming,
} from "@variantlab/studio-contract";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BlobSource,
	CanvasSource,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
	Input,
	Output,
	StreamTarget,
	type StreamTargetChunk,
	VideoSampleSink,
	WebMOutputFormat,
} from "mediabunny";
import * as workerWasm from "../../../../rust/wasm/pkg/opencut_wasm_bg.js";
import { FrozenFrameRenderer } from "./frozen-frame";

import {
	fileForPath,
	fileHandleForPath,
	listMediaAssets,
	removeArtifact,
} from "./media-store";

type FailurePhase =
	| "preparing"
	| "rendering"
	| "muxing"
	| "corrupt_source"
	| "out_of_space";

type RunRequest = {
	type: "run";
	job: PersistedRenderJob;
	manifest: RenderManifest;
	artifactPath: string;
	failAt?: FailurePhase;
};

type CancelRequest = { type: "cancel"; jobId: string };
type WorkerRequest = RunRequest | CancelRequest;

export type ExportWorkerResponse =
	| {
			type: "progress";
			jobId: string;
			phase: "preparing" | "rendering" | "muxing" | "verifying" | "persisting";
			progressMilli: number;
			emittedAtMs?: number;
	  }
	| { type: "cancelled"; jobId: string }
	| {
			type: "failed";
			jobId: string;
			code: string;
			message: string;
			retryable: boolean;
	  }
	| {
			type: "succeeded";
			jobId: string;
			artifactPath: string;
			byteLength: number;
			sha256: string;
			manifestSha256: string;
			timing: RenderTiming;
	  };

// The module is instantiated exclusively as a dedicated Worker.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const scope = self as DedicatedWorkerGlobalScope;

const workerWasmUrl = new URL(
	"../../../../rust/wasm/pkg/opencut_wasm_bg.wasm",
	import.meta.url,
);
const workerWasmReady = WebAssembly.instantiateStreaming(
	fetch(new URL(workerWasmUrl, scope.location.origin)),
	{ "./opencut_wasm_bg.js": workerWasm },
).then(({ instance }) => {
	workerWasm.__wbg_set_wasm(instance.exports);
	const start = instance.exports.__wbindgen_start;
	if (typeof start === "function") Reflect.apply(start, null, []);
	return workerWasm;
});
const cancelled = new Set<string>();

function post(response: ExportWorkerResponse): void {
	scope.postMessage(
		response.type === "progress"
			? {
					...response,
					emittedAtMs: performance.timeOrigin + performance.now(),
				}
			: response,
	);
}

async function withProgressHeartbeat<T>({
	jobId,
	phase,
	startProgressMilli,
	maxProgressMilli,
	operation,
}: {
	jobId: string;
	phase: Extract<ExportWorkerResponse, { type: "progress" }>["phase"];
	startProgressMilli: number;
	maxProgressMilli: number;
	operation: Promise<T>;
}): Promise<T> {
	let progressMilli = startProgressMilli;
	const timer = setInterval(() => {
		progressMilli = Math.min(maxProgressMilli, progressMilli + 1);
		post({ type: "progress", jobId, phase, progressMilli });
	}, 500);
	try {
		return await operation;
	} finally {
		clearInterval(timer);
	}
}

function ensureActive({ jobId }: { jobId: string }): void {
	if (cancelled.has(jobId))
		throw new DOMException("Render cancelled", "AbortError");
}

function injectedFailure({
	failAt,
	phase,
}: {
	failAt: FailurePhase | undefined;
	phase: FailurePhase;
}): void {
	if (failAt !== phase) return;
	if (phase === "out_of_space") {
		throw new DOMException(
			"Injected OPFS quota exhaustion",
			"QuotaExceededError",
		);
	}
	throw new Error(
		phase === "corrupt_source"
			? "Injected corrupt immutable source"
			: `Injected ${phase} worker failure`,
	);
}

async function streamTarget(
	path: string,
): Promise<WritableStream<StreamTargetChunk>> {
	const handle = await fileHandleForPath({ path, create: true });
	const writable = await handle.createWritable({ keepExistingData: false });
	return new WritableStream<StreamTargetChunk>({
		async write(chunk) {
			await writable.seek(chunk.position);
			await writable.write(chunk.data);
		},
		async close() {
			await writable.close();
		},
		async abort(reason) {
			await writable.abort(reason);
		},
	});
}

type DecodedMedia = {
	input: Input;
	video?: VideoSampleSink;
	videoStart: number;
	audio?: AudioSampleSink;
	audioStart: number;
};

async function parseRenderTiming(json: string): Promise<RenderTiming> {
	const wasm = await workerWasmReady;
	const value: unknown = JSON.parse(wasm.renderTiming(json));
	if (
		typeof value !== "object" ||
		value === null ||
		!("duration_ticks" in value) ||
		!("frame_count" in value) ||
		!("audio_sample_count" in value) ||
		!("trailing_frame_duration_ticks" in value) ||
		typeof value.duration_ticks !== "number" ||
		typeof value.frame_count !== "number" ||
		typeof value.audio_sample_count !== "number" ||
		typeof value.trailing_frame_duration_ticks !== "number"
	) {
		throw new Error("Rust returned an invalid RenderTiming contract");
	}
	return {
		duration_ticks: value.duration_ticks,
		frame_count: value.frame_count,
		audio_sample_count: value.audio_sample_count,
		trailing_frame_duration_ticks: value.trailing_frame_duration_ticks,
	};
}

async function loadImmutableMedia({
	job,
	manifest,
}: {
	job: PersistedRenderJob;
	manifest: RenderManifest;
}): Promise<Map<string, DecodedMedia>> {
	const records = await listMediaAssets(job.spec.campaign_id);
	const byHash = new Map(records.map((record) => [record.asset_hash, record]));
	const required = new Set(manifest.clips.map((clip) => clip.asset_hash));
	const decoded = new Map<string, DecodedMedia>();
	for (const assetHash of required) {
		const record = byHash.get(assetHash);
		if (!record) throw new Error(`Immutable source ${assetHash} is missing`);
		const input = new Input({
			formats: ALL_FORMATS,
			source: new BlobSource(await fileForPath(record.original_path), {
				maxCacheSize: 8 * 1024 * 1024,
			}),
		});
		// Mediabunny initializes one Input demuxer lazily. Serialize primary-track
		// discovery so two concurrent reads cannot contend for that initialization.
		const videoTrack = await input.getPrimaryVideoTrack();
		const audioTrack = await input.getPrimaryAudioTrack();
		if (videoTrack && !(await videoTrack.canDecode()))
			throw new Error(`Video source ${assetHash} cannot be decoded`);
		if (audioTrack && !(await audioTrack.canDecode()))
			throw new Error(`Audio source ${assetHash} cannot be decoded`);
		decoded.set(assetHash, {
			input,
			video: videoTrack ? new VideoSampleSink(videoTrack) : undefined,
			videoStart: videoTrack ? await videoTrack.getFirstTimestamp() : 0,
			audio: audioTrack ? new AudioSampleSink(audioTrack) : undefined,
			audioStart: audioTrack ? await audioTrack.getFirstTimestamp() : 0,
		});
	}
	return decoded;
}

async function hashFile(
	path: string,
): Promise<{ byteLength: number; sha256: string }> {
	const file = await fileForPath(path);
	const hasher = sha256.create();
	const reader = file.stream().getReader();
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			hasher.update(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	return { byteLength: file.size, sha256: bytesToHex(hasher.digest()) };
}

async function run(request: RunRequest): Promise<ExportWorkerResponse> {
	const { job, manifest, artifactPath } = request;
	if (manifest.blockers?.length) throw new Error(manifest.blockers.join(", "));
	const jobId = job.spec.job_id;
	post({ type: "progress", jobId, phase: "preparing", progressMilli: 20 });
	ensureActive({ jobId });
	injectedFailure({ failAt: request.failAt, phase: "preparing" });
	injectedFailure({ failAt: request.failAt, phase: "corrupt_source" });
	if (manifest.clips.length === 0)
		throw new Error("Render manifest has no immutable media clips");
	const decodedMedia = await withProgressHeartbeat({
		jobId,
		phase: "preparing",
		startProgressMilli: 25,
		maxProgressMilli: 44,
		operation: loadImmutableMedia({ job, manifest }),
	});
	post({ type: "progress", jobId, phase: "preparing", progressMilli: 45 });

	const width = manifest.canvas.width;
	const height = manifest.canvas.height;
	const [videoCodec, audioCodec] = await withProgressHeartbeat({
		jobId,
		phase: "preparing",
		startProgressMilli: 50,
		maxProgressMilli: 64,
		operation: Promise.all([
			getFirstEncodableVideoCodec(["vp9", "vp8"], {
				width,
				height,
				bitrate: 2_000_000,
			}),
			getFirstEncodableAudioCodec(["opus"], {
				numberOfChannels: 1,
				sampleRate: 48_000,
				bitrate: 96_000,
			}),
		]),
	});
	post({ type: "progress", jobId, phase: "preparing", progressMilli: 65 });
	if (!videoCodec || !audioCodec) {
		return {
			type: "failed",
			jobId,
			code: "unsupported_codec",
			message:
				"VP9/VP8 video and Opus audio encoders are required by this preset.",
			retryable: false,
		};
	}

	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Offscreen export surface is unavailable");
	await removeArtifact(artifactPath).catch(() => undefined);
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new StreamTarget(await streamTarget(artifactPath), {
			chunked: true,
			chunkSize: 4 * 1024 * 1024,
		}),
	});
	const video = new CanvasSource(canvas, {
		codec: videoCodec,
		bitrate: 2_000_000,
	});
	const audio = new AudioSampleSource({ codec: audioCodec, bitrate: 96_000 });
	const fps = manifest.fps_num / manifest.fps_den;
	output.addVideoTrack(video, { frameRate: fps });
	output.addAudioTrack(audio);
	await withProgressHeartbeat({
		jobId,
		phase: "preparing",
		startProgressMilli: 70,
		maxProgressMilli: 74,
		operation: output.start(),
	});
	post({ type: "progress", jobId, phase: "preparing", progressMilli: 75 });

	const timing = await parseRenderTiming(JSON.stringify(manifest));
	const frameTicks = (48_000 * manifest.fps_den) / manifest.fps_num;
	let lastProgressAt = 0;
	const cropWasm = await workerWasmReady;
	const visual = new FrozenFrameRenderer({ manifest, wasm: cropWasm });
	await visual.prepare(job.spec.campaign_id);
	try {
		for (let frame = 0; frame < timing.frame_count; frame += 1) {
			ensureActive({ jobId });
			if (frame === 1)
				injectedFailure({ failAt: request.failAt, phase: "rendering" });
			const tick = Math.floor(frame * frameTicks);
			const framePlan = await visual.draw({ canvas, tick });
			const timestamp = tick / 48_000;
			const duration =
				frame === timing.frame_count - 1
					? Math.max(1 / fps / 100, timing.duration_ticks / 48_000 - timestamp)
					: 1 / fps;
			await video.add(timestamp, duration, {
				keyFrame: frame === 0 || framePlan.scene_boundary,
			});
			const now = performance.now();
			if (now - lastProgressAt >= 200 || frame + 1 === timing.frame_count) {
				post({
					type: "progress",
					jobId,
					phase: "rendering",
					progressMilli:
						80 +
						Math.round(((frame + 1) / Math.max(1, timing.frame_count)) * 700),
				});
				lastProgressAt = now;
			}
		}
		video.close();

		const audioChunkFrames = 960;
		let lastAudioProgressAt = performance.now();
		for (
			let offset = 0;
			offset < timing.audio_sample_count;
			offset += audioChunkFrames
		) {
			ensureActive({ jobId });
			const count = Math.min(
				audioChunkFrames,
				timing.audio_sample_count - offset,
			);
			const values = new Float32Array(count);
			const tick = offset;
			const clip = visual.frame(tick).audio;
			if (clip) {
				const sink = decodedMedia.get(clip.asset_hash)?.audio;
				if (!sink)
					throw new Error(
						`Immutable audio ${clip.asset_hash} has no decodable audio track`,
					);
				const media = decodedMedia.get(clip.asset_hash)!;
				const sourceTimestamp = media.audioStart + clip.source_tick / 48_000;
				const sample = await sink.getSample(sourceTimestamp);
				if (sample) {
					try {
						const frameOffset = Math.max(
							0,
							Math.round(
								(sourceTimestamp - sample.timestamp) * sample.sampleRate,
							),
						);
						const available = Math.min(
							count,
							sample.numberOfFrames - frameOffset,
						);
						if (available > 0) {
							for (
								let channelIndex = 0;
								channelIndex < sample.numberOfChannels;
								channelIndex += 1
							) {
								const channel = new Float32Array(available);
								sample.copyTo(channel, {
									planeIndex: channelIndex,
									format: "f32-planar",
									frameOffset,
									frameCount: available,
								});
								for (let index = 0; index < available; index += 1) {
									values[index] += channel[index]! / sample.numberOfChannels;
								}
							}
						}
					} finally {
						sample.close();
					}
				}
			}
			await audio.add(
				new AudioSample({
					data: values,
					format: "f32-planar",
					numberOfChannels: 1,
					sampleRate: 48_000,
					timestamp: offset / 48_000,
				}),
			);
			const now = performance.now();
			if (
				now - lastAudioProgressAt >= 200 ||
				offset + count === timing.audio_sample_count
			) {
				post({
					type: "progress",
					jobId,
					phase: "rendering",
					progressMilli:
						780 +
						Math.round(
							((offset + count) / Math.max(1, timing.audio_sample_count)) * 60,
						),
				});
				lastAudioProgressAt = now;
			}
		}
		audio.close();
		post({ type: "progress", jobId, phase: "muxing", progressMilli: 850 });
		injectedFailure({ failAt: request.failAt, phase: "muxing" });
		await withProgressHeartbeat({
			jobId,
			phase: "muxing",
			startProgressMilli: 860,
			maxProgressMilli: 920,
			operation: output.finalize(),
		});
		injectedFailure({ failAt: request.failAt, phase: "out_of_space" });
		post({ type: "progress", jobId, phase: "verifying", progressMilli: 930 });
		const artifact = await withProgressHeartbeat({
			jobId,
			phase: "verifying",
			startProgressMilli: 940,
			maxProgressMilli: 970,
			operation: hashFile(artifactPath),
		});
		for (const media of decodedMedia.values()) media.input.dispose();
		post({ type: "progress", jobId, phase: "persisting", progressMilli: 980 });
		return {
			type: "succeeded",
			jobId,
			artifactPath,
			byteLength: artifact.byteLength,
			sha256: artifact.sha256,
			manifestSha256: (await workerWasmReady).renderManifestChecksum(
				JSON.stringify(manifest),
			),
			timing,
		};
	} finally {
		visual.dispose();
		for (const media of decodedMedia.values()) media.input.dispose();
	}
}

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
	const request = event.data;
	if (request.type === "cancel") {
		cancelled.add(request.jobId);
		return;
	}
	void run(request)
		.then(post)
		.catch(async (error: unknown) => {
			await removeArtifact(request.artifactPath).catch(() => undefined);
			if (error instanceof DOMException && error.name === "AbortError") {
				post({ type: "cancelled", jobId: request.job.spec.job_id });
				return;
			}
			const outOfSpace =
				error instanceof DOMException && error.name === "QuotaExceededError";
			const corruptSource =
				error instanceof Error &&
				error.message === "Injected corrupt immutable source";
			post({
				type: "failed",
				jobId: request.job.spec.job_id,
				code: outOfSpace
					? "out_of_space"
					: corruptSource
						? "corrupt_source"
						: "worker_terminated",
				message:
					error instanceof Error ? error.message : "Export worker failed",
				retryable: !(outOfSpace || corruptSource),
			});
		})
		.finally(() => cancelled.delete(request.job.spec.job_id));
});

export {};
