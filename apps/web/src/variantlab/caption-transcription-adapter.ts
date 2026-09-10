"use client";

import { createAudioContext } from "@/media/audio";
import { transcriptionService } from "@/services/transcription/service";
import type {
	TranscriptionProgress,
	TranscriptionSegment,
} from "@/transcription/types";

const SAMPLE_RATE = 16_000;

function mixToMono(buffer: AudioBuffer): AudioBuffer {
	if (buffer.numberOfChannels === 1) return buffer;
	const context = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
	const mono = context.createBuffer(1, buffer.length, buffer.sampleRate);
	const output = mono.getChannelData(0);
	for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
		const input = buffer.getChannelData(channel);
		for (let index = 0; index < input.length; index += 1)
			output[index] += input[index] / buffer.numberOfChannels;
	}
	return mono;
}

async function resample(buffer: AudioBuffer): Promise<Float32Array> {
	const mono = mixToMono(buffer);
	if (mono.sampleRate === SAMPLE_RATE) return mono.getChannelData(0).slice();
	const frameCount = Math.ceil(mono.duration * SAMPLE_RATE);
	const offline = new OfflineAudioContext(1, frameCount, SAMPLE_RATE);
	const source = offline.createBufferSource();
	source.buffer = mono;
	source.connect(offline.destination);
	source.start();
	return (await offline.startRendering()).getChannelData(0).slice();
}

export async function transcribeFile({
	file,
	modelRevision,
	onProgress,
}: {
	file: File;
	modelRevision: string;
	onProgress: (progress: TranscriptionProgress) => void;
}): Promise<TranscriptionSegment[]> {
	const context = createAudioContext();
	try {
		const decoded = await context.decodeAudioData(await file.arrayBuffer());
		const audioData = await resample(decoded);
		const result = await transcriptionService.transcribe({
			audioData,
			language: "auto",
			modelId: "whisper-tiny",
			modelRevision,
			onProgress,
		});
		return result.segments;
	} finally {
		void context.close();
	}
}

export function cancelTranscription(): void {
	transcriptionService.cancel();
}
