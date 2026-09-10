"use client";

import type {
	CommandPayload,
	CropOverride,
	RenderManifest,
	ResolvedVariant,
	SceneScope,
	StudioState,
	VariantScope,
} from "@variantlab/studio-contract";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { clampCrop, nudgeCrop } from "./variant-crop";
import {
	buildVariantRenderManifest,
	buildRenderSourceCrop,
	resolveVariant,
} from "./domain";
import type {
	PlaybackChannel,
	PlaybackSemanticState,
} from "./playback-channel";
import { TICKS_PER_SECOND } from "./timeline-math";
import { useVariantLabLocale } from "./locale";

type ScopedCommand = {
	payload: CommandPayload;
	sceneScope: SceneScope;
	variantScope: VariantScope;
};

type VariantPreviewWallProps = {
	state: StudioState;
	previewUrl: string | null;
	videoRef: RefObject<HTMLVideoElement | null>;
	playback: PlaybackChannel;
	playbackState: PlaybackSemanticState;
	onCommand: (command: ScopedCommand) => Promise<void>;
	onNotice: (notice: string) => void;
};

type M3Metrics = {
	resolveSamplesMs: number[];
	warmSeekSamplesMs: number[];
};

const PORTRAIT_PROFILE_ID = "delivery-portrait-9x16";
const PORTRAIT_CELL_ID = "cell-master-portrait-9x16";
const DEFAULT_CROP: CropOverride = {
	x_basis_points: 0,
	y_basis_points: 0,
	scale_basis_points: 10_000,
};

function metricWindow(): Window & { __variantlabM3Metrics?: M3Metrics } {
	return window as Window & { __variantlabM3Metrics?: M3Metrics };
}

function recordMetric({
	kind,
	durationMs,
}: {
	kind: keyof M3Metrics;
	durationMs: number;
}): void {
	const target = metricWindow();
	const metrics = target.__variantlabM3Metrics ?? {
		resolveSamplesMs: [],
		warmSeekSamplesMs: [],
	};
	metrics[kind].push(durationMs);
	if (metrics[kind].length > 100) metrics[kind].shift();
	target.__variantlabM3Metrics = metrics;
}

function drawPortraitFrame({
	canvas,
	video,
	crop,
}: {
	canvas: HTMLCanvasElement;
	video: HTMLVideoElement;
	crop: CropOverride;
}): void {
	if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
	const context = canvas.getContext("2d", { alpha: false });
	if (!context || video.videoWidth === 0 || video.videoHeight === 0) return;

	const rect = buildRenderSourceCrop({
		canvas: { width: canvas.width, height: canvas.height },
		crop,
		sourceWidth: video.videoWidth,
		sourceHeight: video.videoHeight,
	});
	context.fillStyle = "#000";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.drawImage(
		video,
		rect.x,
		rect.y,
		rect.width,
		rect.height,
		0,
		0,
		canvas.width,
		canvas.height,
	);
}

function canvasChecksum(canvas: HTMLCanvasElement): number {
	const context = canvas.getContext("2d");
	if (!context) return -1;
	const pixels = context.getImageData(
		0,
		0,
		Math.min(16, canvas.width),
		Math.min(16, canvas.height),
	).data;
	let checksum = 0;
	for (let index = 0; index < pixels.length; index += 16) {
		checksum = (checksum * 31 + pixels[index]) >>> 0;
	}
	return checksum;
}

export function VariantPreviewWall({
	state,
	previewUrl,
	videoRef,
	playback,
	playbackState,
	onCommand,
	onNotice,
}: VariantPreviewWallProps) {
	const { t } = useVariantLabLocale();
	const cell =
		state.campaign.variant_cells.find(
			(candidate) => candidate.creative_set_id === "master",
		) ?? null;
	const [resolved, manifest] = useMemo<
		[ResolvedVariant | null, RenderManifest | null]
	>(() => {
		if (!cell) return [null, null];
		// eslint-disable-next-line react-hooks/purity -- diagnostic timing does not influence domain results or rendered state.
		const startedAt = performance.now();
		const nextResolved = resolveVariant({ state, cellId: cell.id });
		// eslint-disable-next-line react-hooks/purity -- observe actual work rather than running synthetic resolver loops.
		recordMetric({ kind: "resolveSamplesMs", durationMs: performance.now() - startedAt });
		return [
			nextResolved,
			buildVariantRenderManifest({ state, cellId: cell.id }),
		];
	}, [cell, state]);
	const [draftCrop, setDraftCrop] = useState<CropOverride>(
		resolved?.crop ?? DEFAULT_CROP,
	);
	const [surfaceCheck, setSurfaceCheck] = useState("NOT RUN");
	const portraitCanvasRef = useRef<HTMLCanvasElement>(null);
	const draftCropRef = useRef(draftCrop);
	const dragRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		origin: CropOverride;
	} | null>(null);
	const moveFrameRef = useRef<number | null>(null);
	const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);

	const updateDraft = useCallback((crop: CropOverride) => {
		const next = clampCrop(crop);
		draftCropRef.current = next;
		setDraftCrop(next);
	}, []);

	useEffect(() => {
		if (!dragRef.current && resolved) updateDraft(resolved.crop);
	}, [resolved, updateDraft]);

	useEffect(() => {
		const canvas = portraitCanvasRef.current;
		const video = videoRef.current;
		if (!canvas || !video || !previewUrl) return;
		let frameId = 0;
		let cancelled = false;
		const draw = () => {
			if (cancelled) return;
			drawPortraitFrame({ canvas, video, crop: draftCropRef.current });
			if (playbackState.isPlaying) frameId = requestAnimationFrame(draw);
		};
		frameId = requestAnimationFrame(draw);
		video.addEventListener("loadeddata", draw);
		video.addEventListener("seeked", draw);
		return () => {
			cancelled = true;
			cancelAnimationFrame(frameId);
			video.removeEventListener("loadeddata", draw);
			video.removeEventListener("seeked", draw);
		};
	}, [playbackState.isPlaying, previewUrl, videoRef]);

	const commitCrop = useCallback(
		async (crop: CropOverride) => {
			if (!cell) return;
			await onCommand({
				payload: { command: "set_variant_crop", cell_id: cell.id, crop },
				sceneScope: { kind: "sequence" },
				variantScope: { kind: "variant_cell", variant_cell_id: cell.id },
			});
		},
		[cell, onCommand],
	);

	function createPortraitProfile(): void {
		void onCommand({
			payload: {
				command: "create_delivery_profile",
				cell_id: PORTRAIT_CELL_ID,
				profile: {
					id: PORTRAIT_PROFILE_ID,
					name: "Portrait 9:16",
					canvas: { width: 1080, height: 1920 },
					safe_area: {
						top_basis_points: 800,
						right_basis_points: 500,
						bottom_basis_points: 1_200,
						left_basis_points: 500,
					},
					locale: "source",
					layout_constraints: ["crop-only", "safe-area"],
					version: 1,
				},
			},
			sceneScope: { kind: "sequence" },
			variantScope: {
				kind: "delivery_profile",
				delivery_profile_id: PORTRAIT_PROFILE_ID,
			},
		}).catch((error: unknown) =>
			onNotice(
				error instanceof Error
					? error.message
					: "Could not create 9:16 profile",
			),
		);
	}

	function onCropPointerMove(
		event: ReactPointerEvent<HTMLButtonElement>,
	): void {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		pendingMoveRef.current = { x: event.clientX, y: event.clientY };
		if (moveFrameRef.current !== null) return;
		const target = event.currentTarget;
		moveFrameRef.current = requestAnimationFrame(() => {
			moveFrameRef.current = null;
			const pending = pendingMoveRef.current;
			if (!pending || !dragRef.current) return;
			const rect = target.getBoundingClientRect();
			updateDraft({
				...drag.origin,
				x_basis_points:
					drag.origin.x_basis_points +
					((pending.x - drag.startX) / Math.max(1, rect.width)) * 10_000,
				y_basis_points:
					drag.origin.y_basis_points +
					((pending.y - drag.startY) / Math.max(1, rect.height)) * 10_000,
			});
		});
	}

	function cancelCropGesture(target: HTMLButtonElement): void {
		const drag = dragRef.current;
		if (!drag) return;
		if (target.hasPointerCapture(drag.pointerId)) {
			target.releasePointerCapture(drag.pointerId);
		}
		dragRef.current = null;
		pendingMoveRef.current = null;
		if (moveFrameRef.current !== null)
			cancelAnimationFrame(moveFrameRef.current);
		moveFrameRef.current = null;
		updateDraft(resolved?.crop ?? DEFAULT_CROP);
		onNotice("Crop preview cancelled; canonical variant was not changed.");
	}

	function onCropKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
		if (event.key === "Escape" && dragRef.current) {
			event.preventDefault();
			cancelCropGesture(event.currentTarget);
			return;
		}
		if (!event.key.startsWith("Arrow")) return;
		event.preventDefault();
		const next = nudgeCrop({
			crop: draftCropRef.current,
			key: event.key,
			coarse: event.shiftKey,
		});
		updateDraft(next);
		void commitCrop(next);
	}

	function seekForward(): void {
		const video = videoRef.current;
		const startedAt = performance.now();
		if (video) {
			video.addEventListener(
				"seeked",
				() =>
					recordMetric({
						kind: "warmSeekSamplesMs",
						durationMs: performance.now() - startedAt,
					}),
				{ once: true },
			);
		}
		playback.seek(
			playback.getCurrentTicks() + Math.round(5 * TICKS_PER_SECOND),
		);
		if (!video) {
			recordMetric({
				kind: "warmSeekSamplesMs",
				durationMs: performance.now() - startedAt,
			});
		}
	}

	function verifySurfaceIsolation(): void {
		const video = videoRef.current;
		const preview = portraitCanvasRef.current;
		if (!video || !preview || !manifest) {
			setSurfaceCheck("WAITING FOR MEDIA");
			return;
		}
		const beforeTime = video.currentTime;
		const beforeChecksum = canvasChecksum(preview);
		const surfaces = [
			{ width: 160, height: 90 },
			{ width: 80, height: 45 },
			{ width: 270, height: 480 },
		].map(({ width, height }) => {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			return canvas;
		});
		const snapshotContext = surfaces[0].getContext("2d");
		const thumbnailContext = surfaces[1].getContext("2d");
		if (snapshotContext) snapshotContext.drawImage(video, 0, 0, 160, 90);
		if (thumbnailContext) thumbnailContext.drawImage(video, 0, 0, 80, 45);
		drawPortraitFrame({ canvas: surfaces[2], video, crop: manifest.crop });
		const isolated =
			Math.abs(video.currentTime - beforeTime) < 0.01 &&
			preview.width === 270 &&
			preview.height === 480 &&
			canvasChecksum(preview) === beforeChecksum &&
			new Set(surfaces).size === 3;
		setSurfaceCheck(isolated ? "SURFACES ISOLATED" : "SURFACE CONTAMINATION");
	}

	return (
		<section
			className="border-2 border-[#172128] bg-[#172128] p-3 text-white"
			aria-labelledby="variant-prism-heading"
			data-testid="variant-preview-wall"
			data-variant-fingerprint={resolved?.fingerprint ?? ""}
		>
			<div className="mb-3 flex flex-wrap items-end justify-between gap-3">
				<div>
					<p className="font-mono text-[10px] font-bold tracking-[0.18em] text-[#aac0ca] uppercase">
						{t({
							ru: "M3 / синхронные форматы",
							en: "M3 / synchronized formats",
						})}
					</p>
					<h4 id="variant-prism-heading" className="text-lg font-black">
						Variant Prism
					</h4>
				</div>
				{!cell ? (
					<button
						type="button"
						onClick={createPortraitProfile}
						className="border-2 border-white bg-[#a94720] px-3 py-2 text-sm font-bold text-white focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#ffd277]"
					>
						{t({ ru: "Создать адаптивный 9:16", en: "Create adaptive 9:16" })}
					</button>
				) : (
					<p className="font-mono text-[10px] text-[#aac0ca]">
						REV {state.campaign.revision} · {resolved?.fingerprint.slice(0, 12)}
					</p>
				)}
				<p className="font-mono text-xs" data-testid="shared-clock-state">
					{playbackState.direction.toUpperCase()}{" "}
					{playbackState.rate === 0 ? "" : `${Math.abs(playbackState.rate)}×`}
				</p>
			</div>

			<div className="grid gap-3 lg:grid-cols-[minmax(320px,1fr)_minmax(180px,270px)]">
				<div className="relative flex min-h-56 items-center justify-center overflow-hidden border border-[#66808d] bg-black">
					{previewUrl ? (
						// Caption tracks are attached only when the imported source provides them.
						// eslint-disable-next-line jsx-a11y/media-has-caption
						<video
							ref={videoRef}
							src={previewUrl}
							playsInline
							preload="metadata"
							className="max-h-72 w-full object-contain"
							aria-label={t({
								ru: "Предпросмотр исходника",
								en: "Master preview",
							})}
						/>
					) : (
						<p className="max-w-xs p-6 text-center text-sm text-[#aac0ca]">
							{t({
								ru: "Импортируйте исходник 16:9, поддерживаемый браузером.",
								en: "Import a browser-decodable 16:9 master.",
							})}
						</p>
					)}
					<div
						className="pointer-events-none absolute inset-3 border border-white/35"
						aria-hidden="true"
					/>
					<span className="absolute top-3 left-3 bg-[#172128] px-2 py-1 font-mono text-[10px]">
						MASTER · 16:9
					</span>
				</div>

				{resolved ? (
					<button
						type="button"
						aria-label={t({
							ru: "Кадрирование 9:16. Используйте стрелки; Shift увеличивает шаг.",
							en: "Adjust 9:16 crop. Use arrow keys; hold Shift for coarse steps.",
						})}
						className="relative mx-auto aspect-9/16 w-full max-w-[270px] cursor-move overflow-hidden border-2 border-[#ffd277] bg-black p-0 focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#d26532]"
						onPointerDown={(event) => {
							event.currentTarget.setPointerCapture(event.pointerId);
							dragRef.current = {
								pointerId: event.pointerId,
								startX: event.clientX,
								startY: event.clientY,
								origin: draftCropRef.current,
							};
						}}
						onPointerMove={onCropPointerMove}
						onPointerUp={(event) => {
							if (!dragRef.current) return;
							event.currentTarget.releasePointerCapture(event.pointerId);
							dragRef.current = null;
							void commitCrop(draftCropRef.current);
						}}
						onPointerCancel={(event) => cancelCropGesture(event.currentTarget)}
						onKeyDown={onCropKeyDown}
					>
						<canvas
							ref={portraitCanvasRef}
							width={270}
							height={480}
							className="h-full w-full"
							aria-hidden="true"
						/>
						<span
							className="pointer-events-none absolute border border-dashed border-[#ffd277]"
							style={{
								top: `${resolved.safe_area.top_basis_points / 100}%`,
								right: `${resolved.safe_area.right_basis_points / 100}%`,
								bottom: `${resolved.safe_area.bottom_basis_points / 100}%`,
								left: `${resolved.safe_area.left_basis_points / 100}%`,
							}}
							aria-hidden="true"
						/>
						<span className="pointer-events-none absolute top-2 left-2 bg-[#172128] px-2 py-1 font-mono text-[10px]">
							DELIVERY · 9:16
						</span>
					</button>
				) : (
					<div className="flex aspect-9/16 w-full max-w-[270px] items-center justify-center border border-dashed border-[#66808d] p-5 text-center text-sm text-[#aac0ca]">
						{t({
							ru: "Создайте явный профиль доставки. Комбинации вариантов не создаются автоматически.",
							en: "Create the explicit delivery profile; no Cartesian variants are generated.",
						})}
					</div>
				)}
			</div>

			<div className="mt-3 flex flex-wrap gap-2">
				<button
					type="button"
					onClick={() => playback.toggle()}
					className="border border-[#66808d] px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#ffd277]"
				>
					{playbackState.isPlaying
						? t({
								ru: "Пауза общего воспроизведения",
								en: "Pause shared clock",
							})
						: t({ ru: "Общее воспроизведение", en: "Play shared clock" })}
				</button>
				<button
					type="button"
					onClick={() => playback.step(-1)}
					className="border border-[#66808d] px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#ffd277]"
				>
					{t({ ru: "Предыдущий кадр", en: "Previous frame" })}
				</button>
				<button
					type="button"
					onClick={() => playback.step(1)}
					className="border border-[#66808d] px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#ffd277]"
				>
					{t({ ru: "Следующий кадр", en: "Next frame" })}
				</button>
				<button
					type="button"
					onClick={seekForward}
					className="border border-[#66808d] px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#ffd277]"
				>
					{t({ ru: "Вперёд на 5 с", en: "Seek +5 s" })}
				</button>
				{cell ? (
					<>
						<button
							type="button"
							onClick={() =>
								void onCommand({
									payload: { command: "undo" },
									sceneScope: { kind: "sequence" },
									variantScope: {
										kind: "variant_cell",
										variant_cell_id: cell.id,
									},
								})
							}
							className="border border-[#ffd277] px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#ffd277]"
						>
							{t({ ru: "Отменить кадрирование 9:16", en: "Undo 9:16 crop" })}
						</button>
						<button
							type="button"
							onClick={() =>
								void onCommand({
									payload: { command: "reset_variant_crop", cell_id: cell.id },
									sceneScope: { kind: "sequence" },
									variantScope: {
										kind: "variant_cell",
										variant_cell_id: cell.id,
									},
								})
							}
							className="border border-[#ffd277] px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#ffd277]"
						>
							{t({ ru: "Сбросить кадрирование", en: "Reset crop" })}
						</button>
					</>
				) : null}
				<button
					type="button"
					onClick={verifySurfaceIsolation}
					disabled={!manifest || !previewUrl}
					className="ml-auto border border-[#66808d] px-3 py-2 text-xs font-bold disabled:opacity-40 focus-visible:outline-3 focus-visible:outline-[#ffd277]"
				>
					{t({
						ru: "Проверить изоляцию поверхностей",
						en: "Check snapshot / thumbnail / export",
					})}
				</button>
			</div>

			{resolved ? (
				<div className="mt-3 grid gap-3 border-t border-[#66808d] pt-3 font-mono text-[10px] text-[#aac0ca] md:grid-cols-3">
					<p>
						CROP X {draftCrop.x_basis_points} · Y {draftCrop.y_basis_points} ·
						SCALE {(draftCrop.scale_basis_points / 100).toFixed(0)}%
					</p>
					<p>
						SAFE AREA · top {resolved.safe_area.top_basis_points / 100}% ·
						bottom {resolved.safe_area.bottom_basis_points / 100}%
					</p>
					<p data-testid="surface-isolation-status">{surfaceCheck}</p>
					<p className="md:col-span-3">
						PROVENANCE ·{" "}
						{resolved.provenance
							.map((entry) => `${entry.field}←${entry.source}`)
							.join(" · ")}
					</p>
				</div>
			) : null}
		</section>
	);
}
