/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Rust-generated JSON boundary, never editable UI state. */
import type {
	RenderFramePlan,
	RenderManifest,
	RenderOverlay,
	RenderCropRect,
} from "@variantlab/studio-contract";
import {
	ALL_FORMATS,
	BlobSource,
	Input,
	VideoSampleSink,
	type VideoSample,
} from "mediabunny";
import type * as Wasm from "../../../../rust/wasm/pkg/opencut_wasm_bg.js";
import { fileForPath, listMediaAssets } from "./media-store";

type Decoder = {
	input: Input;
	sink: VideoSampleSink;
	start: number;
	frames: AsyncGenerator<VideoSample, void, unknown>;
	current: VideoSample;
	next?: VideoSample;
	ended: boolean;
};
function closeDecoder(decoded: Decoder) {
	void decoded.frames.return();
	decoded.current.close();
	decoded.next?.close();
	decoded.input.dispose();
}

/** Platform drawing only. Rust selects samples, geometry, timing and overlay order. */
export class FrozenFrameRenderer {
	private inputs = new Map<string, Decoder>();
	private overlays: Array<{
		id: string;
		surface: OffscreenCanvas;
		x: number;
		y: number;
	}> = [];
	private overlayPlans: RenderOverlay[] = [];
private manifestJson: string;
	private originals = new Map<string, string>();
	private disposed = false;
	private manifest: RenderManifest;
	private wasm: typeof Wasm;
	constructor({
		manifest,
		wasm,
	}: {
		manifest: RenderManifest;
		wasm: typeof Wasm;
	}) {
		this.manifest = manifest;
		this.wasm = wasm;
		this.manifestJson = JSON.stringify(manifest);
	}
	async prepare(campaignId: string) {
		const assets = await listMediaAssets(campaignId);
		if (this.disposed) throw new Error("preview_cancelled");
		this.originals = new Map(
			assets.map((asset) => [asset.asset_hash, asset.original_path]),
		);
		this.overlayPlans = JSON.parse(
			this.wasm.renderOverlays(this.manifestJson),
		) as RenderOverlay[];
		}
private async prepareOverlays(ids: string[]) {
for (const cached of this.overlays) if (!ids.includes(cached.id)) { cached.surface.width = 1; cached.surface.height = 1; }
this.overlays = this.overlays.filter((cached) => ids.includes(cached.id));
for (const overlay of this.overlayPlans.filter((item) => ids.includes(item.slot_id) && !this.overlays.some((cached) => cached.id === item.slot_id))) {
			const node = this.manifest.slot_nodes?.find(
				(item) => item.slot_id === overlay.slot_id,
			);
			let pixels: Uint8Array;
			if (node?.value.kind === "logo") {
				const path = this.originals.get(node.value.asset_id);
				if (!path) throw new Error("logo_original_missing");
				const file = await fileForPath(path);
				if (file.size > 8 * 1024 * 1024) throw new Error("logo_byte_limit");
				pixels = this.wasm.renderLogoOverlay(
					this.manifestJson,
					overlay.slot_id,
					new Uint8Array(await file.arrayBuffer()),
				);
			} else
				pixels = this.wasm.renderTextOverlay(
					this.manifestJson,
					overlay.slot_id,
				);
			if (this.disposed) throw new Error("preview_cancelled");
			const surface = new OffscreenCanvas(overlay.width, overlay.height);
			const context = surface.getContext("2d");
			if (!context) throw new Error("render_surface_unavailable");
			context.putImageData(
				new ImageData(
					new Uint8ClampedArray(pixels),
					overlay.width,
					overlay.height,
				),
				0,
				0,
			);
			this.overlays.push({
				id: overlay.slot_id,
				surface,
				x: overlay.x,
				y: overlay.y,
			});
		}
	}
	frame(tick: number): RenderFramePlan {
		return JSON.parse(
			this.wasm.renderFramePlan(this.manifestJson, tick),
		) as RenderFramePlan;
	}
	async draw({
		canvas,
		tick,
	}: {
		canvas: OffscreenCanvas;
		tick: number;
	}): Promise<RenderFramePlan> {
		if (this.disposed) throw new Error("preview_cancelled");
		const plan = this.frame(tick);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("render_surface_unavailable");
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.fillStyle = "#000";
		context.fillRect(0, 0, canvas.width, canvas.height);
		if (plan.video) {
			const { asset_hash: hash, source_tick: sourceTick } = plan.video;
			let decoded = this.inputs.get(hash);
			if (!decoded) {
				// Two owned demuxers at most, each with an 8 MiB byte cache.
				if (this.inputs.size >= 2) {
					const oldest = this.inputs.keys().next().value!;
					closeDecoder(this.inputs.get(oldest)!);
					this.inputs.delete(oldest);
				}
				const path = this.originals.get(hash);
				if (!path) throw new Error("video_original_missing");
				const input = new Input({
					formats: ALL_FORMATS,
					source: new BlobSource(await fileForPath(path), {
						maxCacheSize: 8 * 1024 * 1024,
					}),
				});
				try {
					const track = await input.getPrimaryVideoTrack();
					if (!track || !(await track.canDecode()))
						throw new Error("video_decode_unavailable");
					// Mediabunny caches this config; configure it before creating the
					// sink so untagged MediaRecorder input cannot use browser defaults.
					const config = await track.getDecoderConfig();
					if (config && !config.colorSpace) {
						config.colorSpace = JSON.parse(
							this.wasm.renderUntaggedVideoColorSpace(),
						) as VideoColorSpaceInit;
					}
					const sink = new VideoSampleSink(track);
					const frames = sink.samples();
					const firstFrame = await frames.next();
					if (!firstFrame.value) {
						await frames.return();
						throw new Error("video_track_empty");
					}
					decoded = {
						input,
						sink,
						start: firstFrame.value.timestamp,
						frames,
						current: firstFrame.value,
						ended: false,
					};
					if (this.disposed) throw new Error("preview_cancelled");
					this.inputs.set(hash, decoded);
				} catch (error) {
					input.dispose();
					throw error;
				}
			} else {
				this.inputs.delete(hash);
				this.inputs.set(hash, decoded);
			}
			const timestamp = decoded.start + sourceTick / 48_000;
			if (timestamp < decoded.current.timestamp) {
				await decoded.frames.return();
				decoded.current.close();
				decoded.next?.close();
				decoded.frames = decoded.sink.samples();
				decoded.next = undefined;
				decoded.ended = false;
				const first = await decoded.frames.next();
				if (!first.value) throw new Error("video_track_empty");
				decoded.current = first.value;
			}
			// Sequential decoding retains only the current and next frame. Restarting
			// a decoder per output frame can return null for inter-frame packets.
			while (!decoded.ended) {
				if (!decoded.next) {
					const next = await decoded.frames.next();
					if (!next.value) {
						decoded.ended = true;
						break;
					}
					decoded.next = next.value;
				}
				if (decoded.next.timestamp > timestamp) break;
				decoded.current.close();
				decoded.current = decoded.next;
				decoded.next = undefined;
			}
			const sample = decoded.current;
			{
				const rect = JSON.parse(
					this.wasm.renderSourceCrop(
						JSON.stringify({
							canvas: this.manifest.canvas,
							crop: this.manifest.crop,
						}),
						sample.displayWidth,
						sample.displayHeight,
					),
				) as RenderCropRect;
				sample.draw(
					context,
					rect.x,
					rect.y,
					rect.width,
					rect.height,
					0,
					0,
					canvas.width,
					canvas.height,
				);
			}
		}
		context.scale(
			canvas.width / this.manifest.canvas.width,
			canvas.height / this.manifest.canvas.height,
		);
		await this.prepareOverlays(plan.overlay_ids);
		for (const id of plan.overlay_ids) {
			const overlay = this.overlays.find((item) => item.id === id);
			if (overlay) context.drawImage(overlay.surface, overlay.x, overlay.y);
		}
		context.setTransform(1, 0, 0, 1, 0, 0);
		return plan;
	}
	dispose() {
		this.disposed = true;
		for (const decoded of this.inputs.values()) closeDecoder(decoded);
		this.inputs.clear();
		for (const overlay of this.overlays) {
			overlay.surface.width = 1;
			overlay.surface.height = 1;
		}
		this.overlays = [];
	}
}

