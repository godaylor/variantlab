"use client";

import type {
	CommandPayload,
	PreparedCommit,
	Scene,
	SceneScope,
	StudioState,
	VariantScope,
} from "@variantlab/studio-contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	buildCommandEnvelope,
	createCampaign,
	createStressTimeline,
	defaultTimeline,
	prepareCommand,
} from "./domain";
import { importLegacyProject, listLegacyProjects } from "./legacy-import";
import {
	createStoredCampaign,
	injectNextWriteFailure,
	listCampaigns,
	recoverCampaign,
	savePreparedCommit,
	type CampaignSummary,
	type DurableReceipt,
} from "./local-store";
import { RoughCutWorkspace } from "./rough-cut-workspace";
import { RenderPackageBoard } from "./render-package-board";
import { ConnectedCloudBoard } from "./connected-cloud-board";
import { ConnectedSyncBoard } from "./connected-sync-board";
import { useVariantLabLocale, type VariantLabLocale } from "./locale";

type SaveState = "idle" | "saving" | "saved" | "error";

function newScene({ name, now }: { name: string; now: string }): Scene {
	return {
		id: crypto.randomUUID(),
		name,
		created_at: now,
		updated_at: now,
		timeline: null,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown local storage error";
}

function deviceId(): string {
	const key = "variantlab:device-id";
	const existing = localStorage.getItem(key);
	if (existing) return existing;
	const value = crypto.randomUUID();
	localStorage.setItem(key, value);
	return value;
}

// eslint-disable-next-line variantlab/prefer-object-params -- compact internal formatter, not a public API.
function statusLabel(saveState: SaveState, locale: VariantLabLocale): string {
	if (saveState === "saving")
		return locale === "ru" ? "Сохраняется локально" : "Saving locally";
	if (saveState === "saved")
		return locale === "ru" ? "Сохранено локально" : "Saved locally";
	if (saveState === "error")
		return locale === "ru" ? "Ошибка сохранения" : "Save failed";
	return locale === "ru" ? "Нет несохранённых изменений" : "No unsaved changes";
}

export function VariantLabStudio({ browserLocal = false }: { browserLocal?: boolean }) {
	const { locale, hydrated, t } = useVariantLabLocale();
	const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
	const [legacyProjects, setLegacyProjects] = useState<
		Awaited<ReturnType<typeof listLegacyProjects>>
	>([]);
	const [state, setState] = useState<StudioState | null>(null);
	const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
	const [draftName, setDraftName] = useState("");
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const [notice, setNotice] = useState("");
	const visibleNotice =
		notice ||
		t({
			ru: "Создайте кампанию или импортируйте проект исходного редактора.",
			en: "Create a campaign or import a source-project.",
		});
	const [saveError, setSaveError] = useState<string | null>(null);
	const [lastReceipt, setLastReceipt] = useState<DurableReceipt | null>(null);
	const [isDirty, setIsDirty] = useState(false);
	const [campaignName, setCampaignName] = useState("");
	const [creating, setCreating] = useState(false);
	const [initializing, setInitializing] = useState(true);
	const creationRef = useRef(false);
	const pendingCommitRef = useRef<PreparedCommit | null>(null);

	const refreshLists = useCallback(async () => {
		const [stored, legacy] = await Promise.all([
			listCampaigns(),
			listLegacyProjects(),
		]);
		setCampaigns(stored);
		setLegacyProjects(legacy);
		return stored;
	}, []);

	const openCampaign = useCallback(async (campaignId: string) => {
		const recovered = await recoverCampaign(campaignId);
		const firstScene = recovered.state.campaign.master_sequence.scenes[0];
		setState(recovered.state);
		setActiveSceneId(firstScene?.id ?? null);
		setDraftName(firstScene?.name ?? "");
		setSaveState("saved");
		setSaveError(null);
		pendingCommitRef.current = null;
		localStorage.setItem("variantlab:last-campaign", campaignId);
		setNotice(
			recovered.fallbackUsed
				? "Recovered from the last checksum-valid snapshot."
				: "Recovered revision " +
						recovered.state.campaign.revision +
						"; replayed " +
						recovered.replayedEntries +
						" journal entries.",
		);
	}, []);

	useEffect(() => {
		let cancelled = false;
		const initialize = async () => {
			try {
				const stored = await refreshLists();
				if (cancelled) return;
				const remembered = localStorage.getItem("variantlab:last-campaign");
				const campaignId =
					stored.find((campaign) => campaign.id === remembered)?.id ??
					stored[0]?.id;
				if (campaignId) await openCampaign(campaignId);
			} catch (error: unknown) {
				if (!cancelled) setNotice(errorMessage(error));
			} finally {
				if (!cancelled) setInitializing(false);
			}
		};
		queueMicrotask(() => void initialize());
		return () => {
			cancelled = true;
		};
	}, [openCampaign, refreshLists]);

	const persistCommit = useCallback(
		async (commit: PreparedCommit) => {
			pendingCommitRef.current = commit;
			setIsDirty(true);
			setSaveState("saving");
			setSaveError(null);
			try {
				const receipt = await savePreparedCommit(commit);
				pendingCommitRef.current = null;
				setIsDirty(false);
				setState(commit.next_state);
				setLastReceipt(receipt);
				setSaveState("saved");
				const committedSceneId =
					commit.envelope.scene_scope.kind === "scene"
						? commit.envelope.scene_scope.scene_id
						: null;
				if (committedSceneId !== null)
					setDraftName(
						commit.next_state.campaign.master_sequence.scenes.find(
							(scene) => scene.id === committedSceneId,
						)?.name ?? "",
					);
				setNotice(
					"Revision " +
						receipt.revision +
						" received a durable journal receipt in " +
						receipt.durationMs.toFixed(1) +
						" ms.",
				);
				await refreshLists();
			} catch (error: unknown) {
				setSaveState("error");
				setSaveError(errorMessage(error));
				setNotice(
					"The campaign is still dirty. Retry keeps the same idempotent transaction.",
				);
			}
		},
		[refreshLists],
	);

	useEffect(() => {
		const protectUnload = (event: BeforeUnloadEvent) => {
			if (pendingCommitRef.current) event.preventDefault();
		};
		const persistOnPageHide = () => {
			const pending = pendingCommitRef.current;
			if (pending) void persistCommit(pending);
		};
		window.addEventListener("beforeunload", protectUnload);
		window.addEventListener("pagehide", persistOnPageHide);
		return () => {
			window.removeEventListener("beforeunload", protectUnload);
			window.removeEventListener("pagehide", persistOnPageHide);
		};
	}, [persistCommit]);

	const runCommand = useCallback(
		async (
			payload: CommandPayload,
			scope?: { sceneScope: SceneScope; variantScope: VariantScope },
		) => {
			if (!state || pendingCommitRef.current) return;
			const sceneScope =
				scope?.sceneScope ??
				(activeSceneId
					? { kind: "scene" as const, scene_id: activeSceneId }
					: null);
			if (!sceneScope) return;
			const variantScope = scope?.variantScope ?? ({ kind: "master" } as const);
			const now = new Date().toISOString();
			const envelope = buildCommandEnvelope({
				state,
				sceneScope,
				variantScope,
				payload,
				now,
				commandId: crypto.randomUUID(),
				transactionId: crypto.randomUUID(),
				deviceId: deviceId(),
			});
			const result = prepareCommand({ state, envelope });
			if (result.status === "no_op") {
				setNotice(
					payload.command === "undo"
						? "Nothing changed in the recorded command scope."
						: result.reason,
				);
				return;
			}
			await persistCommit(result.commit);
		},
		[activeSceneId, persistCommit, state],
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				!(event.ctrlKey || event.metaKey) ||
				event.key.toLowerCase() !== "z"
			) {
				return;
			}
			const target = event.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement
			) {
				return;
			}
			event.preventDefault();
			void runCommand({ command: event.shiftKey ? "redo" : "undo" });
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [runCommand]);

	async function createNewCampaign() {
		if (creationRef.current || pendingCommitRef.current || initializing) return;
		creationRef.current = true;
		setCreating(true);
		try {
			const now = new Date().toISOString();
			const query = new URLSearchParams(window.location.search);
			const m7Reference =
				process.env.NEXT_PUBLIC_VARIANTLAB_M7_TEST_ADAPTER === "1" &&
				query.has("m7_reference");
			const scenes: Scene[] = [
				{
					...newScene({ name: "Scene A", now }),
					timeline:
						process.env.NEXT_PUBLIC_VARIANTLAB_M6_TEST_ADAPTER === "1" &&
						query.has("m6_reference")
							? createStressTimeline({
									duration_ticks: 2 * 60 * 60 * 48_000,
									track_count: 20,
									clip_count: 5_000,
									fps_num: 30_000,
									fps_den: 1_001,
								})
							: null,
				},
				newScene({ name: "Scene B", now }),
			];
			if (m7Reference) scenes.push(newScene({ name: "Scene C", now }));
			const created = createCampaign({
				campaign_id: crypto.randomUUID(),
				campaign_name: campaignName.trim() || "Launch campaign",
				master_sequence_id: crypto.randomUUID(),
				created_at: now,
				scenes,
				imported_from: null,
			});
			await createStoredCampaign({ state: created });
			await refreshLists();
			await openCampaign(created.campaign.id);
			setCampaignName("");
		} catch (error: unknown) {
			setNotice(errorMessage(error));
		} finally {
			creationRef.current = false;
			setCreating(false);
		}
	}

	async function importProject(projectId: string) {
		const imported = await importLegacyProject(projectId);
		await refreshLists();
		await openCampaign(imported.campaign.id);
	}

	function selectScene(scene: Scene) {
		setActiveSceneId(scene.id);
		setDraftName(scene.name);
		setNotice(
			"Active scope: " + scene.name + ". Selection and draft were revalidated.",
		);
	}

	const activeScene =
		state?.campaign.master_sequence.scenes.find(
			(scene) => scene.id === activeSceneId,
		) ?? null;
	const activeTimeline = useMemo(
		() => activeScene?.timeline ?? defaultTimeline(),
		[activeScene?.timeline],
	);
	return (
		<main className="variant-studio min-h-screen bg-[#e7e9e6] text-[#172128]">
			<header className="border-b-2 border-[#172128] bg-[#f6f7f4] px-5 py-4 lg:px-8">
				<div className="mx-auto flex max-w-[1500px] items-end justify-between gap-6">
					<div>
						<p className="font-mono text-[11px] tracking-[0.22em] text-[#48606d] uppercase">
							{t({
								ru: "Один монтаж · несколько рекламных версий",
								en: "One edit · multiple ad versions",
							})}
						</p>
						<h1 className="mt-1 text-3xl font-black tracking-[-0.055em] lg:text-5xl">
							VariantLab
						</h1>
					</div>
					<div
						className="border-l-4 border-[#d26532] pl-3 text-right font-mono text-xs"
						role="status"
						aria-live="polite"
						data-testid="save-status"
					>
						<p className="font-bold">{statusLabel(saveState, locale)}</p>
						<p>
							{t({ ru: "ревизия", en: "revision" })}{" "}
							{state?.campaign.revision ?? "—"}
						</p>
					</div>
				</div>
			</header>
			{browserLocal ? <p data-testid="browser-local-mode" className="mx-auto max-w-[1500px] border-b border-[#a9b1ad] bg-[#f6f7f4] px-5 py-3 text-sm">{t({ ru: "Локальный режим: монтаж и экспорт без аккаунта. Данные сохраняются только в этом браузере; облачный сервер ещё не подключён.", en: "Local mode: edit and export without an account. Data is saved only in this browser; a cloud server is not connected yet." })}</p> : null}

			<div className="mx-auto grid max-w-[1500px] grid-cols-1 lg:grid-cols-[270px_minmax(0,1fr)]">
				<aside className="border-b-2 border-[#172128] bg-[#d9ddd9] p-5 lg:min-h-[calc(100vh-91px)] lg:border-r-2 lg:border-b-0">
					<label
						htmlFor="campaign-name"
						className="mb-2 block text-sm font-bold"
					>
						{t({ ru: "Название новой кампании", en: "New campaign name" })}
					</label>
					<input
						id="campaign-name"
						value={campaignName}
						onChange={(event) => setCampaignName(event.target.value)}
						maxLength={120}
						placeholder={t({
							ru: "Например, осенняя коллекция",
							en: "For example, autumn collection",
						})}
						className="mb-3 w-full border border-[#48606d] bg-white px-3 py-2 text-sm focus-visible:outline-3 focus-visible:outline-[#194f78]"
					/>
					<button
						type="button"
						onClick={() => void createNewCampaign()}
						disabled={!hydrated || initializing || creating || isDirty}
						className="w-full border-2 border-[#172128] bg-[#194f78] px-4 py-3 text-left text-sm font-bold text-white shadow-[3px_3px_0_#172128] focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#d26532]"
					>
						{creating
							? t({ ru: "Создание…", en: "Creating…" })
							: t({ ru: "+ Новая кампания", en: "+ New campaign" })}
					</button>

					<h2 className="mt-8 border-b border-[#172128] pb-2 font-mono text-xs font-bold uppercase">
						{t({ ru: "Кампании", en: "Campaigns" })}
					</h2>
					<ul className="mt-2 space-y-1">
						{!initializing && campaigns.length === 0 ? (
							<li className="py-2 text-sm text-[#48606d]">
								{t({
									ru: "Ваши кампании появятся здесь. Изменения сохраняются автоматически на этом устройстве.",
									en: "Your campaigns will appear here. Changes save automatically on this device.",
								})}
							</li>
						) : null}
						{campaigns.map((campaign) => (
							<li key={campaign.id}>
								<button
									type="button"
									onClick={() => void openCampaign(campaign.id)}
									disabled={isDirty || creating}
									className="w-full border border-transparent px-2 py-2 text-left hover:border-[#172128] focus-visible:outline-3 focus-visible:outline-[#d26532]"
									aria-current={state?.campaign.id === campaign.id}
								>
									<span className="block text-sm font-bold">
										{campaign.name}
									</span>
									<span className="font-mono text-[10px] text-[#48606d]">
										REV {campaign.latest_revision}
									</span>
								</button>
							</li>
						))}
					</ul>

					<h2 className="mt-8 border-b border-[#172128] pb-2 font-mono text-xs font-bold uppercase">
						{t({
							ru: "Импорт исходных проектов",
							en: "Source-project imports",
						})}
					</h2>
					{legacyProjects.length === 0 ? (
						<p className="mt-3 text-xs leading-5 text-[#48606d]">
							{t({
								ru: "Старые проекты не найдены. Исходное пространство данных не изменяется.",
								en: "No legacy projects found. The source namespace remains untouched.",
							})}
						</p>
					) : (
						<ul className="mt-2 space-y-2">
							{legacyProjects.map((project) => (
								<li key={project.id}>
									<button
										type="button"
										onClick={() => void importProject(project.id)}
										className="w-full border border-[#172128] bg-[#f6f7f4] px-3 py-2 text-left text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
									>
										{t({ ru: "Импортировать", en: "Import" })} {project.name}
									</button>
								</li>
							))}
						</ul>
					)}
				</aside>

				<section className="min-w-0 p-5 lg:p-8">
					{!state ? (
						<div
							className="border border-[#a9b1ad] bg-[#f6f7f4] p-6 lg:p-10"
							aria-busy={initializing}
						>
							<h2 className="max-w-xl text-3xl font-black tracking-tight">
								{initializing
									? t({
											ru: "Открываем ваши кампании…",
											en: "Opening your campaigns…",
										})
									: t({
											ru: "Превратите один ролик в серию рекламных версий",
											en: "Turn one video into a series of ad versions",
										})}
							</h2>
							<p className="mt-4 max-w-xl text-sm leading-6 text-[#48606d]">
								{t({
									ru: "Назовите кампанию слева и создайте её. Затем загрузите своё видео — оригинал останется на вашем устройстве, пока вы сами не отправите его в облако.",
									en: "Name and create your campaign on the left, then import your video. The original stays on your device until you choose to upload it.",
								})}
							</p>
							<ol className="mt-8 grid gap-6 border-t border-[#a9b1ad] pt-6 md:grid-cols-3">
								{[
									{
										title: t({ ru: "Соберите мастер", en: "Edit the master" }),
										text: t({
											ru: "Импортируйте видео и выберите нужные фрагменты на таймлинии.",
											en: "Import a video and choose the clips you need on the timeline.",
										}),
									},
									{
										title: t({ ru: "Создайте версии", en: "Create versions" }),
										text: t({
											ru: "Замените заголовок или CTA, выберите форматы и сравните результат.",
											en: "Swap a headline or CTA, choose formats and compare the results.",
										}),
									},
									{
										title: t({
											ru: "Скачайте результат",
											en: "Download the results",
										}),
										text: t({
											ru: "Проверьте версии и экспортируйте готовые ролики одним пакетом.",
											en: "Review your versions and export finished videos in one batch.",
										}),
									},
								].map((step, index) => (
									<li key={step.title}>
										<span className="font-mono text-sm text-[#194f78]">
											0{index + 1}
										</span>
										<h3 className="mt-2 font-bold">{step.title}</h3>
										<p className="mt-2 text-sm leading-6 text-[#48606d]">
											{step.text}
										</p>
									</li>
								))}
							</ol>
							{notice ? (
								<p role="status" className="mt-5 text-sm">
									{notice}
								</p>
							) : null}
						</div>
					) : (
						<>
							<div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-[#172128] pb-5">
								<div>
									<p className="font-mono text-[11px] uppercase">
										{t({
											ru: "Кампания / мастер-последовательность",
											en: "Campaign / master sequence",
										})}
									</p>
									<h2 className="mt-1 text-2xl font-black tracking-tight">
										{state.campaign.name}
									</h2>
								</div>
								<p className="max-w-xl text-right text-xs leading-5 text-[#48606d]">
									{visibleNotice}
								</p>
							</div>

							<div className="mt-6 lg:hidden">
								<div className="border-2 border-[#172128] bg-[#f6f7f4] p-5">
									<p className="font-mono text-xs font-bold uppercase">
										{t({ ru: "Режим проверки", en: "Review mode" })}
									</p>
									<p className="mt-2 text-sm">
										{t({
											ru: "Полное редактирование таймлинии доступно от 1024 px. Здесь остаются состояние кампании и статус сохранения.",
											en: "Full timeline editing starts at 1024 px. Campaign state and save health remain available here.",
										})}
									</p>
									<ul className="mt-4 divide-y divide-[#a9b1ad] border-y border-[#a9b1ad]">
										{state.campaign.master_sequence.scenes.map((scene) => (
											<li key={scene.id} className="py-3 text-sm">
												{scene.name}
											</li>
										))}
									</ul>
									{state.campaign.delivery_profiles.map((profile) => (
										<div
											key={profile.id}
											className="mt-4 border-l-4 border-[#d26532] bg-white p-4"
										>
											<p className="font-mono text-[10px] font-bold uppercase">
												Adaptive delivery · review only
											</p>
											<p className="mt-1 font-black">
												{profile.name} · {profile.canvas.width}×
												{profile.canvas.height}
											</p>
											<p className="mt-1 text-xs text-[#48606d]">
												Master timing and audio remain inherited. Crop editing
												is available from 1024 px.
											</p>
										</div>
									))}
								</div>
							</div>

							<nav
								aria-label={t({ ru: "Этапы работы", en: "Workflow" })}
								className="sticky top-0 z-10 mt-4 flex flex-wrap gap-2 border-y border-[#a9b1ad] bg-[#e7e9e6] py-3 text-sm font-bold"
							>
								{[
									{
										href: "#master-editor",
										label: t({ ru: "Монтаж", en: "Edit" }),
									},
									{
										href: "#variant-matrix",
										label: t({
											ru: "Версии и форматы",
											en: "Versions and formats",
										}),
									},
									{
										href: "#export-package",
										label: t({ ru: "Экспорт", en: "Export" }),
									},
									{
										href: "#connected-workspace",
										label: t({ ru: "Облако и команда", en: "Cloud and team" }),
									},
								].map((item) => (
									<a
										key={item.href}
										href={item.href}
										className="border border-[#48606d] bg-[#f6f7f4] px-4 py-2 hover:bg-[#b9d1dc] focus-visible:outline-3 focus-visible:outline-[#194f78]"
									>
										{item.label}
									</a>
								))}
							</nav>
							<div className="mt-4 hidden grid-cols-[180px_minmax(0,1fr)] gap-4 lg:grid">
								<nav aria-label={t({ ru: "Сцены", en: "Scenes" })}>
									<p className="mb-2 font-mono text-[11px] font-bold uppercase">
										{t({ ru: "Область сцены", en: "Scene scope" })}
									</p>
									{state.campaign.master_sequence.scenes.map((scene, index) => (
										<button
											key={scene.id}
											type="button"
											onClick={() => selectScene(scene)}
											aria-pressed={scene.id === activeSceneId}
											className="mb-2 flex w-full items-center gap-3 border-2 border-[#172128] bg-[#f6f7f4] px-3 py-3 text-left aria-pressed:bg-[#b9d1dc] focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#d26532]"
										>
											<span className="font-mono text-xs">
												{String(index + 1).padStart(2, "0")}
											</span>
											<span className="font-bold">{scene.name}</span>
										</button>
									))}
								</nav>

								<div className="border-2 border-[#172128] bg-[#f6f7f4]">
									<div className="grid grid-cols-[1fr_auto] border-b-2 border-[#172128] bg-[#b9d1dc]">
										<div className="p-3">
											<p className="font-mono text-[11px] uppercase">
												{t({ ru: "Активная сцена", en: "Active scene" })}
											</p>
											<h3 className="mt-2 text-2xl font-black">
												{activeScene?.name}
											</h3>
										</div>
										<div className="flex items-center border-l-2 border-[#172128] px-3 font-mono text-xs">
											MASTER
										</div>
									</div>

									<div className="p-5">
										<label
											htmlFor="scene-name"
											className="font-mono text-xs font-bold uppercase"
										>
											{t({ ru: "Название сцены", en: "Scene name" })}
										</label>
										<div className="mt-2 flex gap-2">
											<input
												id="scene-name"
												value={draftName}
												onChange={(event) => setDraftName(event.target.value)}
												className="min-w-0 flex-1 border-2 border-[#172128] bg-white px-3 py-2 text-base focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#d26532]"
											/>
											<button
												type="button"
												disabled={
													!activeScene ||
													draftName.trim() === "" ||
													draftName === activeScene.name ||
													saveState === "saving"
												}
												onClick={() =>
													void runCommand({
														command: "rename_scene",
														scene_id: activeSceneId ?? "",
														new_name: draftName,
													})
												}
												className="border-2 border-[#172128] bg-[#194f78] px-4 py-2 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#d26532]"
											>
												{t({ ru: "Сохранить название", en: "Save name" })}
											</button>
										</div>

										<div className="mt-6 flex flex-wrap gap-2 border-t border-[#a9b1ad] pt-5">
											<button
												type="button"
												onClick={() => void runCommand({ command: "undo" })}
												className="border-2 border-[#172128] px-4 py-2 text-sm font-bold focus-visible:outline-4 focus-visible:outline-[#d26532]"
											>
												{t({
													ru: "Отменить в активной сцене",
													en: "Undo active scene",
												})}
											</button>
											<button
												type="button"
												onClick={() => void runCommand({ command: "redo" })}
												className="border-2 border-[#172128] px-4 py-2 text-sm font-bold focus-visible:outline-4 focus-visible:outline-[#d26532]"
											>
												{t({
													ru: "Повторить в активной сцене",
													en: "Redo active scene",
												})}
											</button>
											{process.env.NEXT_PUBLIC_VARIANTLAB_M2_TEST_ADAPTER ===
											"1" ? (
												<button
													type="button"
													onClick={() => {
														injectNextWriteFailure();
														setNotice(
															"The next journal write will fail with QuotaExceededError.",
														);
													}}
													className="ml-auto border-2 border-[#8c321f] bg-[#f3d5c8] px-4 py-2 text-sm font-bold text-[#702514] focus-visible:outline-4 focus-visible:outline-[#d26532]"
												>
													{t({
														ru: "Сломать следующую запись",
														en: "Fail next write",
													})}
												</button>
											) : null}
										</div>

										{saveState === "error" && (
											<div
												className="mt-5 border-l-4 border-[#a63824] bg-[#f3d5c8] p-4"
												role="alert"
											>
												<p className="font-bold">
													{t({
														ru: "Сохранение не удалось — кампания изменена",
														en: "Save failed — campaign is dirty",
													})}
												</p>
												<p className="mt-1 text-sm">{saveError}</p>
												<button
													type="button"
													onClick={() => {
														const pending = pendingCommitRef.current;
														if (pending) void persistCommit(pending);
													}}
													className="mt-3 border-2 border-[#172128] bg-white px-4 py-2 text-sm font-bold focus-visible:outline-4 focus-visible:outline-[#d26532]"
												>
													{t({ ru: "Повторить сохранение", en: "Retry save" })}
												</button>
											</div>
										)}
									</div>
								</div>
							</div>

							{activeSceneId ? (
								<div className="hidden lg:block">
									<RoughCutWorkspace
										key={`${state.campaign.id}:${activeSceneId}`}
										campaignId={state.campaign.id}
										studioState={state}
										sceneId={activeSceneId}
										timeline={activeTimeline}
										onCommit={async (edit) => {
											try {
												await runCommand({
													command: "edit_timeline",
													scene_id: activeSceneId,
													edit,
												});
											} catch (error) {
												setNotice(
													error instanceof Error
														? error.message
														: "Timeline edit failed",
												);
											}
										}}
										onVariantCommand={({ payload, sceneScope, variantScope }) =>
											runCommand(payload, { sceneScope, variantScope })
										}
										onNotice={setNotice}
										onGestureState={(active) => {
											if (active) {
												setNotice(
													"Previewing one transaction; Escape restores canonical state.",
												);
											}
										}}
									/>
								</div>
							) : null}

							{browserLocal ? (
								<section id="connected-workspace" className="mt-6 border border-[#a9b1ad] bg-[#f6f7f4] p-5">
									<h2 className="text-lg font-bold">{t({ ru: "Работа на этом устройстве", en: "Working on this device" })}</h2>
									<p className="mt-2 text-sm leading-6">{t({ ru: "В этой публикации доступны монтаж, варианты и локальный экспорт. Кампании и медиа хранятся в этом браузере. Для резервной копии скачайте редактируемый проект. Облачный вход, синхронизация и серверный рендер здесь ещё не подключены.", en: "This publication supports editing, variants and local export. Campaigns and media stay in this browser. Download an editable project for backup. Cloud accounts, sync and server rendering are not connected here yet." })}</p>
								</section>
							) : <>
							<ConnectedCloudBoard
								key={`cloud:${state.campaign.id}`}
								state={state}
								onNotice={setNotice}
							/>
							<ConnectedSyncBoard
								key={`sync:${state.campaign.id}`}
								state={state}
								isDirty={isDirty}
								onOpen={async (id) => {
									await refreshLists();
									await openCampaign(id);
								}}
							/>

							</>}

							<RenderPackageBoard
								key={state.campaign.id}
								state={state}
								onNotice={setNotice}
								onImported={openCampaign}
								onSceneInclusion={({ sceneId, included }) =>
									runCommand(
										{
											command: "set_scene_inclusion",
											scene_id: sceneId,
											included,
										},
										{
											sceneScope: { kind: "sequence" },
											variantScope: { kind: "master" },
										},
									)
								}
							/>

							<details className="mt-6 text-xs">
								<summary className="cursor-pointer py-3 font-bold">
									{t({
										ru: "Сведения о локальном сохранении",
										en: "Local save details",
									})}
								</summary>
								<div className="grid grid-cols-2 border-2 border-[#172128] bg-[#172128] font-mono text-xs text-white lg:grid-cols-4">
									<div className="border-r border-[#66808d] p-3">
										<span className="block text-[#aac0ca]">STATE</span>
										{isDirty ? "DIRTY" : "DURABLE"}
									</div>
									<div className="border-r border-[#66808d] p-3">
										<span className="block text-[#aac0ca]">JOURNAL</span>
										{lastReceipt ? "REV " + lastReceipt.revision : "SNAPSHOT"}
									</div>
									<div className="border-r border-[#66808d] p-3">
										<span className="block text-[#aac0ca]">
											WRITE P95 TARGET
										</span>
										&lt; 100 MS
									</div>
									<div className="p-3">
										<span className="block text-[#aac0ca]">LAST RECEIPT</span>
										{lastReceipt
											? lastReceipt.durationMs.toFixed(1) + " MS"
											: "—"}
									</div>
								</div>
							</details>
						</>
					)}
				</section>
			</div>

			<footer className="border-t-2 border-[#172128] bg-[#f6f7f4] px-5 py-3 text-xs text-[#48606d] lg:px-8">
				<a href="/about/open-source" className="mr-2 font-bold underline">
					{t({
						ru: "Открытый исходный код и лицензии",
						en: "Open source and licenses",
					})}
				</a>
				{t({
					ru: "VariantLab — рабочее название. Сведения об исходном открытом проекте, лицензия MIT и авторские уведомления сохранены в разделе атрибуции.",
					en: "VariantLab is a working codename. Source-project attribution, the MIT license and copyright notices are preserved in the attribution section.",
				})}
			</footer>
		</main>
	);
}
