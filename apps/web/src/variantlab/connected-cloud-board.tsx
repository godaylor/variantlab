"use client";

/* eslint-disable variantlab/prefer-object-params, @typescript-eslint/no-unsafe-type-assertion -- typed parsing is confined to the same-origin BFF boundary. */
import type { RenderJobSpec, StudioState } from "@variantlab/studio-contract";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	buildRenderIdempotencyKey,
	buildVariantRenderManifest,
	checksumRenderManifest,
	snapshotHash,
} from "./domain";
import {
	fileForPath,
	listMediaAssets,
	type StoredMediaAsset,
} from "./media-store";
import { useVariantLabLocale } from "./locale";
import { ConnectedAccount } from "./connected-account";
import { renderRequiredAssets } from "variantlab-wasm";

type UploadSession = {
	upload_id: string;
	part_size_bytes: number;
	completed_parts: Array<{ part_number: number; byte_length: number }>;
};

type CloudJob = {
	id: string;
	cell_id: string;
	state: string;
	phase: string;
	progress_milli: number;
	attempt: number;
	failure: { message?: string; retryable?: boolean } | null;
	artifact_ready: boolean;
};

const apiBase = "/api/variantlab";
const jobStateCopy: Record<string, { ru: string; en: string }> = {
	queued: { ru: "В очереди", en: "queued" },
	preparing: { ru: "Подготовка", en: "preparing" },
	running: { ru: "Выполняется", en: "running" },
	pausing: { ru: "Приостановка", en: "pausing" },
	paused: { ru: "Приостановлено", en: "paused" },
	cancelling: { ru: "Отмена", en: "cancelling" },
	cancelled: { ru: "Отменено", en: "cancelled" },
	succeeded: { ru: "Завершено", en: "succeeded" },
	failed: { ru: "Ошибка", en: "failed" },
};

async function api(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	if (process.env.NEXT_PUBLIC_VARIANTLAB_M8_TEST_ADAPTER === "1")
		headers.set("x-variantlab-e2e", "1");
	const response = await fetch(`${apiBase}${path}`, { ...init, headers });
	const value: unknown = await response.json();
	if (!response.ok) {
		const message =
			typeof value === "object" && value && "error" in value
				? (value as { error?: { message?: string } }).error?.message
				: null;
		throw new Error(message ?? `Connected API returned ${response.status}`);
	}
	return value;
}

async function sha256(bytes: ArrayBuffer) {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function ConnectedCloudBoard({
	state,
	onNotice,
	sitesConnected = false,
}: {
	state: StudioState;
	onNotice: (notice: string) => void;
	sitesConnected?: boolean;
}) {
	const { t } = useVariantLabLocale();
	const cells = useMemo(
		() => state.campaign.variant_cells.slice(0, 50),
		[state],
	);
	const [selected, setSelected] = useState(
		() => new Set(cells.map((cell) => cell.id)),
	);
	const [assets, setAssets] = useState<StoredMediaAsset[]>([]);
	const [sourceHash, setSourceHash] = useState("");
	const [batchId, setBatchId] = useState(() =>
		typeof window === "undefined"
			? ""
			: (localStorage.getItem(`variantlab:m8:batch:${state.campaign.id}`) ??
				""),
	);
	const [jobs, setJobs] = useState<CloudJob[]>([]);
	const [serverBatches, setServerBatches] = useState<
		Array<{ id: string; campaign_id: string; revision: number }>
	>([]);
	async function loadServerBatches() {
		try {
			await api("/workspace");
			const value = (await api("/batches")) as {
				batches: Array<{ id: string; campaign_id: string; revision: number }>;
			};
			setServerBatches(value.batches);
			setError(null);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState(0);
	const [error, setError] = useState<string | null>(null);
	async function retryFailedBatch() {
		setBusy(true);
		try {
			await api(`/batches/${batchId}/retry-failed`, { method: "POST" });
			await refreshJobs();
			setError(null);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile ephemeral selection when canonical cells change.
		setSelected((current) => {
			const available = new Set(cells.map((cell) => cell.id));
			const next = new Set(
				[...current].filter((cellId) => available.has(cellId)),
			);
			for (const cell of cells) if (next.size < 50) next.add(cell.id);
			return next;
		});
	}, [cells]);

	useEffect(() => {
		void listMediaAssets(state.campaign.id).then((items) => {
			const compatible = items.filter(
				(asset) =>
					asset.detected_mime === "video/webm" ||
					asset.detected_mime === "audio/webm" ||
					asset.detected_mime === "image/png",
			);
			setAssets(compatible);
			setSourceHash(
				(current) =>
					current ||
					compatible.find((asset) => asset.detected_mime !== "image/png")
						?.asset_hash ||
					"",
			);
		});
	}, [state.campaign.id, state.campaign.revision]);

	const planIdentity = useMemo(
		() => ({ cells, selected, sourceHash, state }),
		[cells, selected, sourceHash, state],
	);
	const [plannedUpload, setPlannedUpload] = useState<{
		identity: typeof planIdentity | null;
		hashes: string[];
		blocked: boolean;
	}>({
		identity: null,
		hashes: [] as string[],
		blocked: true,
	});
	const uploadPlan =
		plannedUpload.identity === planIdentity
			? plannedUpload
			: { hashes: [], blocked: true };
	useEffect(() => {
		let cancelled = false;
		// The cloud flow requires an explicitly available source. Do not build
		// fifty full render manifests while merely reopening a local campaign.
		if (!sourceHash) return;
		async function plan() {
			try {
				const hashes = new Set<string>(sourceHash ? [sourceHash] : []);
				for (const cell of cells.filter((item) => selected.has(item.id))) {
					// Yield between bounded Rust calculations so input and paint can run.
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					if (cancelled) return;
					const value: unknown = JSON.parse(
						renderRequiredAssets(
							JSON.stringify(
								buildVariantRenderManifest({ state, cellId: cell.id }),
							),
						),
					);
					if (
						!Array.isArray(value) ||
						!value.every((hash: unknown) => typeof hash === "string")
					)
						throw new Error("required_assets_contract");
					for (const hash of value as string[]) hashes.add(hash);
				}
				if (!cancelled)
					setPlannedUpload({
						identity: planIdentity,
						hashes: [...hashes].sort(),
						blocked: false,
					});
			} catch {
				if (!cancelled)
					setPlannedUpload({
						identity: planIdentity,
						hashes: [],
						blocked: true,
					});
			}
		}
		void plan();
		return () => {
			cancelled = true;
		};
	}, [cells, selected, sourceHash, state, planIdentity]);
	const missingOriginals = uploadPlan.hashes.some(
		(hash) => !assets.some((asset) => asset.asset_hash === hash),
	);

	const refreshJobs = useCallback(async () => {
		if (!batchId) return;
		const value = (await api(`/batches/${batchId}/jobs`)) as {
			jobs: CloudJob[];
		};
		setJobs(value.jobs);
	}, [batchId]);

	useEffect(() => {
		if (!batchId) return;

		void refreshJobs().catch((reason) =>
			setError(reason instanceof Error ? reason.message : String(reason)),
		);
		const timer = window.setInterval(
			() =>
				void refreshJobs().catch((reason) =>
					setError(reason instanceof Error ? reason.message : String(reason)),
				),
			1000,
		);
		return () => window.clearInterval(timer);
	}, [batchId, refreshJobs]);

	async function ensureUploaded(asset: StoredMediaAsset) {
		await api("/workspace");
		const file = await fileForPath(asset.original_path);
		const session = (await api("/uploads", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				campaign_id: state.campaign.id,
				asset_hash: asset.asset_hash,
				content_type: asset.detected_mime,
				total_bytes: file.size,
			}),
		})) as UploadSession;
		const completed = new Set(
			session.completed_parts.map((part) => part.part_number),
		);
		const partCount = Math.ceil(file.size / session.part_size_bytes);
		for (let index = 0; index < partCount; index += 1) {
			const partNumber = index + 1;
			if (!completed.has(partNumber)) {
				const bytes = await file
					.slice(
						index * session.part_size_bytes,
						Math.min(file.size, (index + 1) * session.part_size_bytes),
					)
					.arrayBuffer();
				await api(`/uploads/${session.upload_id}/parts/${partNumber}`, {
					method: "PUT",
					headers: {
						"content-type": "application/octet-stream",
						"x-content-sha256": await sha256(bytes),
					},
					body: bytes,
				});
			}
			setProgress(Math.round((partNumber / partCount) * 100));
		}
		await api(`/uploads/${session.upload_id}/complete`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
	}

	async function startBatch() {
		const asset = assets.find((item) => item.asset_hash === sourceHash);
		if (!asset) return;
		setBusy(true);
		setError(null);
		setProgress(0);
		try {
			if (uploadPlan.blocked || missingOriginals)
				throw new Error("render_inputs_incomplete");
			for (const hash of uploadPlan.hashes) {
				const original = assets.find((item) => item.asset_hash === hash);
				if (!original) throw new Error("render_original_missing");
				await ensureUploaded(original);
			}
			const chosen = cells.filter((cell) => selected.has(cell.id));
			const jobsPayload = chosen.map((cell) => {
				const manifest = buildVariantRenderManifest({ state, cellId: cell.id });
				const manifestHash = checksumRenderManifest(manifest);
				const filename = `variant-${cell.id}.webm`;
				const idempotencyKey = buildRenderIdempotencyKey({
					manifestSha256: manifestHash,
					optionsJson: JSON.stringify({
						preset: "vp9-opus-webm",
						filename,
						destination: "download",
					}),
				});
				const spec: RenderJobSpec = {
					schema_version: 1,
					job_id: `cloud-${idempotencyKey.slice(0, 12)}-${cell.id}`,
					campaign_id: state.campaign.id,
					master_sequence_id: state.campaign.master_sequence.id,
					cell_id: cell.id,
					campaign_revision: state.campaign.revision,
					render_manifest_sha256: manifestHash,
					preset: "vp9-opus-webm",
					filename,
					destination: "download",
					idempotency_key: idempotencyKey,
					engine_version: manifest.engine_version,
				};
				return { spec, render_manifest: manifest };
			});
			const created = (await api("/batches", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					campaign_id: state.campaign.id,
					campaign_revision: state.campaign.revision,
					snapshot_sha256: snapshotHash(state),
					snapshot: state,
					source_asset_sha256: asset.asset_hash,
					jobs: jobsPayload,
				}),
			})) as { batch_id: string };
			setBatchId(created.batch_id);
			localStorage.setItem(
				`variantlab:m8:batch:${state.campaign.id}`,
				created.batch_id,
			);
			onNotice(
				t({
					ru: "Облачный пакет принят и продолжит работу после закрытия браузера.",
					en: "Cloud batch accepted and will continue after the browser closes.",
				}),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}

	async function mutateJob(jobId: string, action: "cancel" | "retry") {
		setError(null);
		try {
			await api(`/jobs/${jobId}/${action}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			await refreshJobs();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}

	async function download(jobId: string) {
		setError(null);
		try {
			const value = (await api(`/jobs/${jobId}/artifact`)) as { url: string };
			window.location.assign(value.url);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}

	return (
		<section
			id={sitesConnected ? undefined : "connected-workspace"}
			className="mt-6 border-2 border-[#172128] bg-[#f6f7f4]"
			aria-labelledby="cloud-batch-title"
		>
			<div className="border-b-2 border-[#172128] bg-[#c9d9df] p-5">
				<p className="font-mono text-[11px] font-bold uppercase">
					M8 / {t({ ru: "подключённый рендер", en: "connected rendering" })}
				</p>
				<h2 id="cloud-batch-title" className="mt-1 text-xl font-black">
					{t({ ru: "Облачный пакет VariantLab", en: "VariantLab cloud batch" })}
				</h2>
				<p className="mt-2 text-sm text-[#48606d]">
					{t({
						ru: "До 50 ячеек. Загрузка возобновляется, а задания продолжаются после закрытия браузера.",
						en: "Up to 50 cells. Uploads resume and jobs continue after the browser closes.",
					})}
				</p>
			</div>
			{!sitesConnected && <ConnectedAccount />}
			<div className="border-b border-[#172128] p-5">
				<button
					type="button"
					onClick={() => void loadServerBatches()}
					className="border-2 border-[#172128] px-3 py-2 font-bold"
				>
					{t({ ru: "Открыть серверные пакеты", en: "Open server batches" })}
				</button>
				<label className="ml-3" htmlFor="cloud-server-batch">
					{t({ ru: "Сохранённый серверный пакет", en: "Saved server batch" })}
				</label>
				<select
					id="cloud-server-batch"
					value={
						serverBatches.some((batch) => batch.id === batchId) ? batchId : ""
					}
					className="ml-2 border border-[#172128] bg-white p-2"
					onChange={(event) => {
						setJobs([]);
						setBatchId(event.target.value);
					}}
				>
					<option value="">
						{t({ ru: "Выберите пакет", en: "Choose batch" })}
					</option>
					{serverBatches.map((batch) => (
						<option key={batch.id} value={batch.id}>
							{batch.campaign_id} · r{batch.revision} · {batch.id}
						</option>
					))}
				</select>
				<p className="mt-2 text-xs">
					{t({
						ru: "Последние 50 пакетов аккаунта. Это результаты рендера, не синхронизация локального проекта.",
						en: "Last 50 account batches. These are render results, not local project synchronization.",
					})}
				</p>
			</div>
			<div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
				<div>
					<label
						htmlFor="cloud-source"
						className="font-mono text-xs font-bold uppercase"
					>
						{t({ ru: "Исходный WebM", en: "Source WebM" })}
					</label>
					<select
						id="cloud-source"
						value={sourceHash}
						onChange={(event) => setSourceHash(event.target.value)}
						className="mt-2 w-full border-2 border-[#172128] bg-white p-2"
					>
						<option value="">
							{t({
								ru: "Выберите импортированный WebM",
								en: "Choose an imported WebM",
							})}
						</option>
						{assets
							.filter((asset) => asset.detected_mime !== "image/png")
							.map((asset) => (
								<option
									key={asset.asset_id}
									value={asset.asset_hash}
									translate="no"
								>
									{asset.name}
								</option>
							))}
					</select>
					<fieldset className="mt-4 max-h-48 overflow-auto border border-[#172128] p-3">
						<legend className="px-1 font-mono text-xs font-bold uppercase">
							{t({
								ru: `Ячейки (${selected.size}/50)`,
								en: `Cells (${selected.size}/50)`,
							})}
						</legend>
						{cells.map((cell) => (
							<label key={cell.id} className="flex gap-2 py-1 text-sm">
								<input
									type="checkbox"
									checked={selected.has(cell.id)}
									onChange={() =>
										setSelected((current) => {
											const next = new Set(current);
											if (next.has(cell.id)) next.delete(cell.id);
											else if (next.size < 50) next.add(cell.id);
											return next;
										})
									}
								/>
								<span>{cell.id}</span>
							</label>
						))}
					</fieldset>
					<div
						className="mt-3 text-sm"
						aria-label={t({
							ru: "Файлы для явной загрузки",
							en: "Files for explicit upload",
						})}
					>
						<p>
							{t({
								ru: "При запуске перечисленные файлы будут загружены в локальное хранилище VariantLab (MinIO).",
								en: "Starting uploads the listed files to local VariantLab storage (MinIO).",
							})}
						</p>
						<ul>
							{uploadPlan.hashes.map((hash) => {
								const asset = assets.find((item) => item.asset_hash === hash);
								return (
									<li key={hash}>
										<span translate="no">{asset?.name ?? hash}</span>
										{asset
											? ` · ${asset.byte_length} B`
											: t({
													ru: " — исходник отсутствует",
													en: " — original missing",
												})}
									</li>
								);
							})}
						</ul>
						{uploadPlan.blocked ? (
							<p role="status">
								{t({
									ru: "Проверьте явные привязки слотов и размещение текста/субтитров перед экспортом.",
									en: "Check explicit slot bindings and text/caption placement before exporting.",
								})}
							</p>
						) : null}
					</div>
					<button
						type="button"
						disabled={
							busy ||
							!sourceHash ||
							selected.size === 0 ||
							uploadPlan.blocked ||
							missingOriginals
						}
						onClick={() => void startBatch()}
						className="mt-4 border-2 border-[#172128] bg-[#194f78] px-4 py-3 font-bold text-white disabled:opacity-40"
					>
						{busy
							? t({ ru: `Загрузка ${progress}%`, en: `Uploading ${progress}%` })
							: t({ ru: "Запустить облачный пакет", en: "Start cloud batch" })}
					</button>
					{error ? (
						<p
							role="alert"
							className="mt-3 border-l-4 border-[#a63824] bg-[#f3d5c8] p-3 text-sm"
						>
							{t({
								ru: "Операция не завершена. Проверьте вход, подключение и наличие исходников; затем повторите. Локальные данные сохранены.",
								en: "The operation did not complete. Check sign-in, connection and required originals, then retry. Local data is preserved.",
							})}
						</p>
					) : null}
				</div>
				<div>
					<h3 className="font-mono text-xs font-bold uppercase">
						{t({ ru: "Серверный прогресс", en: "Server progress" })}
					</h3>
					{batchId && (
						<button
							type="button"
							disabled={busy}
							onClick={() => void retryFailedBatch()}
							className="my-2 border-2 border-[#172128] bg-white px-3 py-2 text-sm font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
						>
							{t({ ru: "Повторить только ошибки", en: "Retry failed only" })}
						</button>
					)}
					{jobs.length === 0 ? (
						<p className="mt-3 text-sm text-[#48606d]">
							{t({
								ru: "Пакет ещё не запущен.",
								en: "No batch has been started.",
							})}
						</p>
					) : (
						<ul className="mt-2 space-y-2">
							{jobs.map((job) => (
								<li
									key={job.id}
									className="border border-[#172128] bg-white p-3"
								>
									<div className="flex justify-between gap-3">
										<span className="font-bold">{job.cell_id}</span>
										<span className="font-mono text-xs uppercase">
											{t(
												jobStateCopy[job.state] ?? {
													ru: "Неизвестное состояние",
													en: "Unknown state",
												},
											)}{" "}
											· {Math.round(job.progress_milli / 10)}%
										</span>
									</div>
									<div className="mt-2 flex gap-2">
										{["queued", "preparing", "running", "paused"].includes(
											job.state,
										) ? (
											<button
												type="button"
												onClick={() => void mutateJob(job.id, "cancel")}
												className="border border-[#172128] px-2 py-1 text-xs font-bold"
											>
												{t({ ru: "Отменить", en: "Cancel" })}
											</button>
										) : null}
										{job.state === "failed" && job.failure?.retryable ? (
											<button
												type="button"
												onClick={() => void mutateJob(job.id, "retry")}
												className="border border-[#172128] px-2 py-1 text-xs font-bold"
											>
												{t({ ru: "Повторить", en: "Retry" })}
											</button>
										) : null}
										{job.artifact_ready ? (
											<button
												type="button"
												onClick={() => void download(job.id)}
												className="border border-[#172128] px-2 py-1 text-xs font-bold"
											>
												{t({ ru: "Скачать", en: "Download" })}
											</button>
										) : null}
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</section>
	);
}
