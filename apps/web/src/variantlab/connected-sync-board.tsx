"use client";

import { useRef, useState } from "react";
import type { StudioState, ConnectedCampaignSummary, ConnectedBranch, ConnectedSnapshot, ReviewSummary } from "@variantlab/studio-contract";
import { connectedApi, deviceId, flushConnectedSync, verifyConnectedSnapshot } from "./connected-client";
import { connectedOutbox, enableConnectedSync, installConnectedSnapshot, createStoredCampaign } from "./local-store";
import { downloadConnectedOriginals } from "./connected-media";
import { listMediaAssets, saveMediaAsset } from "./media-store";
import { snapshotHash } from "./domain";
import { useVariantLabLocale } from "./locale";
import { forkRecovered } from "variantlab-wasm";

export function ConnectedSyncBoard({ state, isDirty, onOpen }: { state: StudioState; isDirty: boolean; onOpen: (id: string) => Promise<void> }) {
	const { t } = useVariantLabLocale();
	const [busy, setBusy] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [notice, setNotice] = useState<{ ru: string; en: string } | null>(null);
	const [error, setError] = useState("");
	const [campaigns, setCampaigns] = useState<ConnectedCampaignSummary[]>([]);
	const [branches, setBranches] = useState<ConnectedBranch[]>([]);
	const [reviews, setReviews] = useState<ReviewSummary[]>([]);
	const [link, setLink] = useState("");
	const controller = useRef<AbortController | null>(null);
	async function run(action: () => Promise<void>) {
		setBusy(true); setError("");
		try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "unknown"); }
		finally { controller.current = null; setDownloading(false); setBusy(false); }
	}
	async function sync() {
		await connectedApi("/workspace");
		await enableConnectedSync(state);
		const receipt = await flushConnectedSync(state.campaign.id);
		setNotice(receipt.status === "synced" ? { ru: `В облаке сохранена ревизия ${receipt.revision}`, en: `Cloud revision ${receipt.revision} saved` } : { ru: "Конфликт сохранён в отдельной ветке. Обе версии доступны ниже.", en: "Conflict saved as a recovered branch. Both versions are available below." });
		const value = await connectedApi<{ branches: ConnectedBranch[] }>(`/campaigns/${state.campaign.id}/branches`); setBranches(value.branches);
	}
	async function load(id: string) {
		const value = await connectedApi<ConnectedSnapshot>(`/campaigns/${id}/snapshot`);
		const incoming = verifyConnectedSnapshot(value);
		const outbox = await connectedOutbox(id);
		if (outbox && (outbox.commands.length || outbox.initial_snapshot || outbox.branch_id || outbox.overflow)) throw new Error("local_changes_pending");
		controller.current = new AbortController();
		setDownloading(true);
		await downloadConnectedOriginals({ state: incoming, signal: controller.current.signal, onProgress: (progress) => setNotice({ ru: `Загрузка оригиналов: ${progress}`, en: `Downloading originals: ${progress}` }) });
		await installConnectedSnapshot(incoming); await onOpen(id);
		setNotice({ ru: "Кампания и проверенные оригиналы сохранены локально", en: "Campaign and verified originals saved locally" });
	}
	async function continueBranch(branch: ConnectedBranch) {
		if (snapshotHash(state) !== branch.snapshot_sha256) throw new Error("sync_latest_changes_first");
		const value = await connectedApi<ConnectedSnapshot>(`/branches/${branch.id}/continue`, {});
		const recovered = verifyConnectedSnapshot(value);
		for (const asset of await listMediaAssets(state.campaign.id)) await saveMediaAsset({ ...asset, asset_id: crypto.randomUUID(), campaign_id: recovered.campaign.id });
		await createStoredCampaign({ state: recovered }); await onOpen(recovered.campaign.id);
	}
	async function listReviews() { const value = await connectedApi<{ reviews: ReviewSummary[] }>(`/campaigns/${state.campaign.id}/reviews`); setReviews(value.reviews); }
	async function localRecovery() {
		const value: unknown = JSON.parse(forkRecovered(JSON.stringify(state), crypto.randomUUID(), t({ ru: "Восстановленная ветка", en: "Recovered branch" }), new Date().toISOString()));
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- versioned Rust function returns a StudioState contract.
		const recovered = value as StudioState;
		for (const asset of await listMediaAssets(state.campaign.id)) await saveMediaAsset({ ...asset, asset_id: crypto.randomUUID(), campaign_id: recovered.campaign.id });
		await createStoredCampaign({ state: recovered }); await onOpen(recovered.campaign.id);
	}
	return <section className="space-y-4 border-2 border-[#172128] bg-[#f6f7f4] p-5 text-[#172128] [&_h2]:text-xl [&_h2]:font-bold [&_h3]:font-bold [&_button]:m-1 [&_button]:border-2 [&_button]:border-[#172128] [&_button]:px-3 [&_button]:py-2 [&_button]:font-semibold [&_button:disabled]:opacity-50 [&_button:focus-visible]:outline-4 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-[#194f78] [&_a]:underline [&_li]:my-2" aria-label={t({ ru: "Синхронизация и согласование", en: "Sync and review" })}>
		<h2>{t({ ru: "Продолжение на другом устройстве", en: "Continue on another device" })}</h2>
		<p>{t({ ru: "Синхронизация отправляет структуру и текст кампании в подключённое рабочее пространство. Оригиналы загружаются отдельно, через облачный рендер. Офлайн-изменения остаются в локальном журнале до подтверждения сервера.", en: "Sync sends campaign structure and text to the connected workspace. Upload originals separately through cloud rendering. Offline changes stay in the local journal until the server acknowledges them." })}</p>
		<div className="vl-toolbar">
			<button disabled={busy || isDirty} onClick={() => void run(sync)}>{t({ ru: "Синхронизировать кампанию", en: "Sync campaign" })}</button>
			<button disabled={busy} onClick={() => void run(async () => { await connectedApi(`/campaigns/${state.campaign.id}/release-writer`, { device_id: deviceId() }); setNotice({ ru: "Право записи освобождено для другого устройства", en: "Writer lease released for another device" }); })}>{t({ ru: "Передать редактирование", en: "Release writer" })}</button>
			<button disabled={busy} onClick={() => void run(async () => { await connectedApi("/workspace"); const value = await connectedApi<{ campaigns: ConnectedCampaignSummary[] }>("/campaigns"); setCampaigns(value.campaigns); })}>{t({ ru: "Найти облачные кампании", en: "Find cloud campaigns" })}</button>
			{downloading && <button onClick={() => controller.current?.abort()}>{t({ ru: "Отменить загрузку", en: "Cancel download" })}</button>}
		</div>
		<ul>{campaigns.map((item) => <li key={item.id}>{item.name} · {t({ ru: "ревизия", en: "revision" })} {item.revision} <button disabled={busy || isDirty} onClick={() => void run(() => load(item.id))}>{t({ ru: "Загрузить и продолжить", en: "Download and continue" })}</button></li>)}</ul>
		{branches.length > 0 && <div><h3>{t({ ru: "Сохранённые конфликтующие ветки", en: "Recovered branches" })}</h3><ul>{branches.map((branch) => <li key={branch.id}>{branch.name}: {branch.scene_names.join(", ")} · {t({ ru: "Облачная ревизия", en: "Cloud revision" })} {branch.server_revision}. <button disabled={busy || isDirty} onClick={() => void run(() => continueBranch(branch))}>{t({ ru: "Продолжить ветку как новую кампанию", en: "Continue branch as new campaign" })}</button></li>)}</ul></div>}
		<h3>{t({ ru: "Согласование зафиксированной ревизии", en: "Review a frozen revision" })}</h3>
		<p>{t({ ru: "Сначала синхронизируйте и отрендерьте эту ревизию. Ссылка действует 24 часа и открывает только просмотр и решение.", en: "Sync and render this revision first. The link expires in 24 hours and grants only viewing and a decision." })}</p>
		<button disabled={busy || isDirty} onClick={() => void run(async () => { const value = await connectedApi<{ token: string }>(`/campaigns/${state.campaign.id}/reviews`, { revision: state.campaign.revision, expires_in_seconds: 86400 }); setLink(`${location.origin}/variantlab/review#${value.token}`); await listReviews(); })}>{t({ ru: "Создать ссылку согласования", en: "Create review link" })}</button>
		<button disabled={busy} onClick={() => void run(listReviews)}>{t({ ru: "Обновить согласования", en: "Refresh reviews" })}</button>
		{link && <p><a href={link} target="_blank" rel="noreferrer">{t({ ru: "Открыть ссылку согласования", en: "Open review link" })}</a></p>}
		<ul>{reviews.map((review) => <li key={review.id}>{t({ ru: "Ревизия", en: "Revision" })} {review.revision}: {review.revoked ? t({ ru: "отозвано", en: "revoked" }) : review.expired ? t({ ru: "срок истёк", en: "expired" }) : review.stale ? t({ ru: "устарело", en: "stale" }) : review.decision === "approved" ? t({ ru: "одобрено", en: "approved" }) : review.decision === "rejected" ? t({ ru: "отклонено", en: "rejected" }) : t({ ru: "ожидает решения", en: "awaiting decision" })} <button disabled={busy || review.revoked} onClick={() => void run(async () => { await connectedApi(`/reviews/${review.id}/revoke`, {}); await listReviews(); })}>{t({ ru: "Отозвать ссылку", en: "Revoke link" })}</button></li>)}</ul>
		<p role="status">{notice ? t(notice) : ""}</p>{error && <p role="alert">{t({ ru: "Операция не завершена. Локальные изменения сохранены. Код: ", en: "Operation incomplete. Local changes are retained. Code: " })}{error}</p>}
		{error.includes("sync_outbox_full") && <div><p>{t({ ru: "Лимит очереди достигнут. Полное локальное состояние сохранено. Создайте отдельную кампанию из текущего состояния и синхронизируйте её; прежняя кампания останется доступной.", en: "The queue limit was reached. The full local state is retained. Create a separate campaign from this checkpoint and sync it; the original remains available." })}</p><button disabled={busy || isDirty} onClick={() => void run(localRecovery)}>{t({ ru: "Сохранить полную восстановленную ветку", en: "Save full recovery branch" })}</button></div>}
	</section>;
}

