"use client";

import type { PersistedJob } from "@variantlab/studio-contract";
import { useEffect, useRef, useState } from "react";
import { fileForPath } from "./media-store";
import { waveformLevelForZoom } from "./timeline-math";
import { useVariantLabLocale } from "./locale";

type WaveformManifest = {
	version: number;
	assetHash: string;
	sampleRate: number;
	levels: Array<{ level: number; samplesPerBucket: number; pointCount: number; path: string }>;
};

export function WaveformOverview({ job }: { job: PersistedJob | undefined }) {
	const { t } = useVariantLabLocale();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [loadedLevel, setLoadedLevel] = useState<number | null>(null);

	useEffect(() => {
		let cancelled = false;
		const draw = async () => {
			if (!job?.artifact_path || job.state !== "succeeded") return;
			// The manifest is written by this repository's typed media worker.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const manifest = JSON.parse(await (await fileForPath(job.artifact_path)).text()) as WaveformManifest;
			const levelNumber = waveformLevelForZoom({ levels: manifest.levels, pixelsPerSecond: 80, sampleRate: manifest.sampleRate });
			const level = manifest.levels.find((candidate) => candidate.level === levelNumber);
			if (!level) return;
			const bytes = await (await fileForPath(level.path)).arrayBuffer();
			if (cancelled) return;
			const values = new Float32Array(bytes);
			const canvas = canvasRef.current;
			const context = canvas?.getContext("2d");
			if (!canvas || !context) return;
			const dpr = Math.max(1, window.devicePixelRatio || 1);
			const width = Math.max(1, canvas.clientWidth);
			const height = Math.max(1, canvas.clientHeight);
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			context.scale(dpr, dpr);
			context.clearRect(0, 0, width, height);
			context.strokeStyle = "#73b7d1";
			context.lineWidth = 1;
			context.beginPath();
			const points = Math.floor(values.length / 3);
			for (let x = 0; x < width; x += 1) {
				const point = Math.min(points - 1, Math.floor((x / width) * points));
				const minimum = values[point * 3] ?? 0;
				const maximum = values[point * 3 + 1] ?? 0;
				context.moveTo(x + 0.5, ((1 - maximum) * height) / 2);
				context.lineTo(x + 0.5, ((1 - minimum) * height) / 2);
			}
			context.stroke();
			setLoadedLevel(level.level);
		};
		void draw();
		return () => {
			cancelled = true;
		};
	}, [job]);

	return (
		<div className="border-t border-[#66808d] bg-[#101419] p-2" data-waveform-level={loadedLevel ?? "pending"}>
			<div className="mb-1 flex justify-between font-mono text-[9px] uppercase text-[#aac0ca]"><span>{t({ ru: "Многоуровневая звуковая волна", en: "Waveform pyramid" })}</span><span>{loadedLevel === null ? t({ ru: "в очереди", en: "queued" }) : `${t({ ru: "уровень", en: "level" })} ${loadedLevel}`}</span></div>
			<canvas ref={canvasRef} className="h-12 w-full" aria-label={loadedLevel === null ? t({ ru: "Ожидание звуковой волны", en: "Waveform derivative pending" }) : t({ ru: `Обзор звуковой волны, уровень ${loadedLevel}`, en: `Waveform overview using pyramid level ${loadedLevel}` })} />
		</div>
	);
}
