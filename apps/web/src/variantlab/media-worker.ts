/// <reference lib="webworker" />

import type {
	DerivativePlan,
	PersistedJob,
	ProbeReport,
} from "@variantlab/studio-contract";
import {
	ALL_FORMATS,
	AudioSampleSink,
	BlobSource,
	Conversion,
	ConversionCanceledError,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
	Input,
	Output,
	StreamTarget,
	type StreamTargetChunk,
	WebMOutputFormat,
} from "mediabunny";
import {
	fileForPath,
	fileHandleForPath,
	removeArtifact,
} from "./media-store";
import { probeMediaFile } from "./media-probe";

type DerivativeRequest = {
	type: "run";
	job: PersistedJob;
	originalPath: string;
	probe: ProbeReport;
	plan: DerivativePlan;
};

type ProbeRequest = {
	type: "probe";
	job: PersistedJob;
	originalPath: string;
	assetHash: string;
	declaredMime: string;
	detectedMime: string;
};

type CancelRequest = { type: "cancel"; jobId: string };
type WorkerRequest = DerivativeRequest | ProbeRequest | CancelRequest;

type WorkerResponse =
	| { type: "progress"; jobId: string; phase: string; completed: number; total: number }
	| { type: "succeeded"; jobId: string; artifactPath: string; byteLength: number; metadataJson: string }
	| { type: "cancelled"; jobId: string }
	| { type: "failed"; jobId: string; code: string; message: string; retryable: boolean };

// The module is instantiated exclusively as a dedicated Worker.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const workerScope = self as DedicatedWorkerGlobalScope;
const conversions = new Map<string, Conversion>();
const cancellation = new Set<string>();

function post(response: WorkerResponse): void {
	workerScope.postMessage(response);
}

async function writableStreamForPath(
	path: string,
): Promise<WritableStream<StreamTargetChunk>> {
	const handle = await fileHandleForPath({ path, create: true });
	const file = await handle.createWritable({ keepExistingData: false });
	return new WritableStream<StreamTargetChunk>({
		async write(chunk) {
			await file.seek(chunk.position);
			await file.write(chunk.data);
		},
		async close() {
			await file.close();
		},
		async abort(reason) {
			await file.abort(reason);
		},
	});
}

async function runProbe(request: ProbeRequest): Promise<WorkerResponse> {
	post({ type: "progress", jobId: request.job.spec.job_id, phase: "probing container", completed: 1, total: 3 });
	const file = await fileForPath(request.originalPath);
	const report = await probeMediaFile({
		file,
		assetHash: request.assetHash,
		declaredMime: request.declaredMime,
		detectedMime: request.detectedMime,
	});
	if (cancellation.has(request.job.spec.job_id)) {
		return { type: "cancelled", jobId: request.job.spec.job_id };
	}
	return {
		type: "succeeded",
		jobId: request.job.spec.job_id,
		artifactPath: request.originalPath,
		byteLength: file.size,
		metadataJson: JSON.stringify(report),
	};
}

async function runProxy(request: DerivativeRequest): Promise<WorkerResponse> {
	const proxy = request.plan.proxy;
	if (!proxy) throw new Error("Proxy job has no Rust proxy plan");
	post({ type: "progress", jobId: request.job.spec.job_id, phase: "opening immutable source", completed: 1, total: 1_000 });
	const source = await fileForPath(request.originalPath);
	const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
	const width = Math.min(proxy.max_width, request.probe.width || proxy.max_width);
	const height = Math.min(proxy.max_height, request.probe.height || proxy.max_height);
	const [videoCodec, audioCodec] = await Promise.all([
		getFirstEncodableVideoCodec(["vp8", "vp9"], {
			width,
			height,
			bitrate: proxy.video_bitrate,
		}),
		request.probe.has_audio
			? getFirstEncodableAudioCodec(["opus"], {
				numberOfChannels: 2,
				sampleRate: 48_000,
				bitrate: 128_000,
			})
			: Promise.resolve(null),
	]);
	post({ type: "progress", jobId: request.job.spec.job_id, phase: "proxy capability ready", completed: 2, total: 1_000 });
	if (!videoCodec) {
		return {
			type: "failed",
			jobId: request.job.spec.job_id,
			code: "proxy_encoder_unavailable",
			message: "This browser cannot encode VP9 or VP8 proxy media.",
			retryable: false,
		};
	}
	const artifactPath = `derivatives/${request.job.spec.idempotency_key}.webm`;
	await removeArtifact(artifactPath).catch(() => undefined);
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new StreamTarget(await writableStreamForPath(artifactPath), {
			chunked: true,
			chunkSize: 4 * 1024 * 1024,
		}),
	});
	const conversion = await Conversion.init({
		input,
		output,
		video: {
			width,
			height,
			fit: "contain",
			codec: videoCodec,
			bitrate: proxy.video_bitrate,
			keyFrameInterval: proxy.keyframe_interval_ticks / 48_000,
			forceTranscode: true,
		},
		audio: request.probe.has_audio
			? {
					codec: audioCodec ?? "opus",
					numberOfChannels: 2,
					sampleRate: 48_000,
					bitrate: 128_000,
					forceTranscode: true,
				}
			: { discard: true },
		showWarnings: false,
	});
	post({ type: "progress", jobId: request.job.spec.job_id, phase: "proxy graph ready", completed: 3, total: 1_000 });
	if (!conversion.isValid) {
		return {
			type: "failed",
			jobId: request.job.spec.job_id,
			code: "proxy_conversion_invalid",
			message: conversion.discardedTracks.map((track) => track.reason).join("; ") || "Proxy conversion is invalid",
			retryable: false,
		};
	}
	conversions.set(request.job.spec.job_id, conversion);
	conversion.onProgress = (progress) =>
		post({
			type: "progress",
			jobId: request.job.spec.job_id,
			phase: "transcoding proxy",
			completed: Math.round(progress * 1_000),
			total: 1_000,
		});
	try {
		post({ type: "progress", jobId: request.job.spec.job_id, phase: "transcoding proxy", completed: 4, total: 1_000 });
		await conversion.execute();
		const artifact = await fileForPath(artifactPath);
		return {
			type: "succeeded",
			jobId: request.job.spec.job_id,
			artifactPath,
			byteLength: artifact.size,
			metadataJson: JSON.stringify({
				tier: proxy.tier,
				codec: videoCodec,
				width,
				height,
				streaming: true,
			}),
		};
	} finally {
		conversions.delete(request.job.spec.job_id);
	}
}

async function writeBytes({ path, bytes }: { path: string; bytes: Uint8Array }): Promise<void> {
	const handle = await fileHandleForPath({ path, create: true });
	const writable = await handle.createWritable({ keepExistingData: false });
	await writable.write(Uint8Array.from(bytes));
	await writable.close();
}

async function runWaveform(request: DerivativeRequest): Promise<WorkerResponse> {
	const waveform = request.plan.waveform;
	if (!waveform) throw new Error("Waveform job has no Rust waveform plan");
	const source = await fileForPath(request.originalPath);
	const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
	const audioTrack = await input.getPrimaryAudioTrack();
	if (!audioTrack) throw new Error("Waveform source has no audio track");
	const sink = new AudioSampleSink(audioTrack);
	const base: number[] = [];
	let bucketMin = 1;
	let bucketMax = -1;
	let bucketSquares = 0;
	let bucketCount = 0;
	for await (const sample of sink.samples()) {
		if (cancellation.has(request.job.spec.job_id)) {
			sample.close();
			return { type: "cancelled", jobId: request.job.spec.job_id };
		}
		const channels = Array.from({ length: sample.numberOfChannels }, (_, channel) => {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: channel, format: "f32-planar" });
			return data;
		});
		for (let sampleIndex = 0; sampleIndex < sample.numberOfFrames; sampleIndex += 1) {
			let mono = 0;
			for (const channel of channels) {
				mono += channel[sampleIndex] ?? 0;
			}
			mono /= Math.max(1, channels.length);
			bucketMin = Math.min(bucketMin, mono);
			bucketMax = Math.max(bucketMax, mono);
			bucketSquares += mono * mono;
			bucketCount += 1;
			if (bucketCount >= waveform.base_samples_per_bucket) {
				base.push(bucketMin, bucketMax, Math.sqrt(bucketSquares / bucketCount));
				bucketMin = 1;
				bucketMax = -1;
				bucketSquares = 0;
				bucketCount = 0;
			}
		}
		sample.close();
		post({
			type: "progress",
			jobId: request.job.spec.job_id,
			phase: "building waveform",
			completed: Math.min(request.probe.duration_ticks, Math.round((sample.timestamp + sample.duration) * 48_000)),
			total: request.probe.duration_ticks,
		});
	}
	if (bucketCount > 0) base.push(bucketMin, bucketMax, Math.sqrt(bucketSquares / bucketCount));
	const levelMetadata: Array<{ level: number; samplesPerBucket: number; pointCount: number; path: string }> = [];
	let values = new Float32Array(base);
	for (const level of waveform.levels) {
		const path = `waveforms/${request.job.spec.idempotency_key}-l${level.level}.f32`;
		await writeBytes({ path, bytes: new Uint8Array(values.buffer) });
		levelMetadata.push({
			level: level.level,
			samplesPerBucket: level.samples_per_bucket,
			pointCount: values.length / 3,
			path,
		});
		if (values.length <= 3) break;
		const next = new Float32Array(Math.ceil(values.length / 6) * 3);
		let outputIndex = 0;
		for (let inputIndex = 0; inputIndex < values.length; inputIndex += 6) {
			const min = Math.min(values[inputIndex] ?? 0, values[inputIndex + 3] ?? values[inputIndex] ?? 0);
			const max = Math.max(values[inputIndex + 1] ?? 0, values[inputIndex + 4] ?? values[inputIndex + 1] ?? 0);
			const rmsA = values[inputIndex + 2] ?? 0;
			const rmsB = values[inputIndex + 5] ?? rmsA;
			next[outputIndex] = min;
			next[outputIndex + 1] = max;
			next[outputIndex + 2] = Math.sqrt((rmsA * rmsA + rmsB * rmsB) / 2);
			outputIndex += 3;
		}
		values = next;
	}
	const metadataJson = JSON.stringify({
		version: 1,
		assetHash: request.probe.asset_hash,
		sampleRate: audioTrack.sampleRate,
		levels: levelMetadata,
	});
	const artifactPath = `waveforms/${request.job.spec.idempotency_key}.json`;
	await writeBytes({ path: artifactPath, bytes: new TextEncoder().encode(metadataJson) });
	const artifact = await fileForPath(artifactPath);
	return {
		type: "succeeded",
		jobId: request.job.spec.job_id,
		artifactPath,
		byteLength: artifact.size,
		metadataJson,
	};
}

workerScope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
	const request = event.data;
	if (request.type === "cancel") {
		cancellation.add(request.jobId);
		void conversions.get(request.jobId)?.cancel();
		return;
	}
	void (async () => {
		try {
			const response = request.type === "probe"
				? await runProbe(request)
				: request.job.spec.kind === "proxy"
					? await runProxy(request)
					: await runWaveform(request);
			post(response);
		} catch (error) {
			if (
				error instanceof ConversionCanceledError ||
				cancellation.has(request.job.spec.job_id)
			) {
				post({ type: "cancelled", jobId: request.job.spec.job_id });
			} else {
				post({
					type: "failed",
					jobId: request.job.spec.job_id,
					code: "worker_error",
					message: error instanceof Error ? error.message : "Media worker failed",
					retryable: true,
				});
			}
		} finally {
			cancellation.delete(request.job.spec.job_id);
		}
	})();
});

export {};
