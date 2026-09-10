"use client";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- bounded filename preview scroll region is keyboard reachable. */

import type {
	DeliverableArtifact,
	DeliverableManifest,
	DestinationKind,
	PersistedRenderJob,
	RenderJobSpec,
	RenderManifest,
	RenderPhase,
	StudioState,
} from "@variantlab/studio-contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	bundleImportFailurePointFromValue,
	exportEditableCampaignBundle,
	importEditableCampaignBundle,
} from "./campaign-bundle";
import {
	applyRenderJobEvent,
	buildDeliverableArtifact,
	buildRenderIdempotencyKey,
	buildVariantRenderManifest,
	checksumRenderManifest,
	createLocalRenderBatch,
	normalizeDeliverableManifest,
	preflightLocalRender,
	previewRenderFilename,
	snapshotHash,
	uniqueRenderFilenames,
} from "./domain";
import type { ExportWorkerResponse } from "./export-worker";
import { useVariantLabLocale } from "./locale";
import {
	isCurrentRenderPreflight,
	renderFailureAction,
	renderJobControls,
	renderPreflightToken,
	selectExactBatchArtifacts,
	renderJobPhaseLabel,
	updateLocalCellSelection,
} from "./render-package-ui";
import {
	copyArtifactToDirectory,
	downloadArtifact,
	listRenderArtifacts,
	listRenderJobs,
	saveRenderArtifact,
	saveRenderJob,
	storageCapacity,
	succeededRenderKeys,
	type StoredRenderArtifact,
} from "./render-store";

const TEST_ADAPTER = process.env.NEXT_PUBLIC_VARIANTLAB_M7_TEST_ADAPTER === "1";
const RENDER_PRESET = "webm_vp9_opus";

function destinationFromValue(value: string): DestinationKind {
	if (value === "browser_download" || value === "user_granted_directory") {
		return value;
	}
	throw new Error("Unsupported render destination");
}
type FailurePhase =
	| "preparing"
	| "rendering"
	| "corrupt_source"
	| "out_of_space";
type JobRecord = { job: PersistedRenderJob; manifest: RenderManifest };
type ActiveWorker = { worker: Worker; jobId: string };

const PHASE_BY_MESSAGE: Record<
	Extract<ExportWorkerResponse, { type: "progress" }>["phase"],
	RenderPhase
> = {
	preparing: "preparing",
	rendering: "rendering",
	muxing: "muxing",
	verifying: "verifying",
	persisting: "persisting",
};

type VisibleRenderUpdate = {
	attemptKey: string;
	atMs: number;
	kind: "progress" | "terminal";
};

function recordVisibleRenderUpdate({
	job,
	kind,
}: {
	job: PersistedRenderJob;
	kind: VisibleRenderUpdate["kind"];
}): void {
	if (!TEST_ADAPTER) return;
	const metrics = window as Window & {
		__m7VisibleProgressEvents?: VisibleRenderUpdate[];
	};
	(metrics.__m7VisibleProgressEvents ??= []).push({
		attemptKey: `${job.spec.job_id}:${job.attempt.attempt}`,
		atMs: Date.now(),
		kind,
	});
}

function downloadJson({
	filename,
	value,
}: {
	filename: string;
	value: unknown;
}): void {
	const url = URL.createObjectURL(
		new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
	);
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
	} finally {
		queueMicrotask(() => URL.revokeObjectURL(url));
	}
}

export function RenderPackageBoard({
	state,
	onNotice,
	onImported,
	onSceneInclusion,
}: {
	state: StudioState;
	onNotice: (message: string) => void;
	onImported: (campaignId: string) => Promise<void>;
	onSceneInclusion: (input: {
		sceneId: string;
		included: boolean;
	}) => Promise<void>;
}) {
	const { t } = useVariantLabLocale();
	const [selectedCellIds, setSelectedCellIds] = useState<string[]>(() =>
		state.campaign.variant_cells.slice(0, 8).map((cell) => cell.id),
	);
	const [template, setTemplate] = useState(
		"{campaign}_{creative_set}_{profile}",
	);
	const [destination, setDestination] =
		useState<DestinationKind>("browser_download");
	const [directoryName, setDirectoryName] = useState<string | null>(null);
	const [preflight, setPreflight] = useState<{
		ready: boolean;
		blockers: string[];
		availableBytes: number;
		requestToken: string;
	} | null>(null);
	const [records, setRecords] = useState<JobRecord[]>([]);
	const [artifacts, setArtifacts] = useState<StoredRenderArtifact[]>([]);
	const [liveStatus, setLiveStatus] = useState("Local render queue is idle.");
	const [forceUnsupported, setForceUnsupported] = useState(false);
	const activeWorkerRef = useRef<ActiveWorker | null>(null);
	const directoryRef = useRef<FileSystemDirectoryHandle | null>(null);
	const runningRef = useRef(false);
	const recordsRef = useRef<JobRecord[]>([]);
	const campaignRevisionRef = useRef(state.campaign.revision);
	const nextFailureRef = useRef<FailurePhase | undefined>(undefined);
	const nextBundleFailureRef = useRef<
		import("./campaign-bundle").BundleImportFailurePoint | undefined
	>(undefined);

	const cells = state.campaign.variant_cells;
	const selectedCells = useMemo(
		() => cells.filter((cell) => selectedCellIds.includes(cell.id)),
		[cells, selectedCellIds],
	);
	const filenamePreview = useMemo(() => {
		try {
			const names = selectedCells.map((cell) => {
				const creative = (state.campaign.creative_sets ?? []).find(
					(item) => item.id === cell.creative_set_id,
				);
				const profile = state.campaign.delivery_profiles.find(
					(item) => item.id === cell.delivery_profile_id,
				);
				return `${previewRenderFilename({
					template,
					context: {
						campaign: state.campaign.name,
						creative_set: creative?.name ?? cell.creative_set_id,
						profile: profile?.name ?? cell.delivery_profile_id,
						cell: cell.id,
					},
				})}.webm`;
			});
			return { names: uniqueRenderFilenames(names), error: null };
		} catch (error) {
			return {
				names: [] as string[],
				error:
					error instanceof Error ? error.message : "Invalid naming template",
			};
		}
	}, [
		selectedCells,
		state.campaign.creative_sets,
		state.campaign.delivery_profiles,
		state.campaign.name,
		template,
	]);

	const preparedRender = useMemo(() => {
		if (filenamePreview.error || selectedCells.length === 0) return null;
		const items = selectedCells.map((cell, index) => {
			const manifest = buildVariantRenderManifest({ state, cellId: cell.id });
			const manifestSha256 = checksumRenderManifest(manifest);
			const filename = filenamePreview.names[index];
			if (!filename) throw new Error("Render filename is missing");
			const optionsJson = JSON.stringify({
				preset: RENDER_PRESET,
				filename,
				destination,
			});
			const idempotencyKey = buildRenderIdempotencyKey({
				manifestSha256,
				optionsJson,
			});
			return {
				cell,
				manifest,
				requiredBytes: Math.ceil(
					(manifest.sequence_duration_ticks / 48_000) *
						((2_000_000 + 96_000) / 8) *
						1.2,
				),
				spec: {
					schema_version: 1,
					job_id: `render-${idempotencyKey.slice(0, 12)}-${cell.id}`,
					campaign_id: state.campaign.id,
					master_sequence_id: state.campaign.master_sequence.id,
					cell_id: cell.id,
					campaign_revision: state.campaign.revision,
					render_manifest_sha256: manifestSha256,
					preset: RENDER_PRESET,
					filename,
					destination,
					idempotency_key: idempotencyKey,
					engine_version: manifest.engine_version,
				} satisfies RenderJobSpec,
			};
		});
		const requiredBytes = items.reduce(
			(total, item) => total + item.requiredBytes,
			0,
		);
		const requests = items.map(({ spec }) => ({
			cellId: spec.cell_id,
			campaignRevision: spec.campaign_revision,
			preset: spec.preset,
			manifestSha256: spec.render_manifest_sha256,
			idempotencyKey: spec.idempotency_key,
			filename: spec.filename,
			destination: spec.destination,
		}));
		return {
			items,
			requests,
			requiredBytes,
			token: renderPreflightToken({ requests, requiredBytes }),
		};
	}, [destination, filenamePreview, selectedCells, state]);

	const preflightReady = Boolean(
		preflight?.ready &&
		preparedRender &&
		isCurrentRenderPreflight({
			preparedToken: preflight.requestToken,
			currentToken: preparedRender.token,
		}),
	);

	const replaceRecord = useCallback((record: JobRecord) => {
		recordsRef.current = recordsRef.current
			.filter((item) => item.job.spec.job_id !== record.job.spec.job_id)
			.concat(record)
			.toSorted((left, right) =>
				left.job.spec.job_id.localeCompare(right.job.spec.job_id),
			);
		setRecords(recordsRef.current);
	}, []);

	const executeRecord = useCallback(
		async (initial: JobRecord, failAt?: FailurePhase): Promise<void> => {
			let current: JobRecord = {
				...initial,
				job: applyRenderJobEvent({
					job: initial.job,
					event: { event: "start" },
					now: new Date().toISOString(),
				}),
			};
			await saveRenderJob(current);
			replaceRecord(current);
			recordVisibleRenderUpdate({ job: current.job, kind: "progress" });
			const worker = new Worker(
				new URL("./export-worker.ts", import.meta.url),
				{
					type: "module",
					name: `variantlab-export-${current.job.spec.job_id}`,
				},
			);
			activeWorkerRef.current = { worker, jobId: current.job.spec.job_id };
			const artifactPath = `renders/${current.job.spec.idempotency_key}.webm`;
			await new Promise<void>((resolve) => {
				let chain = Promise.resolve();
				let finished = false;
				const finish = () => {
					if (finished) return;
					finished = true;
					worker.terminate();
					if (activeWorkerRef.current?.worker === worker)
						activeWorkerRef.current = null;
					resolve();
				};
				const failWorker = (message: string) => {
					chain = chain.then(async () => {
						if (current.job.state === "cancelling") return;
						current = {
							...current,
							job: applyRenderJobEvent({
								job: current.job,
								event: {
									event: "fail",
									failure: {
										code: "worker_terminated",
										message,
										action: "Retry failed render",
										retryable: true,
									},
								},
								now: new Date().toISOString(),
							}),
						};
						await saveRenderJob(current);
						replaceRecord(current);
						recordVisibleRenderUpdate({ job: current.job, kind: "terminal" });
						setLiveStatus(
							`${current.job.spec.filename} failed. Retry is available.`,
						);
					});
					void chain.finally(finish);
				};
				worker.addEventListener(
					"error",
					(event) => failWorker(event.message || "Export worker terminated"),
					{ once: true },
				);
				worker.addEventListener(
					"message",
					(event: MessageEvent<ExportWorkerResponse>) => {
						chain = chain.then(async () => {
							const response = event.data;
							if (response.type === "progress") {
								if (TEST_ADAPTER && typeof response.emittedAtMs === "number") {
									const metrics = window as Window & {
										__m7ProgressStalenessMs?: number[];
									};
									(metrics.__m7ProgressStalenessMs ??= []).push(
										Math.max(
											0,
											performance.timeOrigin +
												performance.now() -
												response.emittedAtMs,
										),
									);
								}
								if (current.job.state === "cancelling") return;
								current = {
									...current,
									job: applyRenderJobEvent({
										job: current.job,
										event: {
											event: "progress",
											phase: PHASE_BY_MESSAGE[response.phase],
											progress_milli: response.progressMilli,
										},
										now: new Date().toISOString(),
									}),
								};
								await saveRenderJob(current);
								replaceRecord(current);
								recordVisibleRenderUpdate({
									job: current.job,
									kind: "progress",
								});
								setLiveStatus(
									`${current.job.spec.filename}: ${response.phase} ${Math.round(response.progressMilli / 10)}%.`,
								);
								return;
							}
							if (response.type === "cancelled") {
								if (current.job.state !== "cancelling") {
									current = {
										...current,
										job: applyRenderJobEvent({
											job: current.job,
											event: { event: "cancel" },
											now: new Date().toISOString(),
										}),
									};
								}
								current = {
									...current,
									job: applyRenderJobEvent({
										job: current.job,
										event: { event: "confirm_cancelled" },
										now: new Date().toISOString(),
									}),
								};
								await saveRenderJob(current);
								replaceRecord(current);
								recordVisibleRenderUpdate({
									job: current.job,
									kind: "terminal",
								});
								setLiveStatus(
									`${current.job.spec.filename} cancelled; no partial artifact committed.`,
								);
								finish();
								return;
							}
							if (response.type === "failed") {
								current = {
									...current,
									job: applyRenderJobEvent({
										job: current.job,
										event: {
											event: "fail",
											failure: {
												code: response.code,
												message: response.message,
												action: renderFailureAction(response.code),
												retryable: response.retryable,
											},
										},
										now: new Date().toISOString(),
									}),
								};
								await saveRenderJob(current);
								replaceRecord(current);
								recordVisibleRenderUpdate({
									job: current.job,
									kind: "terminal",
								});
								setLiveStatus(
									`${current.job.spec.filename} failed: ${response.message}`,
								);
								finish();
								return;
							}
							const artifact = buildDeliverableArtifact({
								manifest: current.manifest,
								cellId: current.job.spec.cell_id,
								preset: current.job.spec.preset,
								filename: current.job.spec.filename,
								byteLength: response.byteLength,
								sha256: response.sha256,
							});
							current = {
								...current,
								job: applyRenderJobEvent({
									job: current.job,
									event: {
										event: "succeed",
										artifact_path: response.artifactPath,
									},
									now: new Date().toISOString(),
								}),
							};
							await Promise.all([
								saveRenderJob(current),
								saveRenderArtifact({
									...artifact,
									id: current.job.spec.job_id,
									campaign_id: current.job.spec.campaign_id,
									artifact_path: response.artifactPath,
									idempotency_key: current.job.spec.idempotency_key,
									master_sequence_id: current.job.spec.master_sequence_id,
									destination: current.job.spec.destination,
									created_at: new Date().toISOString(),
								}),
							]);
							replaceRecord(current);
							recordVisibleRenderUpdate({ job: current.job, kind: "terminal" });
							setArtifacts(
								await listRenderArtifacts(current.job.spec.campaign_id),
							);
							if (
								destination === "user_granted_directory" &&
								directoryRef.current
							) {
								try {
									await copyArtifactToDirectory({
										artifactPath: response.artifactPath,
										filename: current.job.spec.filename,
										directory: directoryRef.current,
									});
								} catch {
									setDestination("browser_download");
									directoryRef.current = null;
									setDirectoryName(null);
									onNotice(
										"Directory permission was denied; completed artifacts remain available as browser downloads.",
									);
								}
							}
							setLiveStatus(
								`${current.job.spec.filename} succeeded and checksum verification passed.`,
							);
							finish();
						});
					},
				);
				worker.postMessage({
					type: "run",
					job: current.job,
					manifest: current.manifest,
					artifactPath,
					failAt,
				});
			});
		},
		[destination, onNotice, replaceRecord],
	);

	const executeQueue = useCallback(
		async (queue: JobRecord[]) => {
			if (runningRef.current) return;
			runningRef.current = true;
			try {
				for (const queuedRecord of queue) {
					const record =
						recordsRef.current.find(
							(item) => item.job.spec.job_id === queuedRecord.job.spec.job_id,
						) ?? queuedRecord;
					if (record.job.state !== "queued") continue;
					const failAt = nextFailureRef.current;
					nextFailureRef.current = undefined;
					await executeRecord(record, failAt);
				}
			} finally {
				runningRef.current = false;
			}
		},
		[executeRecord],
	);

	const executeQueueRef = useRef(executeQueue);
	useEffect(() => {
		executeQueueRef.current = executeQueue;
	}, [executeQueue]);

	useEffect(() => {
		const revision = state.campaign.revision;
		campaignRevisionRef.current = revision;
		void Promise.all(
			recordsRef.current.map(async (record) => {
				if (record.job.spec.campaign_revision === revision || record.job.stale)
					return;
				const next = {
					...record,
					job: applyRenderJobEvent({
						job: record.job,
						event: { event: "mark_stale" },
						now: new Date().toISOString(),
					}),
				};
				replaceRecord(next);
				await saveRenderJob(next);
			}),
		);
	}, [replaceRecord, state.campaign.revision]);

	useEffect(() => {
		let cancelled = false;
		void Promise.all([
			listRenderJobs(state.campaign.id),
			listRenderArtifacts(state.campaign.id),
		]).then(async ([stored, storedArtifacts]) => {
			if (cancelled) return;
			const recovered: JobRecord[] = [];
			for (const record of stored) {
				let job = record.job;
				if (["preparing", "running", "cancelling"].includes(job.state)) {
					job = applyRenderJobEvent({
						job,
						event: { event: "recover_after_reload" },
						now: new Date().toISOString(),
					});
					await saveRenderJob({ job, manifest: record.manifest });
				}
				if (
					job.spec.campaign_revision !== campaignRevisionRef.current &&
					!job.stale
				) {
					job = applyRenderJobEvent({
						job,
						event: { event: "mark_stale" },
						now: new Date().toISOString(),
					});
					await saveRenderJob({ job, manifest: record.manifest });
				}
				recovered.push({ job, manifest: record.manifest });
			}
			recordsRef.current = recovered;
			setRecords(recovered);
			setArtifacts(storedArtifacts);
			if (recovered.some(({ job }) => job.state === "queued")) {
				setLiveStatus(
					"Recovered local jobs are queued; the browser was not reported as continuing while closed.",
				);
				void executeQueueRef.current(recovered);
			}
		});
		return () => {
			cancelled = true;
			activeWorkerRef.current?.worker.terminate();
			activeWorkerRef.current = null;
		};
	}, [state.campaign.id]);

	async function chooseDirectory() {
		try {
			const picker = (
				window as Window & {
					showDirectoryPicker?: (options: {
						mode: "readwrite";
					}) => Promise<FileSystemDirectoryHandle>;
				}
			).showDirectoryPicker;
			if (typeof picker !== "function")
				throw new DOMException(
					"Directory picker unavailable",
					"NotSupportedError",
				);
			const handle = await picker({ mode: "readwrite" });
			directoryRef.current = handle;
			setDirectoryName(handle.name);
			onNotice(`Directory destination granted: ${handle.name}.`);
		} catch {
			directoryRef.current = null;
			setDirectoryName(null);
			setDestination("browser_download");
			onNotice(
				"Directory permission unavailable; destination fell back to browser download.",
			);
		}
	}

	async function runPreflight() {
		if (!preparedRender) return;
		const renderBlockers = preparedRender.items.flatMap(({ manifest }) => [
			...(manifest.blockers ?? []),
		]);
		if (renderBlockers.length) {
			setPreflight({
				ready: false,
				blockers: renderBlockers,
				availableBytes: 0,
				requestToken: preparedRender.token,
			});
			setLiveStatus(renderBlockers.join(", "));
			return;
		}
		const { getFirstEncodableAudioCodec, getFirstEncodableVideoCodec } =
			await import("mediabunny");
		const [codecResults, storage] = await Promise.all([
			Promise.all(
				preparedRender.items.map(async ({ manifest }) => {
					const [video, audio] = await Promise.all([
						getFirstEncodableVideoCodec(["vp9", "vp8"], {
							width: manifest.canvas.width,
							height: manifest.canvas.height,
							bitrate: 2_000_000,
						}),
						getFirstEncodableAudioCodec(["opus"], {
							numberOfChannels: 1,
							sampleRate: 48_000,
							bitrate: 96_000,
						}),
					]);
					return { video: Boolean(video), audio: Boolean(audio) };
				}),
			),
			storageCapacity(preparedRender.requiredBytes),
		]);
		const result = preflightLocalRender({
			codec: {
				schema_version: 1,
				provider: "browser_web_codecs",
				preset: RENDER_PRESET,
				video_supported:
					!forceUnsupported && codecResults.every((result) => result.video),
				audio_supported:
					!forceUnsupported && codecResults.every((result) => result.audio),
				streaming_sink_supported: typeof WritableStream === "function",
			},
			storage: {
				available_bytes: storage.availableBytes,
				required_bytes: storage.requiredBytes,
				opfs_supported: storage.opfsSupported,
			},
		});
		setPreflight({
			ready: result.ready,
			blockers: result.blockers,
			availableBytes: storage.availableBytes,
			requestToken: preparedRender.token,
		});
		setLiveStatus(
			result.ready
				? `Preflight ready for ${preparedRender.items.length} frozen manifest(s): VP9/Opus, OPFS streaming, and quota passed.`
				: `Preflight blocked: ${result.blockers.join(", ")}.`,
		);
	}

	async function enqueueSelected() {
		if (!preparedRender || filenamePreview.error) return;
		if (
			!preflight?.ready ||
			!isCurrentRenderPreflight({
				preparedToken: preflight.requestToken,
				currentToken: preparedRender.token,
			})
		) {
			setLiveStatus(
				"Preflight is stale for the current revision, cells, scenes, preset, naming, or destination. Run preflight again.",
			);
			return;
		}
		if (destination === "user_granted_directory" && !directoryRef.current) {
			await chooseDirectory();
			if (!directoryRef.current) return;
		}
		const succeeded = await succeededRenderKeys(state.campaign.id);
		const manifestByCell = new Map(
			preparedRender.items.map(({ cell, manifest }) => [cell.id, manifest]),
		);
		const batch = createLocalRenderBatch({
			specs: preparedRender.items.map(({ spec }) => spec),
			succeededKeys: succeeded,
			now: new Date().toISOString(),
		});
		const queued = batch.jobs.map((job) => ({
			job,
			manifest: manifestByCell.get(job.spec.cell_id)!,
		}));
		await Promise.all(queued.map(saveRenderJob));
		for (const record of queued) replaceRecord(record);
		setLiveStatus(
			batch.skipped_succeeded_idempotency_keys.length > 0
				? `Skipped ${batch.skipped_succeeded_idempotency_keys.length} already verified artifact(s).`
				: `Queued ${queued.length} local render job(s), concurrency 1.`,
		);
		void executeQueue(queued);
	}
	async function cancelJob(record: JobRecord) {
		let job = applyRenderJobEvent({
			job: record.job,
			event: { event: "cancel" },
			now: new Date().toISOString(),
		});
		if (activeWorkerRef.current?.jobId === job.spec.job_id) {
			activeWorkerRef.current.worker.postMessage({
				type: "cancel",
				jobId: job.spec.job_id,
			});
		} else {
			job = applyRenderJobEvent({
				job,
				event: { event: "confirm_cancelled" },
				now: new Date().toISOString(),
			});
		}
		const next = { ...record, job };
		await saveRenderJob(next);
		replaceRecord(next);
	}

	async function retryJob(record: JobRecord) {
		const next = {
			...record,
			job: applyRenderJobEvent({
				job: record.job,
				event: { event: "retry" },
				now: new Date().toISOString(),
			}),
		};
		await saveRenderJob(next);
		replaceRecord(next);
		void executeQueue([next]);
	}

	function packageManifest(): DeliverableManifest | null {
		if (!preparedRender) return null;
		const engine = preparedRender.items[0]?.manifest.engine_version;
		if (
			!engine ||
			preparedRender.items.some(
				(item) => item.manifest.engine_version !== engine,
			)
		)
			return null;
		const selected = selectExactBatchArtifacts({
			artifacts,
			requests: preparedRender.requests,
		});
		const first = selected?.[0];
		if (!selected || !first) return null;
		if (
			selected.some(
				(artifact) =>
					artifact.master_sequence_id !== first.master_sequence_id ||
					artifact.destination !== first.destination,
			)
		) {
			return null;
		}
		return normalizeDeliverableManifest({
			schema_version: 1,
			campaign_id: first.campaign_id,
			campaign_revision: first.campaign_revision,
			master_sequence_id: first.master_sequence_id,
			preset: first.preset,
			destination: destinationFromValue(first.destination),
			artifacts: selected.map(
				({
					id: _id,
					campaign_id: _campaign,
					artifact_path: _path,
					idempotency_key: _key,
					master_sequence_id: _sequence,
					destination: _destination,
					created_at: _created,
					...artifact
				}) => artifact satisfies DeliverableArtifact,
			),
			provenance: {
				engine,
				codec_provider: "browser_webcodecs_mediabunny-1.41.0",
				license_notice:
					"OpenCut attribution preserved; see LICENSE and THIRD_PARTY_NOTICES.md",
			},
		});
	}
	async function exportBundle() {
		const result = await exportEditableCampaignBundle(state);
		if (destination === "user_granted_directory" && directoryRef.current) {
			await copyArtifactToDirectory({
				artifactPath: result.artifactPath,
				filename: result.filename,
				directory: directoryRef.current,
			});
		} else {
			await downloadArtifact({
				artifactPath: result.artifactPath,
				filename: result.filename,
			});
		}
		setLiveStatus(
			`Editable bundle written as a stream (${result.byteLength} bytes).`,
		);
	}

	return (
		<section
			className="mt-6 border-2 border-[#172128] bg-[#f6f7f4]"
			aria-labelledby="render-package-heading"
			data-snapshot-hash={snapshotHash(state)}
		>
			<div className="grid gap-3 border-b-2 border-[#172128] bg-[#172128] p-4 text-white lg:grid-cols-[1fr_auto] lg:items-end">
				<div>
					<p className="font-mono text-[10px] tracking-[0.18em] text-[#aac0ca] uppercase">
						{t({
							ru: "Локальный экспорт / зафиксированная версия",
							en: "Local delivery / frozen revision",
						})}
					</p>
					<h3 id="render-package-heading" className="mt-1 text-xl font-black">
						{t({ ru: "Пакет экспорта", en: "Render package" })}
					</h3>
				</div>
				<p
					className="font-mono text-xs"
					data-testid="m7-live-status"
					role="status"
					aria-live="polite"
				>
					{liveStatus}
				</p>
			</div>
			<div className="grid gap-5 p-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(280px,.75fr)]">
				<div>
					<fieldset>
						<legend className="font-mono text-xs font-bold uppercase">
							{t({ ru: "Варианты для экспорта", en: "Deliverable cells" })} ·{" "}
							{selectedCellIds.length}/8
						</legend>
						<div
							className="mt-2 grid max-h-44 gap-2 overflow-auto border-y border-[#a9b1ad] py-2 sm:grid-cols-2"
							data-testid="m7-cell-picker"
						>
							{cells.map((cell) => (
								<label
									key={cell.id}
									className="flex items-center gap-2 border border-[#a9b1ad] bg-white px-3 py-2 text-xs"
								>
									<input
										type="checkbox"
										checked={selectedCellIds.includes(cell.id)}
										disabled={
											!selectedCellIds.includes(cell.id) &&
											selectedCellIds.length >= 8
										}
										onChange={(event) =>
											setSelectedCellIds((current) =>
												updateLocalCellSelection({
													current,
													cellId: cell.id,
													checked: event.target.checked,
												}),
											)
										}
									/>
									<span className="font-mono">{cell.id}</span>
								</label>
							))}
							{cells.length === 0 ? (
								<p className="text-sm text-[#48606d]">
									{t({
										ru: "Перед экспортом включите хотя бы одну ячейку матрицы.",
										en: "Enable at least one explicit matrix cell before export.",
									})}
								</p>
							) : null}
						</div>
					</fieldset>
					<fieldset className="mt-4">
						<legend className="font-mono text-xs font-bold uppercase">
							{t({
								ru: "Порядок и включение сцен",
								en: "Canonical scene order / inclusion",
							})}
						</legend>
						<div
							className="mt-2 flex flex-wrap gap-2"
							data-testid="m7-scene-inclusion"
						>
							{state.campaign.master_sequence.scenes.map((scene, index) => {
								const included =
									state.campaign.scene_inclusions?.find(
										(entry) => entry.scene_id === scene.id,
									)?.included ?? true;
								return (
									<label
										key={scene.id}
										className="flex items-center gap-2 border border-[#172128] bg-white px-3 py-2 text-xs"
									>
										<input
											type="checkbox"
											checked={included}
											onChange={(event) =>
												void onSceneInclusion({
													sceneId: scene.id,
													included: event.target.checked,
												})
											}
										/>
										<span className="font-mono">
											{String(index + 1).padStart(2, "0")}
										</span>
										<span>{scene.name}</span>
									</label>
								);
							})}
						</div>
					</fieldset>
					<label
						className="mt-4 block font-mono text-xs font-bold uppercase"
						htmlFor="m7-name-template"
					>
						{t({ ru: "Шаблон имени файла", en: "Filename template" })}
					</label>
					<input
						id="m7-name-template"
						value={template}
						onChange={(event) => {
							setTemplate(event.target.value);
							setPreflight(null);
						}}
						className="mt-2 w-full border-2 border-[#172128] bg-white px-3 py-2 font-mono text-sm focus-visible:outline-4 focus-visible:outline-[#d26532]"
					/>
					{filenamePreview.error ? (
						<p role="alert" className="mt-2 text-sm font-bold text-[#8c321f]">
							{filenamePreview.error}
						</p>
					) : (
						<ol
							tabIndex={0}
							className="mt-2 max-h-24 overflow-auto font-mono text-[11px] text-[#48606d]"
							aria-label={t({
								ru: "Предпросмотр имён файлов",
								en: "Generated filename preview",
							})}
							data-testid="m7-filename-preview"
						>
							{filenamePreview.names.map((name) => (
								<li key={name}>{name}</li>
							))}
						</ol>
					)}
					<div className="mt-4 grid gap-3 sm:grid-cols-2">
						<label className="font-mono text-xs font-bold uppercase">
							{t({ ru: "Куда сохранить", en: "Destination" })}
							<select
								value={destination}
								onChange={(event) => {
									setDestination(destinationFromValue(event.target.value));
									setPreflight(null);
								}}
								className="mt-2 block w-full border-2 border-[#172128] bg-white px-3 py-2 normal-case"
							>
								<option value="browser_download">
									{t({ ru: "Скачать в браузере", en: "Browser download" })}
								</option>
								<option value="user_granted_directory">
									{t({ ru: "Выбранная папка", en: "User-granted directory" })}
								</option>
							</select>
						</label>
						<div>
							<p className="font-mono text-xs font-bold uppercase">
								{t({ ru: "Доступ к папке", en: "Directory grant" })}
							</p>
							<button
								type="button"
								disabled={destination !== "user_granted_directory"}
								onClick={() => void chooseDirectory()}
								className="mt-2 w-full border-2 border-[#172128] px-3 py-2 text-sm font-bold disabled:opacity-40 focus-visible:outline-4 focus-visible:outline-[#d26532]"
							>
								{directoryName ??
									t({ ru: "Выбрать папку", en: "Choose directory" })}
							</button>
						</div>
					</div>
					<div className="mt-4 flex flex-wrap gap-2">
						<button
							type="button"
							disabled={
								selectedCells.length === 0 || Boolean(filenamePreview.error)
							}
							onClick={() => void runPreflight()}
							className="border-2 border-[#172128] bg-[#b9d1dc] px-4 py-2 text-sm font-bold disabled:opacity-40 focus-visible:outline-4 focus-visible:outline-[#d26532]"
						>
							{t({ ru: "Проверить перед экспортом", en: "Run preflight" })}
						</button>
						<button
							type="button"
							disabled={!preflightReady || selectedCells.length === 0}
							onClick={() => void enqueueSelected()}
							className="border-2 border-[#172128] bg-[#194f78] px-4 py-2 text-sm font-bold text-white disabled:opacity-40 focus-visible:outline-4 focus-visible:outline-[#d26532]"
						>
							{t({
								ru: "Запустить локальный экспорт",
								en: "Enqueue local batch",
							})}
						</button>
					</div>
					{preflight ? (
						<div
							className={`mt-3 border-l-4 p-3 text-sm ${preflightReady ? "border-[#2d725d] bg-[#d9ebe3]" : "border-[#a63824] bg-[#f3d5c8]"}`}
							data-testid="m7-preflight"
						>
							<strong>{preflightReady ? "READY" : "BLOCKED"}</strong> ·{" "}
							{preflightReady
								? "codec, streaming sink and storage passed"
								: preflight.ready
									? "stale request — run preflight again"
									: preflight.blockers
											.map((code) => `${code}: ${renderFailureAction(code)}`)
											.join(", ")}{" "}
							· {Math.round(preflight.availableBytes / 1024 / 1024)} MiB
							available
						</div>
					) : null}
					{TEST_ADAPTER ? (
						<div
							className="mt-3 flex flex-wrap gap-2 border border-dashed border-[#8c321f] p-2"
							aria-label="M7 failure injection"
						>
							<button
								type="button"
								onClick={() => (nextFailureRef.current = "preparing")}
							>
								Crash next worker
							</button>
							<button
								type="button"
								onClick={() => (nextFailureRef.current = "out_of_space")}
							>
								Exhaust next storage
							</button>
							<button
								type="button"
								onClick={() => (nextFailureRef.current = "corrupt_source")}
							>
								Corrupt next source
							</button>
							<button
								type="button"
								onClick={() => {
									setForceUnsupported((current) => !current);
									setPreflight(null);
								}}
							>
								{forceUnsupported ? "Restore codec" : "Disable codec"}
							</button>
							<select
								aria-label="Bundle import failure"
								defaultValue=""
								onChange={(event) => {
									nextBundleFailureRef.current =
										bundleImportFailurePointFromValue(event.target.value);
								}}
							>
								<option value="">No bundle failure</option>
								<option value="after_existing_original_commit">
									After existing original commit
								</option>
								<option value="after_first_original_commit">
									After original commit
								</option>
								<option value="after_provenance">After provenance</option>
								<option value="after_probe">After probe</option>
								<option value="after_first_media_commit">
									After media IDB
								</option>
								<option value="after_campaign_commit">
									After campaign IDB
								</option>
							</select>
						</div>
					) : null}
				</div>
				<div>
					<h4 className="font-mono text-xs font-bold uppercase">Job Center</h4>
					<ul
						className="mt-2 max-h-80 space-y-2 overflow-auto"
						data-testid="m7-job-center"
					>
						{records.map((record) => (
							<li
								key={record.job.spec.job_id}
								className="border border-[#172128] bg-white p-3"
							>
								<div className="flex items-start justify-between gap-2">
									<div>
										<p className="break-all font-mono text-[11px] font-bold">
											{record.job.spec.filename}
										</p>
										<p className="mt-1 text-xs">
											{renderJobPhaseLabel(record.job)}
										</p>
										{record.job.attempt.failure ? (
											<p className="mt-1 text-xs font-semibold">
												{record.job.attempt.failure.action}
											</p>
										) : null}
									</div>
									<span className="font-mono text-xs">
										{Math.round(record.job.progress_milli / 10)}%
									</span>
								</div>
								<progress
									className="mt-2 w-full"
									max={1000}
									value={record.job.progress_milli}
									aria-label={`${record.job.spec.filename} progress`}
								/>
								<div className="mt-2 flex gap-2">
									{renderJobControls(record.job).canCancel ? (
										<button
											type="button"
											onClick={() => void cancelJob(record)}
											className="border border-[#172128] px-2 py-1 text-xs font-bold"
										>
											{t({ ru: "Отменить", en: "Cancel" })}
										</button>
									) : null}
									{renderJobControls(record.job).canRetryFailed ? (
										<button
											type="button"
											onClick={() => void retryJob(record)}
											className="border border-[#172128] px-2 py-1 text-xs font-bold"
										>
											{t({
												ru: "Повторить неудачный экспорт",
												en: "Retry failed",
											})}
										</button>
									) : null}
								</div>
							</li>
						))}
						{records.length === 0 ? (
							<li className="border border-dashed border-[#a9b1ad] p-3 text-sm text-[#48606d]">
								{t({
									ru: "Локальный экспорт ещё не запускался.",
									en: "No local render attempts yet.",
								})}
							</li>
						) : null}
					</ul>
				</div>
			</div>
			<div className="grid gap-3 border-t-2 border-[#172128] bg-[#d9ddd9] p-4 lg:grid-cols-[1fr_auto_auto] lg:items-center">
				<p className="text-xs text-[#48606d]">
					{t({
						ru: "Экспорт выполняется отдельно от предпросмотра и сохраняется частями. Закрытие вкладки останавливает локальную работу; после открытия можно повторить попытку.",
						en: "Exports use an isolated worker/WASM surface and OPFS chunk sink. Closing the tab pauses local work; reopening creates a new resumable attempt.",
					})}
				</p>
				<button
					type="button"
					disabled={packageManifest() === null}
					onClick={() => {
						const manifest = packageManifest();
						if (manifest)
							downloadJson({
								filename: `${state.campaign.name}-deliverables.json`,
								value: manifest,
							});
					}}
					className="border-2 border-[#172128] bg-white px-3 py-2 text-sm font-bold disabled:opacity-40"
				>
					{t({ ru: "Скачать манифест", en: "Download manifest" })}
				</button>
				<button
					type="button"
					onClick={() => void exportBundle()}
					className="border-2 border-[#172128] bg-white px-3 py-2 text-sm font-bold"
				>
					{t({
						ru: "Экспорт редактируемого проекта",
						en: "Export editable bundle",
					})}
				</button>
			</div>
			{artifacts.length > 0 ? (
				<ul
					className="grid gap-2 border-t border-[#a9b1ad] p-4 sm:grid-cols-2"
					data-testid="m7-artifacts"
				>
					{artifacts.map((artifact) => (
						<li
							key={artifact.id}
							className="flex items-center justify-between gap-3 bg-white p-3"
						>
							<div>
								<p className="font-mono text-[11px] font-bold">
									{artifact.filename}
								</p>
								<p className="text-xs text-[#48606d]">
									{artifact.timing.frame_count} frames ·{" "}
									{artifact.sha256.slice(0, 12)}…
								</p>
							</div>
							<button
								type="button"
								onClick={() =>
									void downloadArtifact({
										artifactPath: artifact.artifact_path,
										filename: artifact.filename,
									})
								}
								className="border border-[#172128] px-2 py-1 text-xs font-bold"
							>
								{t({ ru: "Скачать", en: "Download" })}
							</button>
						</li>
					))}
				</ul>
			) : null}
			<label className="block border-t-2 border-[#172128] p-4 font-mono text-xs font-bold uppercase">
				{t({
					ru: "Импорт редактируемого проекта",
					en: "Import editable bundle",
				})}
				<input
					type="file"
					accept=".vlcampaign,application/octet-stream"
					className="mt-2 block w-full font-sans font-normal normal-case"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (!file) return;
						const failurePoint = nextBundleFailureRef.current;
						nextBundleFailureRef.current = undefined;
						void importEditableCampaignBundle({
							file,
							newCampaignId: crypto.randomUUID(),
							failurePoint,
						})
							.then(async (imported) => {
								const message =
									"Editable bundle validated and atomically imported into a new campaign.";
								await onImported(imported.campaign.id);
								onNotice(message);
							})
							.catch((error: unknown) =>
								setLiveStatus(
									`Bundle import rolled back atomically: ${error instanceof Error ? error.message : "invalid bundle"}`,
								),
							);
					}}
				/>
			</label>
		</section>
	);
}
