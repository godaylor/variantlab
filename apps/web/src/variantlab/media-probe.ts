import type { ProbeReport } from "@variantlab/studio-contract";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";

const TICKS_PER_SECOND = 48_000;

function greatestCommonDivisor({ left, right }: { left: number; right: number }): number {
	let a = Math.abs(Math.round(left));
	let b = Math.abs(Math.round(right));
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a || 1;
}

function rationalFrameRate({ rate }: { rate: number }): { num: number; den: number } {
	const standards = [
		{ rate: 23.976, num: 24_000, den: 1_001 },
		{ rate: 29.97, num: 30_000, den: 1_001 },
		{ rate: 59.94, num: 60_000, den: 1_001 },
		{ rate: 24, num: 24, den: 1 },
		{ rate: 25, num: 25, den: 1 },
		{ rate: 30, num: 30, den: 1 },
		{ rate: 50, num: 50, den: 1 },
		{ rate: 60, num: 60, den: 1 },
	];
	const standard = standards.find((candidate) =>
		Math.abs(candidate.rate - rate) < 0.02,
	);
	if (standard) return { num: standard.num, den: standard.den };
	const scaled = Math.max(1, Math.round(rate * 1_000));
	const divisor = greatestCommonDivisor({ left: scaled, right: 1_000 });
	return { num: scaled / divisor, den: 1_000 / divisor };
}

export async function probeMediaFile({
	file,
	assetHash,
	declaredMime,
	detectedMime,
}: {
	file: File;
	assetHash: string;
	declaredMime: string;
	detectedMime: string;
}): Promise<ProbeReport> {
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	const durationSeconds = await input.computeDuration();
	const [videoTrack, audioTrack] = await Promise.all([
		input.getPrimaryVideoTrack(),
		input.getPrimaryAudioTrack(),
	]);
	const [videoCanDecode, audioCanDecode, videoStats] = await Promise.all([
		videoTrack?.canDecode() ?? Promise.resolve(true),
		audioTrack?.canDecode() ?? Promise.resolve(true),
		videoTrack?.computePacketStats(96) ?? Promise.resolve(null),
	]);
	const frameRate = rationalFrameRate({ rate: videoStats?.averagePacketRate ?? 30 });
	return {
		asset_hash: assetHash,
		byte_length: file.size,
		declared_mime: declaredMime,
		detected_mime: detectedMime,
		duration_ticks: Math.max(0, Math.round(durationSeconds * TICKS_PER_SECOND)),
		width: videoTrack?.displayWidth ?? 0,
		height: videoTrack?.displayHeight ?? 0,
		fps_num: videoTrack ? frameRate.num : 1,
		fps_den: videoTrack ? frameRate.den : 1,
		has_video: videoTrack !== null,
		has_audio: audioTrack !== null,
		video_codec: videoTrack?.codec ?? null,
		audio_codec: audioTrack?.codec ?? null,
		can_decode: videoCanDecode && audioCanDecode,
	};
}
