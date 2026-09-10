"use client";
/* eslint-disable jsx-a11y/media-has-caption -- This player displays the frozen render, whose authored caption layer is burned in by the shared Rust render plan. */

import { useEffect, useState } from "react";
import type { ReviewView, VariantProjectionDiagnostic } from "@variantlab/studio-contract";
import { connectedApi } from "./connected-client";
import { useUiCopy } from "./ui-copy";
import { VariantLabLocaleProvider, VariantLabLanguageSwitch, useVariantLabLocale } from "./locale";

function Review() {
	const { t } = useVariantLabLocale();
	const copy = useUiCopy();
	const [view, setView] = useState<(ReviewView & { diagnostics: VariantProjectionDiagnostic[] }) | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	async function refresh() {
		try { const value = await connectedApi<ReviewView & { diagnostics: VariantProjectionDiagnostic[] }>("/review-access", { token: location.hash.slice(1) }); setView(value); setError(""); }
		catch (reason) { setView(null); setError(reason instanceof Error ? reason.message : "review_failed"); }
	}
	// eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate scoped remote review after fetching its capability token.
useEffect(() => { void refresh(); }, []);
	async function decide(decision: "approved" | "rejected") {
		setBusy(true);
		try { await connectedApi("/review-decision", { token: location.hash.slice(1), request_id: crypto.randomUUID(), decision }); await refresh(); }
		catch (reason) { await refresh(); setError(reason instanceof Error ? reason.message : "review_failed"); }
		finally { setBusy(false); }
	}
	return <main className="mx-auto max-w-5xl space-y-6 break-words p-6 [&_button:focus-visible]:outline-4 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-[#194f78]">
		<VariantLabLanguageSwitch position="inline" />
		<h1 className="text-2xl font-semibold">{t({ ru: "Согласование VariantLab", en: "VariantLab review" })}</h1>
		{error && <p role="alert">{t({ ru: "Ссылка недоступна или решение не принято. Код: ", en: "Link unavailable or decision not accepted. Code: " })}{error}</p>}
		{view && <>
			<h2>{view.name} · {t({ ru: "Ревизия", en: "Revision" })} {view.revision}</h2>
			<p>{t({ ru: "Зафиксированный результат. Редактирование по этой ссылке недоступно.", en: "Frozen output. This link grants no editing access." })}</p>
			{view.stale && <p role="status">{t({ ru: "Есть новая ревизия. Запросите новую ссылку для решения.", en: "A newer revision exists. Request a new link before deciding." })}</p>}
			<div className="grid gap-4 sm:grid-cols-2">{view.previews.map((preview) => <figure key={preview.cell_id}>{/* Captions, when authored, are burned into this immutable export. */}<video className="max-h-96 w-full" controls preload="metadata" aria-label={t({ ru: "Просмотр варианта ", en: "Variant preview " }) + preview.cell_id} src={preview.url} /><figcaption>{preview.cell_id}</figcaption></figure>)}</div>
			<h3>{t({ ru: "Проверки этой ревизии", en: "Diagnostics for this revision" })}</h3>
			{view.diagnostics.length ? <ul>{view.diagnostics.map((item) => <li key={`${item.affected_cell_id}:${item.rule_id}`}>{item.affected_cell_id}: {copy(item.message)} ({item.code})</li>)}</ul> : <p>{t({ ru: "Замечаний нет", en: "No diagnostics" })}</p>}
			<p role="status">{view.decision === "approved" ? t({ ru: "Одобрено", en: "Approved" }) : view.decision === "rejected" ? t({ ru: "Отклонено", en: "Rejected" }) : t({ ru: "Ожидает решения", en: "Awaiting decision" })}</p>
			<div className="flex flex-wrap gap-4"><button className="rounded border px-4 py-2" disabled={busy || view.stale} onClick={() => void decide("approved")}>{t({ ru: "Одобрить ревизию", en: "Approve revision" })}</button><button className="rounded border px-4 py-2" disabled={busy || view.stale} onClick={() => void decide("rejected")}>{t({ ru: "Отклонить ревизию", en: "Reject revision" })}</button></div>
		</>}
		<button className="rounded border px-4 py-2" disabled={busy} onClick={() => void refresh()}>{t({ ru: "Обновить просмотр", en: "Refresh review" })}</button>
		<a href="/about/open-source" className="block underline">{t({ ru: "Об OpenCut и открытых компонентах", en: "OpenCut and open-source attribution" })}</a>
	</main>;
}

export function ReviewClient() { return <VariantLabLocaleProvider><Review /></VariantLabLocaleProvider>; }

