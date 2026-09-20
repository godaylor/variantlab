"use client";

import { useEffect, useRef, useState } from "react";
import type { StudioState } from "@variantlab/studio-contract";
import { connectedApi } from "./connected-client";
import { listMediaAssets, fileForPath } from "./media-store";
import { useVariantLabLocale } from "./locale";
import { ConnectedCloudBoard } from "./connected-cloud-board";

export function SitesAccountMedia({ state }: { state: StudioState }) {
  const { t } = useVariantLabLocale();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [renderConfigured, setRenderConfigured] = useState(false);
  const [renderAvailable, setRenderAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void connectedApi<{ authenticated: boolean; render_configured: boolean; render_available: boolean }>("/session").then(value => { if (!disposed) { setSignedIn(value.authenticated); setRenderConfigured(value.render_configured); setRenderAvailable(value.render_available); } }).catch(() => { if (!disposed) setError("session_unavailable"); }); };
    refresh(); const timer = setInterval(refresh, 15000);
    return () => { disposed = true; clearInterval(timer); controller.current?.abort(); };
  }, []);
  async function upload() {
    setBusy(true); setError(""); setNotice("");
    const abort = new AbortController(); controller.current = abort;
    try {
      const assets = await listMediaAssets(state.campaign.id);
      if (!assets.length) { setNotice(t({ ru: "В этой кампании нет импортированных оригиналов.", en: "This campaign has no imported originals." })); return; }
      for (const [index, asset] of assets.entries()) {
        abort.signal.throwIfAborted();
        const file = await fileForPath(asset.original_path);
        const session = await connectedApi<{ upload_id: string; part_size_bytes: number; completed_parts: Array<{ part_number: number }> }>("/uploads", {
          campaign_id: state.campaign.id, asset_hash: asset.asset_hash, content_type: asset.detected_mime, total_bytes: file.size,
        });
        const done = new Set(session.completed_parts.map(part => part.part_number));
        for (let offset = 0, part = 1; offset < file.size; offset += session.part_size_bytes, part++) {
          abort.signal.throwIfAborted();
          if (!done.has(part)) {
            const bytes = await file.slice(offset, offset + session.part_size_bytes).arrayBuffer();
            const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
            const response = await fetch(`/api/variantlab/uploads/${session.upload_id}/parts/${part}`, { method: "PUT", signal: abort.signal, headers: { "content-type": "application/octet-stream", "x-content-sha256": checksum }, body: bytes });
            if (!response.ok) throw new Error(`upload_part_${response.status}`);
          }
          setNotice(`${index + 1}/${assets.length} · ${Math.min(100, Math.round((offset + session.part_size_bytes) / file.size * 100))}%`);
        }
        abort.signal.throwIfAborted();
        await connectedApi(`/uploads/${session.upload_id}/complete`, {});
      }
      setNotice(t({ ru: "Оригиналы сохранены в облаке, контрольные суммы проверены.", en: "Originals saved in the cloud; checksums verified." }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "upload_failed"); }
    finally { setBusy(false); controller.current = null; }
  }
  return <section id="connected-workspace" className="mt-6 space-y-3 border-2 border-[#172128] bg-[#f6f7f4] p-5 text-[#172128] [&_button]:border-2 [&_button]:border-[#172128] [&_button]:px-3 [&_button]:py-2 [&_a]:underline">
    <h2 className="text-xl font-bold">{t({ ru: "Облачное рабочее пространство", en: "Cloud workspace" })}</h2>
    {signedIn ? <p>{t({ ru: "Вход выполнен. Ваши кампании и оригиналы доступны только вашему аккаунту.", en: "Signed in. Your campaigns and originals are private to your account." })} <a target="_top" href="/signout-with-chatgpt?return_to=%2Fvariantlab%2F">{t({ ru: "Выйти", en: "Sign out" })}</a></p> : <p><a target="_top" href="/signin-with-chatgpt?return_to=%2Fvariantlab%2F">{t({ ru: "Войти через ChatGPT", en: "Sign in with ChatGPT" })}</a></p>}
    <p>{t({ ru: "Сначала сохраните кампанию в облако ниже. Затем загрузите оригиналы: файлы будут отправлены в приватное хранилище этого сайта. Плата в приложении не взимается. Загрузка возобновляется после повторного нажатия.", en: "First save your campaign to the cloud below. Then upload originals to this site's private storage. There is no in-app charge. Press again to resume an interrupted upload." })}</p>
    <button disabled={busy || !signedIn} onClick={() => void upload()}>{t({ ru: "Загрузить оригиналы в облако", en: "Upload originals to cloud" })}</button>
    {busy && <button onClick={() => controller.current?.abort()}>{t({ ru: "Отменить загрузку", en: "Cancel upload" })}</button>}
    <p role="status">{notice}</p>{error && <p role="alert">{t({ ru: "Действие не завершено; локальные файлы сохранены. Код: ", en: "Action incomplete; local files are retained. Code: " })}{error}</p>}
    {!renderAvailable && <p>{t({ ru: "Серверный исполнитель сейчас не подключён. Экспорт на этом устройстве работает ниже; для него вкладка должна оставаться открытой.", en: "The server renderer is currently offline. On-device export works below; keep this tab open while it runs." })}</p>}
    {renderConfigured && signedIn && <ConnectedCloudBoard state={state} onNotice={setNotice} sitesConnected />}
  </section>;
}
