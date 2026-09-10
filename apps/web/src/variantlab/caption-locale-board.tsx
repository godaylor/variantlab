"use client";

import { useUiCopy } from "./ui-copy";
import type {
	CaptionTrack,
	FontManifest,
	JobEvent,
	LocaleProfile,
	PersistedJob,
	StudioState,
	TextDiagnostic,
	TranscriptArtifact,
} from "@variantlab/studio-contract";
import { transcriptDiagnose, transcriptSegment } from "variantlab-wasm";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	cancelTranscription,
	transcribeFile,
} from "./caption-transcription-adapter";
import { applyJobEvent, buildJobSpec, createPersistedJob } from "./domain";
import { fileForPath } from "./media-store";
import type { PlaybackSemanticState } from "./playback-channel";
import { CaptionPlacementEditor } from "./caption-placement-editor";

type Props = {
	asset?: { assetHash: string; originalPath: string };
	state: StudioState;
	playbackState: PlaybackSemanticState;
	onCommand: (command: {
		payload: import("@variantlab/studio-contract").CommandPayload;
		sceneScope: import("@variantlab/studio-contract").SceneScope;
		variantScope: import("@variantlab/studio-contract").VariantScope;
	}) => Promise<void>;
	onNotice: (notice: string) => void;
};

const MODEL = {
	id: "Xenova/whisper-tiny",
	revision: "5332fcc35e32a33b86612b9a57a89be7906102b1",
	license: "Apache-2.0",
};
const USE_TEST_ADAPTER =
	process.env.NEXT_PUBLIC_VARIANTLAB_M5_TEST_ADAPTER === "1";
const FONT_MANIFEST: FontManifest = {
	version: 1,
	fonts: [
		{
			id: "inter-latin",
			family: "Inter",
			revision: "4.1",
			license: "OFL-1.1",
			unicode_ranges: [{ start: 0x20, end: 0x024f }],
		},
		{
			id: "noto-cyrillic-arabic",
			family: "Noto Sans",
			revision: "2.015",
			license: "OFL-1.1",
			unicode_ranges: [
				{ start: 0x0400, end: 0x052f },
				{ start: 0x0600, end: 0x06ff },
			],
		},
	],
};

function fixtureArtifact(assetHash = "a".repeat(64)): TranscriptArtifact {
	return {
		id: "transcript-master-m5",
		asset_hash: assetHash,
		locale: "en-US",
		words: [
			{
				id: "word-1",
				text: "Create",
				start_ticks: 0,
				end_ticks: 20_000,
				confidence_milli: 990,
			},
			{
				id: "word-2",
				text: "controlled",
				start_ticks: 20_000,
				end_ticks: 42_000,
				confidence_milli: 980,
			},
			{
				id: "word-3",
				text: "variants",
				start_ticks: 42_000,
				end_ticks: 68_000,
				confidence_milli: 970,
			},
			{
				id: "word-4",
				text: "for",
				start_ticks: 70_000,
				end_ticks: 82_000,
				confidence_milli: 990,
			},
			{
				id: "word-5",
				text: "every",
				start_ticks: 82_000,
				end_ticks: 104_000,
				confidence_milli: 960,
			},
			{
				id: "word-6",
				text: "market",
				start_ticks: 104_000,
				end_ticks: 132_000,
				confidence_milli: 950,
			},
		],
		model: MODEL,
		created_at: "2026-08-28T00:00:00.000Z",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isCaptionTrack(value: unknown): value is CaptionTrack {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.source_artifact_id === "string" &&
		(typeof value.locale_profile_id === "string" ||
			value.locale_profile_id === null) &&
		typeof value.version === "number" &&
		Array.isArray(value.cues)
	);
}

function isTextDiagnostic(value: unknown): value is TextDiagnostic {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.cue_id === "string" &&
		typeof value.kind === "string" &&
		typeof value.message === "string" &&
		typeof value.fix === "string"
	);
}

function segment(artifact: TranscriptArtifact): CaptionTrack {
	const parsed: unknown = JSON.parse(
		transcriptSegment(JSON.stringify(artifact), 3, BigInt(96_000)),
	);
	if (!isCaptionTrack(parsed))
		throw new Error("Rust transcript segment returned an invalid contract");
	return parsed;
}

function diagnose({
	track,
	profile,
}: {
	track: CaptionTrack | undefined;
	profile: LocaleProfile | undefined;
}): TextDiagnostic[] {
	if (!track || !profile) return [];
	const parsed: unknown = JSON.parse(
		transcriptDiagnose(
			JSON.stringify(track),
			JSON.stringify(profile),
			JSON.stringify(FONT_MANIFEST),
			360,
		),
	);
	if (!Array.isArray(parsed) || !parsed.every(isTextDiagnostic))
		throw new Error("Rust transcript diagnostics returned an invalid contract");
	return parsed;
}

function transition({
	job,
	event,
}: {
	job: PersistedJob;
	event: JobEvent;
}): PersistedJob {
	return applyJobEvent({ job, event, now: new Date().toISOString() });
}

export function CaptionLocaleBoard({
	state,
	asset,
	playbackState,
	onCommand,
	onNotice,
}: Props) {
	const copy = useUiCopy();

	const artifacts = state.campaign.transcript_artifacts ?? [];
	const track = (state.campaign.caption_tracks ?? [])[0];
	const profile = (state.campaign.locale_profiles ?? [])[0];
	const [job, setJob] = useState<PersistedJob | null>(null);
	const requestId = useRef(0);
	const cueRefs = useRef(new Map<string, HTMLInputElement>());
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const textDiagnostics = useMemo(
		() => diagnose({ track, profile }),
		[track, profile],
	);

	useEffect(() => {
		if (
			!USE_TEST_ADAPTER ||
			!job ||
			job.state !== "running" ||
			playbackState.isPlaying
		)
			return;
		const activeRequest = requestId.current;
		const timer = window.setTimeout(() => {
			if (activeRequest !== requestId.current) return;
			const completed = Math.min(100, job.completed_units + 25);
			if (completed < 100) {
				setJob(
					transition({
						job,
						event: {
							event: "progress",
							phase: "inference_chunk",
							completed_units: completed,
							total_units: 100,
						},
					}),
				);
				return;
			}
			setJob(
				transition({
					job,
					event: {
						event: "succeed",
						artifact_path: "opfs://variantlab/transcripts/master-m5.json",
					},
				}),
			);
			if (artifacts.length === 0) {
				const artifact = fixtureArtifact(asset?.assetHash);
				void onCommand({
					payload: {
						command: "attach_transcript",
						artifact,
						track: segment(artifact),
					},
					sceneScope: { kind: "sequence" },
					variantScope: { kind: "master" },
				}).then(() =>
					onNotice("Immutable transcript attached; captions are editable."),
				);
			}
		}, 120);
		return () => window.clearTimeout(timer);
	}, [artifacts.length, asset?.assetHash, job, onCommand, onNotice, playbackState.isPlaying]);

	async function runProduction({ activeRequest }: { activeRequest: number }) {
		if (!asset) return;
		try {
			const file = await fileForPath(asset.originalPath);
			const segments = await transcribeFile({
				file,
				modelRevision: MODEL.revision,
				onProgress: (progress) => {
					if (activeRequest !== requestId.current) return;
					setJob((current) => {
						if (!current || current.state !== "running") return current;
						const completed = Math.max(
							current.completed_units,
							Math.min(99, Math.round(progress.progress)),
						);
						return transition({
							job: current,
							event: {
								event: "progress",
								phase: progress.status.replaceAll("-", "_"),
								completed_units: completed,
								total_units: 100,
							},
						});
					});
				},
			});
			if (activeRequest !== requestId.current) return;
			const words = segments
				.filter((word) => word.text.trim() !== "")
				.map((word, index) => {
					const startTicks = Math.max(0, Math.round(word.start * 48_000));
					return {
						id: "word-" + (index + 1),
						text: word.text.trim(),
						start_ticks: startTicks,
						end_ticks: Math.max(startTicks + 1, Math.round(word.end * 48_000)),
						confidence_milli: 900,
					};
				});
			if (words.length === 0)
				throw new Error("The pinned model returned no timed words");
			const artifact: TranscriptArtifact = {
				id: "transcript-master-m5",
				asset_hash: asset.assetHash,
				locale: "en-US",
				words,
				model: MODEL,
				created_at: new Date().toISOString(),
			};
			if (artifacts.length === 0) {
				await onCommand({
					payload: {
						command: "attach_transcript",
						artifact,
						track: segment(artifact),
					},
					sceneScope: { kind: "sequence" },
					variantScope: { kind: "master" },
				});
			}
			if (activeRequest !== requestId.current) return;
			setJob((current) =>
				current && current.state === "running"
					? transition({
							job: current,
							event: {
								event: "succeed",
								artifact_path: "opfs://variantlab/transcripts/master-m5.json",
							},
						})
					: current,
			);
			onNotice("Immutable transcript attached; captions are editable.");
		} catch (error) {
			if (activeRequest !== requestId.current) return;
			setJob((current) =>
				current && ["preparing", "running"].includes(current.state)
					? transition({
							job: current,
							event: {
								event: "fail",
								failure: {
									code: "transcription_worker_error",
									message:
										error instanceof Error
											? error.message
											: "Local transcription failed",
									action:
										"Retry transcription; the immutable master is unchanged.",
									retryable: true,
								},
							},
						})
					: current,
			);
		}
	}
	function start() {
		if (!USE_TEST_ADAPTER && !asset) {
			onNotice("Import master media before local transcription.");
			return;
		}
		const activeRequest = requestId.current + 1;
		requestId.current = activeRequest;
		const spec = buildJobSpec({
			jobId: "transcription-master-m5-" + requestId.current,
			campaignId: state.campaign.id,
			assetHash: asset?.assetHash ?? "a".repeat(64),
			kind: "transcription",
			normalizedOptionsJson: JSON.stringify({ audio_chunks: 6, model: MODEL }),
			priority: 10,
			engineVersion: MODEL.revision,
		});
		let next = createPersistedJob({ spec, now: new Date().toISOString() });
		next = transition({ job: next, event: { event: "start_preparing" } });
		next = transition({ job: next, event: { event: "start_running" } });
		setJob(
			transition({
				job: next,
				event: {
					event: "progress",
					phase: "audio_chunk_1_of_6",
					completed_units: 1,
					total_units: 100,
				},
			}),
		);
		if (!USE_TEST_ADAPTER) void runProduction({ activeRequest });
	}

	function cancel() {
		if (
			!job ||
			!["queued", "preparing", "running", "paused"].includes(job.state)
		)
			return;
		requestId.current += 1;
		setJob(
			transition({
				job: transition({ job, event: { event: "request_cancel" } }),
				event: { event: "confirm_cancelled" },
			}),
		);
		if (!USE_TEST_ADAPTER) cancelTranscription();
	}

	function fail() {
		if (!job || !["preparing", "running"].includes(job.state)) return;
		requestId.current += 1;
		setJob(
			transition({
				job,
				event: {
					event: "fail",
					failure: {
						code: "transcription_worker_error",
						message: "The local inference worker stopped.",
						action: "Retry transcription; the immutable master is unchanged.",
						retryable: true,
					},
				},
			}),
		);
	}

	function retry() {
		if (!job || job.state !== "failed") return;
		const activeRequest = requestId.current + 1;
		requestId.current = activeRequest;
		let next = transition({ job, event: { event: "retry" } });
		next = transition({ job: next, event: { event: "start_preparing" } });
		setJob(transition({ job: next, event: { event: "start_running" } }));
		if (!USE_TEST_ADAPTER) void runProduction({ activeRequest });
	}

	async function createLocale() {
		const delivery = state.campaign.delivery_profiles[0];
		if (!delivery) {
			onNotice("Create the adaptive delivery profile before adding a locale.");
			return;
		}
		const locale: LocaleProfile = {
			id: "locale-ru-rtl",
			name: "Russian + RTL review",
			locale: "ru-RU",
			text_values: [
				{ slot_id: "headline", text: "Запуск для каждого рынка العربية" },
			],
			font_fallback_ids: ["inter-latin", "noto-cyrillic-arabic"],
			caption_style: {
				font_size_px: 48,
				max_lines: 2,
				max_chars_per_second: 18,
			},
			version: 1,
		};
		await onCommand({
			payload: {
				command: "create_locale_profile",
				profile: locale,
				delivery_profile_id: delivery.id,
				font_manifest: FONT_MANIFEST,
			},
			sceneScope: { kind: "sequence" },
			variantScope: { kind: "master" },
		});
	}

	async function saveCue({
		cueId,
		current,
	}: {
		cueId: string;
		current: string;
	}) {
		const text = (drafts[cueId] ?? current).trim();
		if (!track || text === current || text === "") return;
		await onCommand({
			payload: {
				command: "edit_caption",
				track_id: track.id,
				cue_id: cueId,
				text,
			},
			sceneScope: { kind: "sequence" },
			variantScope: { kind: "master" },
		});
	}

	const percent = job
		? Math.round((job.completed_units / Math.max(1, job.total_units)) * 100)
		: 0;
	const status = job
		? copy(job.state) +
			(playbackState.isPlaying && job.state === "running"
				? " · " + copy("yielding to playback")
				: "")
		: copy("Transcription ready");

	return (
		<section
			data-testid="caption-locale-board"
			className="mt-4 border-2 border-[#172128] bg-[#f6f7f4]"
			aria-labelledby="caption-heading"
		>
			<header className="grid gap-3 border-b-2 border-[#172128] bg-[#d7d0bc] p-4 md:grid-cols-[1fr_auto]">
				<div>
					<p className="font-mono text-[10px] font-bold uppercase">
						{copy("M5 · local captions")}
					</p>
					<h4 id="caption-heading" className="text-lg font-black">
						{copy("Caption + locale control")}
					</h4>
					<p className="mt-1 text-xs">
						{copy("Human-edited copy only · no automatic translation.")}
					</p>
				</div>
				<div className="flex flex-wrap items-start gap-2">
					<button
						type="button"
						onClick={start}
						disabled={!USE_TEST_ADAPTER && !asset}
						className="border-2 border-[#172128] bg-[#194f78] px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
					>
						{copy("Start local transcription")}
					</button>
					<button
						type="button"
						onClick={cancel}
						disabled={
							!job ||
							!["queued", "preparing", "running", "paused"].includes(job.state)
						}
						className="border-2 border-[#172128] px-3 py-2 text-xs font-bold disabled:opacity-40"
					>
						{copy("Cancel transcription")}
					</button>
					{USE_TEST_ADAPTER ? (
						<button
							type="button"
							onClick={fail}
							disabled={!job || !["preparing", "running"].includes(job.state)}
							className="border-2 border-[#172128] px-3 py-2 text-xs font-bold disabled:opacity-40"
						>
							{copy("Simulate worker error")}
						</button>
					) : null}
					<button
						type="button"
						onClick={retry}
						disabled={job?.state !== "failed"}
						className="border-2 border-[#172128] px-3 py-2 text-xs font-bold disabled:opacity-40"
					>
						{copy("Retry transcription")}
					</button>
				</div>
			</header>
			{track ? (
				<CaptionPlacementEditor
					key={track.id}
					state={state}
					track={track}
					onCommand={(payload) =>
						onCommand({
							payload,
							sceneScope: { kind: "sequence" },
							variantScope: { kind: "master" },
						})
					}
				/>
			) : null}
			<div className="grid md:grid-cols-[minmax(0,1fr)_280px]">
				<div className="p-4">
					<div
						role="status"
						aria-live="polite"
						aria-atomic="true"
						className="border-l-4 border-[#194f78] bg-white p-3 text-sm"
						data-testid="transcription-status"
					>
						{status}
					</div>
					<p
						aria-live="off"
						data-testid="transcription-progress"
						className="mt-2 text-xs"
					>
						{job ? job.phase + " · " + percent + "%" : "Not started"}
					</p>
					{job ? (
						<progress
							aria-label={copy("Transcription progress")}
							value={percent}
							max={100}
							className="mt-2 w-full"
						/>
					) : null}
					<p className="mt-2 font-mono text-[10px]">
						{copy("MODEL")} {MODEL.id}@{MODEL.revision} · {MODEL.license}{" "}
						{copy("· CHUNKED AUDIO")}
					</p>
					<div className="mt-4 space-y-3">
						{track?.cues.map((cue) => (
							<label key={cue.id} className="block">
								<span className="font-mono text-[10px]">
									{copy("CAPTION")} {cue.start_ticks}–{cue.end_ticks}{" "}
									{copy("TICKS ·")} {cue.word_ids.length} {copy("WORDS")}
								</span>
								<input
									ref={(node) => {
										if (node) cueRefs.current.set(cue.id, node);
									}}
									value={drafts[cue.id] ?? cue.text}
									onChange={(event) =>
										setDrafts((current) => ({
											...current,
											[cue.id]: event.target.value,
										}))
									}
									onBlur={() =>
										void saveCue({ cueId: cue.id, current: cue.text })
									}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											void saveCue({ cueId: cue.id, current: cue.text });
										}
									}}
									className="mt-1 w-full border-2 border-[#172128] bg-white px-3 py-2 focus-visible:outline-4 focus-visible:outline-[#d26532]"
									aria-label={"Edit caption " + cue.id}
									data-testid={"caption-" + cue.id}
								/>
							</label>
						))}
					</div>
					{artifacts.length > 0 && !profile ? (
						<button
							type="button"
							onClick={() => void createLocale()}
							className="mt-4 border-2 border-[#172128] bg-[#a94720] px-3 py-2 text-xs font-bold text-white"
						>
							{copy("Add RU + RTL locale profile")}
						</button>
					) : null}
					{profile ? (
						<p className="mt-4 text-xs" data-testid="locale-profile">
							{copy("Locale")} {profile.locale} {copy("· pinned fallback")}{" "}
							{profile.font_fallback_ids.join(" → ")}
						</p>
					) : null}
				</div>
				<aside
					className="border-t-2 border-[#172128] bg-white p-4 md:border-t-0 md:border-l-2"
					aria-labelledby="text-diagnostics-heading"
				>
					<h5 id="text-diagnostics-heading" className="font-black">
						{copy("Text diagnostics")}
					</h5>
					<p className="mt-1 text-xs">
						{copy("Safe area width 360 px. Each issue names a fix.")}
					</p>
					<ul className="mt-3 space-y-2" data-testid="text-diagnostics">
						{textDiagnostics.map((item) => (
							<li
								key={item.id}
								className="border-l-4 border-[#a63824] bg-[#f3d5c8] p-2"
							>
								<strong className="block text-xs">
									{copy(item.kind.replace("_", " "))}
								</strong>
								<span className="block text-xs">{copy(item.message)}</span>
								<span className="block text-xs font-bold">
									{copy("Fix:")} {copy(item.fix)}
								</span>
								<button
									type="button"
									onClick={() => cueRefs.current.get(item.cue_id)?.focus()}
									className="mt-2 underline focus-visible:outline-3 focus-visible:outline-[#d26532]"
								>
									{copy("Jump to exact caption")}
								</button>
							</li>
						))}
						{profile && textDiagnostics.length === 0 ? (
							<li className="text-xs">{copy("No text blockers.")}</li>
						) : null}
					</ul>
				</aside>
			</div>
		</section>
	);
}
