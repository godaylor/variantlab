/// <reference lib="webworker" />
import type { RenderManifest, StudioState } from "@variantlab/studio-contract";
import * as wasm from "../../../../rust/wasm/pkg/opencut_wasm_bg.js";
import { FrozenFrameRenderer } from "./frozen-frame";

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const scope = self as DedicatedWorkerGlobalScope;
const url = new URL(
	"../../../../rust/wasm/pkg/opencut_wasm_bg.wasm",
	import.meta.url,
);
const ready = WebAssembly.instantiateStreaming(
	fetch(new URL(url, scope.location.origin)),
	{
		"./opencut_wasm_bg.js": wasm,
	},
).then(({ instance }) => {
	wasm.__wbg_set_wasm(instance.exports);
	const start = instance.exports.__wbindgen_start;
	if (typeof start === "function") Reflect.apply(start, null, []);
});
export type PreviewRequest = { kind: "initialize"; state: StudioState; firstCellId: string } | {
	kind: "draw";
	tick: number;
	tiles: Array<{ id: string; full: boolean }>;
};
export type PreviewResponse = { kind: "ready"; duration: number } | {
	kind: "frames";
	frames: Array<{ id: string; bitmap?: ImageBitmap; error?: string }>;
	tick: number;
};
let busy = false;
let frozenState = "";
let campaignId = "";
const manifests = new Map<string, RenderManifest>();
function manifestFor(id: string): RenderManifest {
	const cached = manifests.get(id);
	if (cached) return cached;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generated Rust contract.
	const manifest = JSON.parse(wasm.variantBuildRenderManifest(frozenState, id)) as RenderManifest;
	manifests.set(id, manifest);
	return manifest;
}
scope.onmessage = async (event: MessageEvent<PreviewRequest>) => {
	if (event.data.kind === "initialize") {
		await ready;
		campaignId = event.data.state.campaign.id;
		frozenState = JSON.stringify(event.data.state);
		manifests.clear();
		scope.postMessage({ kind: "ready", duration: manifestFor(event.data.firstCellId).sequence_duration_ticks });
		return;
	}
	if (busy) return;
	busy = true;
	const frames: Extract<PreviewResponse, { kind: "frames" }>["frames"] = [];
	try {
		try {
			await ready;
		} catch {
			scope.postMessage({
				kind: "frames",
				frames: event.data.tiles
					.slice(0, 24)
					.map((tile) => ({
						id: tile.id,
						error: "preview_runtime_unavailable",
					})),
				tick: event.data.tick,
			});
			return;
		}
		// A single worker serializes decoding: no offscreen decoders, no unbounded tile caches.
		const active = new Set(event.data.tiles.slice(0, 24).map(tile => tile.id));
		for (const id of manifests.keys()) if (!active.has(id)) manifests.delete(id);
		for (const tile of event.data.tiles.slice(0, 24)) {
			const manifest = manifestFor(tile.id);
			const renderer = new FrozenFrameRenderer({
				manifest,
				wasm,
			});
			try {
				const edge = tile.full ? 1920 : 256;
				const scale = Math.min(
					1,
					edge /
						Math.max(manifest.canvas.width, manifest.canvas.height),
				);
				const surface = new OffscreenCanvas(
					Math.max(1, Math.round(manifest.canvas.width * scale)),
					Math.max(1, Math.round(manifest.canvas.height * scale)),
				);
				await renderer.prepare(campaignId);
				await renderer.draw({ canvas: surface, tick: event.data.tick });
				frames.push({ id: tile.id, bitmap: surface.transferToImageBitmap() });
			} catch (error) {
				frames.push({ id: tile.id, error: String(error) });
			} finally {
				renderer.dispose();
			}
		}
		scope.postMessage(
			{ kind: "frames", frames, tick: event.data.tick },
			frames.flatMap((frame) => (frame.bitmap ? [frame.bitmap] : [])),
		);
	} finally {
		busy = false;
	}
};
