"use client";
import type { StudioState } from "@variantlab/studio-contract";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVariantLabLocale } from "./locale";
import type {
	PreviewRequest,
	PreviewResponse,
} from "./manifest-preview-worker";

export const ManifestPreviewWall = memo(function ManifestPreviewWall({
	state,
	cellIds,
	focusedCellId,
}: {
	state: StudioState;
	cellIds: string[];
	focusedCellId: string | null;
}) {
	const { t, locale } = useVariantLabLocale();
	const identity = cellIds.slice(0, 24).join("\n");
	const tiles = useMemo(
		() =>
			identity
				? identity.split("\n").map((id) => ({
						id,
						full: id === (focusedCellId ?? identity.split("\n")[0]),
						canvas: state.campaign.delivery_profiles.find(profile => profile.id === state.campaign.variant_cells.find(cell => cell.id === id)?.delivery_profile_id)?.canvas,
					}))
				: [],
		[identity, focusedCellId, state],
	);
	const root = useRef<HTMLDivElement>(null);
	const seek = useRef<HTMLInputElement>(null);
	const transport = useRef({ tick: 0, playing: false, dirty: true });
	const [playing, setPlaying] = useState(false);
	const [duration, setDuration] = useState(0);
	useEffect(() => {
		const container = root.current;
		if (!container || tiles.length === 0) return;
		let duration = 0;
		const worker = new Worker(
			new URL("./manifest-preview-worker.ts", import.meta.url),
			{ type: "module" },
		);
		const visible = new Set<string>();
		let busy = false;
		let previous = performance.now();
		let frame = 0;
		let lastSent = -Infinity;
		transport.current.dirty = true;
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				const id = entry.target.getAttribute("data-preview-cell");
				if (id) {
					if (entry.isIntersecting) visible.add(id);
					else visible.delete(id);
				}
			}
			transport.current.dirty = true;
		});
		for (const node of container.querySelectorAll("[data-preview-cell]"))
			observer.observe(node);
		worker.onmessage = (event: MessageEvent<PreviewResponse>) => {
			if (event.data.kind === "ready") {
				duration = event.data.duration;
				setDuration(duration);
				transport.current.tick = Math.min(transport.current.tick, Math.max(0, duration - 1));
				return;
			}
			for (const result of event.data.frames) {
				const article = [
					...container.querySelectorAll<HTMLElement>("[data-preview-cell]"),
				].find((node) => node.dataset.previewCell === result.id);
				const canvas = article?.querySelector("canvas");
				const status = article?.querySelector<HTMLElement>(
					"[data-preview-error]",
				);
				if (result.bitmap) {
					if (canvas && visible.has(result.id)) {
						canvas.width = result.bitmap.width;
						canvas.height = result.bitmap.height;
						canvas.getContext("2d")?.drawImage(result.bitmap, 0, 0);
						canvas.dataset.renderTick = String(event.data.tick);
						if (status) status.textContent = "";
					}
					result.bitmap.close();
				} else if (status) {
					canvas
						?.getContext("2d")
						?.clearRect(0, 0, canvas.width, canvas.height);
					status.textContent =
						locale === "ru"
							? "Предпросмотр недоступен: проверьте исходники, привязки и размещение текста."
							: "Preview unavailable: check originals, bindings and text placement.";
					status.dataset.errorCode = result.error;
				}
			}
			busy = false;
		};
		worker.onerror = () => {
			busy = false;
			transport.current.playing = false;
			setPlaying(false);
		};
		worker.postMessage({ kind: "initialize", state, firstCellId: tiles[0].id } satisfies PreviewRequest);
		const animate = (now: number) => {
			const clock = transport.current;
			if (clock.playing && visible.size > 0)
				clock.tick =
					(clock.tick + Math.round((now - previous) * 48)) % duration;
			previous = now;
			if (seek.current) seek.current.value = String(clock.tick);
			if (
				!busy &&
				duration > 0 &&
				visible.size > 0 &&
				(clock.dirty || (clock.playing && now - lastSent >= 100))
			) {
				busy = true;
				clock.dirty = false;
				lastSent = now;
				const request: PreviewRequest = {
					kind: "draw",
					tick: clock.tick,
					tiles: tiles.filter((tile) => visible.has(tile.id)),
				};
				worker.postMessage(request);
			}
			frame = requestAnimationFrame(animate);
		};
		frame = requestAnimationFrame(animate);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			worker.terminate();
		};
	}, [tiles, state, locale]);
	return (
		<div
			ref={root}
			className="mt-4 border-2 border-[#172128] bg-[#172128] p-3 text-white"
			data-testid="m6-preview-prism"
		>
			<h5 className="font-black">
				{t({ ru: "Стена предпросмотра", en: "Preview Wall" })}
			</h5>
			<p className="text-xs">
				{t({
					ru: "Реальные кадры RenderManifest · один общий таймер · только видимые ячейки",
					en: "Actual RenderManifest frames · shared clock · visible cells only",
				})}
			</p>
			<div className="my-3 flex gap-3">
				<button
					type="button"
					disabled={duration <= 0}
					className="border px-3 py-1"
					onClick={() => {
						transport.current.playing = !transport.current.playing;
						setPlaying(transport.current.playing);
					}}
				>
					{playing
						? t({ ru: "Пауза стены", en: "Pause wall" })
						: t({ ru: "Воспроизвести стену", en: "Play wall" })}
				</button>
				<input
					ref={seek}
					type="range"
					aria-label={t({
						ru: "Время стены предпросмотра",
						en: "Preview wall time",
					})}
					min={0}
					max={Math.max(0, duration - 1)}
					defaultValue={0}
					onChange={(event) => {
						transport.current.tick = Number(event.target.value);
						transport.current.dirty = true;
					}}
				/>
			</div>
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
			>
				{tiles.map((tile) => (
					<article
						key={tile.id}
						data-preview-cell={tile.id}
						data-decoder-quality={tile.full ? "full" : "thumbnail"}
						className="relative border border-[#66808d]"
						style={{
							aspectRatio: tile.canvas ? `${tile.canvas.width}/${tile.canvas.height}` : "16/9",
						}}
					>
						<canvas
							role="img"
							aria-label={t({
								ru: `Результат ${tile.id}`,
								en: `Rendered ${tile.id}`,
							})}
							className="h-full w-full"
						/>
						<p
							data-preview-error
							className="absolute inset-x-1 top-1 bg-[#172128] text-xs"
						/>
						<span
							translate="no"
							title={`${tile.id} · r${state.campaign.revision}`}
							className="absolute left-1 right-1 bottom-1 truncate bg-[#172128] text-[9px]"
						>
							{tile.id} · r{state.campaign.revision}
						</span>
					</article>
				))}
			</div>
			{tiles.length === 0 ? (
				<p>
					{t({
						ru: "Включите ячейки для сравнения вариантов.",
						en: "Enable cells to compare variants.",
					})}
				</p>
			) : null}
		</div>
	);
});
