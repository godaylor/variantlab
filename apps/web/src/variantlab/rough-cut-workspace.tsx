"use client";

import type {
	CommandPayload,
	PersistedJob,
	SceneScope,
	StudioState,
	Timeline,
	TimelineEdit,
	VariantScope,
} from "@variantlab/studio-contract";
import { useEffect, useMemo, useRef, useState } from "react";
import { CaptionLocaleBoard } from "./caption-locale-board";
import { CreativeSlotBoard } from "./creative-slot-board";
import { MediaJobPipeline, type PipelineSnapshot } from "./media-jobs";
import { previewMediaCache } from "./media-file-cache";
import type { StoredMediaAsset } from "./media-store";
import { campaignOriginalHashes } from "variantlab-wasm";
import {
	PlaybackChannel,
	type PlaybackSemanticState,
} from "./playback-channel";
import { RoughCutTimeline } from "./rough-cut-timeline";
import { VariantPreviewWall } from "./variant-preview-wall";
import { VariantMatrix } from "./variant-matrix";
import { WaveformOverview } from "./waveform-overview";
import { useVariantLabLocale } from "./locale";
import { useUiCopy } from "./ui-copy";

type RoughCutWorkspaceProps = {
	campaignId: string;
	studioState: StudioState;
	sceneId: string;
	timeline: Timeline;
	onCommit: (edit: TimelineEdit) => Promise<void>;
	onVariantCommand: (command: {
		payload: CommandPayload;
		sceneScope: SceneScope;
		variantScope: VariantScope;
	}) => Promise<void>;
	onNotice: (notice: string) => void;
	onGestureState: (active: boolean) => void;
};

const EMPTY_PIPELINE: PipelineSnapshot = {
	jobs: [],
	assets: [],
	importProgress: null,
	notice: "Media jobs are loading.",
};

function jobPercent(job: PersistedJob): number {
	return Math.round((job.completed_units / Math.max(1, job.total_units)) * 100);
}

function jobLabel(job: PersistedJob): string {
	if (job.spec.kind === "probe") return "Content probe";
	if (job.spec.kind === "proxy") return "Preview proxy";
	return "Waveform pyramid";
}

export function RoughCutWorkspace({
	campaignId,
	studioState,
	sceneId,
	timeline,
	onCommit,
	onVariantCommand,
	onNotice,
	onGestureState,
}: RoughCutWorkspaceProps) {
	const { t } = useVariantLabLocale();
	const copy = useUiCopy();
	// Rust includes every scene, disabled variant and slot replacement.
	const referencedHashes = useMemo(() => {
		const originalHashes: unknown = JSON.parse(campaignOriginalHashes(JSON.stringify(studioState)));
		return new Set(Array.isArray(originalHashes) ? originalHashes.filter((value): value is string => typeof value === "string") : []);
	}, [studioState]);
	const [pipeline] = useState(() => new MediaJobPipeline());
	const [pipelineState, setPipelineState] = useState(EMPTY_PIPELINE);
	const [playbackState, setPlaybackState] = useState<PlaybackSemanticState>({
		rate: 0,
		isPlaying: false,
		direction: "stopped",
	});
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [playback] = useState(
		() =>
			new PlaybackChannel({
				timeline,
				onFrame: () => undefined,
				onSemanticState: () => undefined,
			}),
	);
	const videoRef = useRef<HTMLVideoElement>(null);
	const pendingInsertions = useRef(new Set<string>());
	// Only this live import gesture may request insertion. Recovered assets are
	// a library, not instructions to restore clips removed from the timeline.
	const importRequests = useRef(new Set<string>());
const [importRequestVersion, setImportRequestVersion] = useState(0);

	useEffect(() => pipeline.subscribe(setPipelineState), [pipeline]);

	useEffect(() => {
		if (
			(process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_VARIANTLAB_M2_TEST_ADAPTER !== "1") ||
			new URLSearchParams(window.location.search).get(
				"m2ExposeTestPipeline",
			) !== "1"
		)
			return;
		const testWindow = window as typeof window & {
			__variantlabM2CrashWorker?: () => void;
		};
		testWindow.__variantlabM2CrashWorker = () =>
			pipeline.crashActiveWorkerForTest();
		return () => {
			delete testWindow.__variantlabM2CrashWorker;
		};
	}, [pipeline]);

	useEffect(() => {
		void pipeline.initialize(campaignId).catch((error: unknown) => {
			onNotice(
				error instanceof Error ? error.message : "Media job recovery failed",
			);
		});
	}, [campaignId, onNotice, pipeline]);

	useEffect(() => {
		playback.setTimeline(timeline);
		playback.setSemanticListener((state) => {
			setPlaybackState(state);
			pipeline.setPlaybackActive(state.isPlaying);
		});
	}, [pipeline, playback, timeline]);

	useEffect(() => {
		playback.attachVideo(videoRef.current);
	}, [playback, previewUrl]);

	const previewAsset = pipelineState.assets.find((asset) =>
		timeline.tracks.some((track) => track.clips.some((clip) => clip.asset_id === asset.asset_hash)));
	const previewProxy = pipelineState.jobs.find((job) =>
		job.spec.kind === "proxy" && job.spec.asset_hash === previewAsset?.asset_hash &&
		job.state === "succeeded" && job.artifact_path);
	const previewPath = previewProxy?.artifact_path ?? previewAsset?.original_path ?? null;

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		let objectUrl: string | null = null;
		const loadPreview = async () => {
			if (!previewPath) {
				setPreviewUrl(null);
				return;
			}
			const file = await previewMediaCache.get({
				path: previewPath,
				signal: controller.signal,
			});
			if (cancelled) return;
			objectUrl = URL.createObjectURL(file);
			setPreviewUrl(objectUrl);
		};
		void loadPreview().catch((error: unknown) => {
			onNotice(
				error instanceof Error ? error.message : "Preview source failed",
			);
		});
		return () => {
			cancelled = true;
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [onNotice, previewPath]);

	useEffect(() => {
		const timelineAssetHashes = new Set(
			timeline.tracks.flatMap((track) =>
				track.clips.map((clip) => clip.asset_id),
			),
		);
		for (const asset of pipelineState.assets.filter(
			(candidate) => candidate.scene_id === sceneId && importRequests.current.has(candidate.asset_hash),
		)) {
			if (timelineAssetHashes.has(asset.asset_hash)) {
				importRequests.current.delete(asset.asset_hash);
				continue;
			}
			if (
				pendingInsertions.current.has(asset.asset_hash)
			) {
				continue;
			}
			const targetTrack = asset.probe.has_video
				? timeline.tracks.find((track) => track.kind === "video")
				: timeline.tracks.find((track) => track.kind === "audio");
			if (!targetTrack) continue;
			importRequests.current.delete(asset.asset_hash);
			pendingInsertions.current.add(asset.asset_hash);
			void onCommit({
				edit: "insert_clip",
				track_id: targetTrack.id,
				clip: {
					id: crypto.randomUUID(),
					asset_id: asset.asset_hash,
					label: asset.name,
					start_ticks: timeline.duration_ticks,
					duration_ticks: asset.probe.duration_ticks,
					source_offset_ticks: 0,
					source_duration_ticks: asset.probe.duration_ticks,
					has_audio: asset.probe.has_audio,
				},
			})
				.catch((error: unknown) => {
					onNotice(
						error instanceof Error
							? error.message
							: "Could not insert imported media",
					);
				})
				.finally(() => pendingInsertions.current.delete(asset.asset_hash));
		}
	}, [importRequestVersion, onCommit, onNotice, pipelineState.assets, sceneId, timeline]);

	async function addFromLibrary(asset: StoredMediaAsset) {
		const track = timeline.tracks.find((item) => item.kind === (asset.probe.has_video ? "video" : "audio"));
		if (!track) return;
		try {
			await onCommit({ edit: "insert_clip", track_id: track.id, clip: {
				id: crypto.randomUUID(), asset_id: asset.asset_hash, label: asset.name,
				start_ticks: timeline.duration_ticks, duration_ticks: asset.probe.duration_ticks,
				source_offset_ticks: 0, source_duration_ticks: asset.probe.duration_ticks,
				has_audio: asset.probe.has_audio,
			} });
		} catch (error) { onNotice(error instanceof Error ? error.message : copy("Could not insert imported media")); }
	}

	async function removeFromLibrary(asset: StoredMediaAsset) {
		if (referencedHashes.has(asset.asset_hash)) return;
		if (!window.confirm(t({ ru: "Убрать исходник из файлов этой кампании на этом устройстве? Монтаж не изменится. Резервная копия останется для отмены; ранее загруженный файл в облаке не удаляется.", en: "Remove this source from this campaign’s file list on this device? The edit stays unchanged. A recovery copy is retained for undo; existing cloud uploads are not deleted." }))) return;
		try { await pipeline.setLibraryRemoved({ asset, removed: true }); }
		catch (error) { onNotice(error instanceof Error ? error.message : copy("Import failed before the asset manifest was committed.")); }
	}

	useEffect(
		() => () => {
			playback.dispose();
			pipeline.dispose();
		},
		[pipeline, playback],
	);

	const transcriptionAsset = pipelineState.assets.find(
		(candidate) => candidate.scene_id === sceneId,
	);
	const transcriptionSource = transcriptionAsset
		? {
				assetHash: transcriptionAsset.asset_hash,
				originalPath: transcriptionAsset.original_path,
			}
		: undefined;
	return (
		<section
			id="master-editor"
			className="mt-6 border-t-4 border-[#172128] pt-6"
			aria-labelledby="rough-cut-heading"
		>
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<p className="font-mono text-[11px] font-bold tracking-[0.18em] uppercase text-[#48606d]">
						{t({ ru: "Исходный ролик", en: "Master timeline" })}
					</p>
					<h3
						id="rough-cut-heading"
						className="mt-1 text-2xl font-black tracking-tight"
					>
						{t({ ru: "Черновой монтаж", en: "Rough cut control deck" })}
					</h3>
				</div>
				<label className="cursor-pointer border-2 border-[#172128] bg-[#4656ce] px-4 py-3 text-sm font-bold text-white shadow-[3px_3px_0_#172128] focus-within:outline-4 focus-within:outline-[#d26532]">
					{t({ ru: "Добавить видео или аудио", en: "Import master media" })}
					<input
						type="file"
						accept="video/*,audio/*,.mkv,.mov"
						className="sr-only"
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (!file) return;
							void pipeline
								.importFile({ file, sceneId })
								.then((hash) => { importRequests.current.add(hash); setImportRequestVersion((version) => version + 1); })
								.catch((error: unknown) => {
									onNotice(
										error instanceof Error
											? error.message
											: "Media import failed",
									);
								});
							event.target.value = "";
						}}
					/>
				</label>
			</div>

			<section id="media-library" data-testid="media-library" aria-label={t({ ru: "Файлы", en: "Files" })} className="mt-4 border border-[#b8c8ca] bg-white p-4">
				<h4 className="font-bold">{t({ ru: "Файлы", en: "Files" })}</h4>
				<p className="my-2 text-sm">{t({ ru: "Удаление клипа с ленты не удаляет исходный файл. Его можно добавить снова.", en: "Removing a timeline clip keeps its source file. You can add it again." })}</p>
				{pipelineState.assets.length === 0 && <p className="text-sm">{t({ ru: "Добавьте видео или аудио кнопкой выше.", en: "Add video or audio using the button above." })}</p>}
				<ul className="space-y-2">{pipelineState.assets.filter((asset) => !asset.removed_from_library || referencedHashes.has(asset.asset_hash)).map((asset) => <li key={asset.asset_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#b8c8ca] pt-2">
					<span className="min-w-0 break-all text-sm">{asset.name}</span>
					<span className="text-xs">{referencedHashes.has(asset.asset_hash) ? t({ ru: "Используется в монтаже или версиях. Сначала уберите все клипы и замены этого файла.", en: "Used in the edit or versions. Remove its clips and replacements first." }) : t({ ru: "Не используется", en: "Not used" })}</span>
					<button type="button" onClick={() => void addFromLibrary(asset)} className="min-h-11 border border-[#172128] px-3 text-sm font-bold focus-visible:outline-3 focus-visible:outline-[#a15d00]">{t({ ru: "Добавить на монтажную ленту", en: "Add to timeline" })}</button>
					<button type="button" disabled={referencedHashes.has(asset.asset_hash)} onClick={() => void removeFromLibrary(asset)} className="min-h-11 border border-[#172128] px-3 text-sm disabled:opacity-50">{t({ ru: "Убрать исходник из проекта", en: "Remove source from project" })}</button>
				</li>)}</ul>
				{pipelineState.assets.some((asset) => asset.removed_from_library && !referencedHashes.has(asset.asset_hash)) && <details className="mt-3"><summary className="cursor-pointer py-2">{t({ ru: "Убранные исходники — восстановить", en: "Removed sources — restore" })}</summary>{pipelineState.assets.filter((asset) => asset.removed_from_library && !referencedHashes.has(asset.asset_hash)).map((asset) => <p key={asset.asset_id} className="my-2 break-all text-sm">{asset.name} <button type="button" className="min-h-11 border border-[#172128] px-3" onClick={() => void pipeline.setLibraryRemoved({ asset, removed: false }).catch((error: unknown) => onNotice(error instanceof Error ? error.message : "Restore failed"))}>{t({ ru: "Восстановить исходник", en: "Restore source" })}</button></p>)}</details>}
			</section>
			<div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
				<div className="min-w-0">
					<VariantPreviewWall
						state={studioState}
						previewUrl={previewUrl}
						videoRef={videoRef}
						playback={playback}
						playbackState={playbackState}
						onCommand={onVariantCommand}
						onNotice={onNotice}
					/>
					<RoughCutTimeline
						timeline={timeline}
						playback={playback}
						onCommit={onCommit}
						onNotice={onNotice}
						onGestureState={onGestureState}
					/>
					<CreativeSlotBoard
						state={studioState}
						onCommand={onVariantCommand}
						onNotice={onNotice}
					/>
					<CaptionLocaleBoard
						state={studioState}
						asset={transcriptionSource}
						playbackState={playbackState}
						onCommand={onVariantCommand}
						onNotice={onNotice}
					/>
					<VariantMatrix
						state={studioState}
						previewUrl={previewUrl}
						onCommand={onVariantCommand}
						onNotice={onNotice}
					/>
					<WaveformOverview
						job={pipelineState.jobs.find(
							(job) =>
								job.spec.kind === "waveform" &&
								job.state === "succeeded" &&
								pipelineState.assets.some(
									(asset) =>
										asset.scene_id === sceneId &&
										asset.asset_hash === job.spec.asset_hash,
								),
						)}
					/>
				</div>

				<aside
					className="border-2 border-[#172128] bg-[#f6f7f4]"
					aria-labelledby="job-center-heading"
				>
					<div className="border-b-2 border-[#172128] bg-[#b9d1dc] p-4">
						<h4 id="job-center-heading" className="font-black">
							{t({ ru: "Центр задач", en: "Job Center" })}
						</h4>
						<p className="mt-1 text-xs text-[#394e59]">
							{t({
								ru: "Сохраняются локально · выполнение прекращается после закрытия вкладки",
								en: "Persisted locally · no work continues after the tab closes",
							})}
						</p>
					</div>
					<div className="p-4" role="status" aria-live="polite">
						<p className="text-xs leading-5 text-[#48606d]">
							{copy(pipelineState.notice)}
						</p>
						{pipelineState.importProgress !== null ? (
							<div className="mt-3">
								<div className="flex justify-between font-mono text-[10px]">
									<span>{t({ ru: "КОПИРОВАНИЕ И ПРОВЕРКА ФАЙЛА", en: "STAGING + HASH" })}</span>
									<span>{pipelineState.importProgress}%</span>
								</div>
								<progress
									value={pipelineState.importProgress}
									max={100}
									className="mt-1 h-2 w-full accent-[#5b6cff]"
								/>
							</div>
						) : null}
					</div>
					<ul className="max-h-[520px] divide-y divide-[#a9b1ad] overflow-auto border-t border-[#a9b1ad]">
						{pipelineState.jobs.map((job) => (
							<li
								key={job.spec.job_id}
								className="p-4"
								data-testid={`job-${job.spec.kind}`}
							>
								<div className="flex items-start justify-between gap-3">
									<div>
										<p className="text-sm font-bold">{copy(jobLabel(job))}</p>
										<p className="font-mono text-[10px] uppercase text-[#48606d]">
											{copy(job.state)} · {t({ ru: "попытка", en: "attempt" })} {job.attempt.attempt}
										</p>
									</div>
									<span className="font-mono text-xs">{jobPercent(job)}%</span>
								</div>
								<progress
									value={jobPercent(job)}
									max={100}
									className="mt-2 h-2 w-full accent-[#5b6cff]"
									aria-label={`${copy(jobLabel(job))}: ${t({ ru: "ход выполнения", en: "progress" })}`}
								/>
								<p className="mt-1 text-xs text-[#48606d]">{copy(job.phase)}</p>
								{job.attempt.failure ? (
									<div className="mt-2 border-l-4 border-[#a63824] bg-[#f3d5c8] p-2 text-xs">
										<p className="font-bold">{t({ ru: "Не удалось обработать медиа", en: "Media processing failed" })}: {job.attempt.failure.code}</p>
										<p className="mt-1">{copy(job.attempt.failure.action)}</p>
									</div>
								) : null}
								<div className="mt-3 flex flex-wrap gap-2">
									{job.state === "running" && job.spec.kind !== "probe" ? (
										<button
											type="button"
											onClick={() => void pipeline.pause(job.spec.job_id)}
											className="border border-[#172128] px-2 py-1 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
										>
											{t({ ru: "Приостановить", en: "Pause" })}
										</button>
									) : null}
									{job.state === "paused" ? (
										<button
											type="button"
											onClick={() => void pipeline.resume(job.spec.job_id)}
											className="border border-[#172128] px-2 py-1 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
										>
											{t({ ru: "Продолжить", en: "Resume" })}
										</button>
									) : null}
									{["queued", "preparing", "running", "paused"].includes(
										job.state,
									) ? (
										<button
											type="button"
											onClick={() => void pipeline.cancel(job.spec.job_id)}
											className="border border-[#8c321f] px-2 py-1 text-xs font-bold text-[#702514] focus-visible:outline-3 focus-visible:outline-[#d26532]"
										>
											{t({ ru: "Отменить", en: "Cancel" })}
										</button>
									) : null}
									{job.state === "failed" && job.attempt.failure?.retryable ? (
										<button
											type="button"
											onClick={() => void pipeline.retry(job.spec.job_id)}
											className="border border-[#172128] bg-white px-2 py-1 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
										>
											{t({ ru: "Повторить", en: "Retry" })}
										</button>
									) : null}
								</div>
							</li>
						))}
					</ul>
					{pipelineState.jobs.length === 0 ? (
						<p className="p-5 text-sm text-[#48606d]">
							{t({
								ru: "Добавьте видео или аудио. Здесь появится ход подготовки файла к монтажу.",
								en: "Import media to create probe, proxy and waveform jobs.",
							})}
						</p>
					) : null}
				</aside>
			</div>
		</section>
	);
}
