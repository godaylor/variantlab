import * as wasm from "../rust/wasm/pkg/opencut_wasm_bg.js";
import { FrozenFrameRenderer } from "../apps/web/src/variantlab/frozen-frame";
import type { RenderManifest } from "@variantlab/studio-contract";

export async function stressOverlay(manifest: RenderManifest, samples: Array<{ index: number }>) {
	const { instance } = await WebAssembly.instantiate(await (await fetch("/__overlay.wasm")).arrayBuffer(), { "./opencut_wasm_bg.js": wasm }); wasm.__wbg_set_wasm(instance.exports);
	const renderer = new FrozenFrameRenderer({ manifest, wasm }); await renderer.prepare("caption-stress-fixture");
	const canvas = new OffscreenCanvas(640, 360); const results = [];
	for (const { index } of samples) {
		const frame = await renderer.draw({ canvas, tick: index * 120_000 });
		const pixels = wasm.renderTextOverlay(JSON.stringify(manifest), `caption-${index}`);
		const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(pixels));
		const cache = (renderer as unknown as { overlays: Array<{ surface: OffscreenCanvas }> }).overlays;
		results.push({ index, sha256: Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2,"0")).join(""), cached_bytes: cache.reduce((sum, item) => sum + item.surface.width * item.surface.height * 4, 0), active: frame.overlay_ids });
	}
	await renderer.draw({ canvas, tick: 119_999_999 });
	const released = (renderer as unknown as { overlays: unknown[] }).overlays.length === 0;
	renderer.dispose(); return { results, released, cues: manifest.slot_nodes.length, durationSeconds: manifest.sequence_duration_ticks / 48_000 };
}
