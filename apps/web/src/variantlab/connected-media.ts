import type { ConnectedAsset, StudioState, ProbeReport } from "@variantlab/studio-contract";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { probeLogoPng } from "opencut-wasm";
import { connectedApi } from "./connected-client";
import { planMediaDerivatives, snapshotHash } from "./domain";
import { probeMediaFile } from "./media-probe";
import { fileHandleForPath, fileForPath, stageOriginal, commitStagedOriginalWithReceipt, removeArtifact, listMediaAssets, saveMediaAsset } from "./media-store";

async function verifyFile({ file, hash, size }: { file: File; hash: string; size: number }) {
	if (file.size !== size) throw new Error("download_size_mismatch");
	const digest = sha256.create();
	const reader = file.stream().getReader();
	try { for (;;) { const { value, done } = await reader.read(); if (done) break; digest.update(value); } } finally { reader.releaseLock(); }
	if (bytesToHex(digest.digest()) !== hash) throw new Error("download_checksum_mismatch");
}

/** Explicit download streams to private staging. Only verified originals become
 * available; the caller commits the campaign after every referenced file passes. */
export async function downloadConnectedOriginals({ state, signal, onProgress }: {
	state: StudioState; signal: AbortSignal; onProgress: (value: string) => void;
}) {
	const { assets } = await connectedApi<{ assets: ConnectedAsset[] }>(`/campaigns/${state.campaign.id}/assets?revision=${state.campaign.revision}&snapshot_sha256=${snapshotHash(state)}`);
	const existing = await listMediaAssets(state.campaign.id);
	for (const [index, asset] of assets.entries()) {
		signal.throwIfAborted();
		onProgress(`${index + 1}/${assets.length}`);
		if (!/^[a-f0-9]{64}$/.test(asset.asset_hash) || asset.byte_length <= 0 || asset.byte_length > 1024 * 1024 * 1024) throw new Error("download_limits");
		const local = existing.find((item) => item.asset_hash === asset.asset_hash);
		if (local) { await verifyFile({ file: await fileForPath(local.original_path), hash: asset.asset_hash, size: asset.byte_length }); continue; }
		const path = `staging/download-${crypto.randomUUID()}.part`;
		let stagedPath: string | undefined;
		try {
			const response = await fetch(asset.url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
			if (!response.ok || !response.body) throw new Error("original_download_failed");
			const output = await (await fileHandleForPath({ path, create: true })).createWritable();
			let count = 0;
			try {
				const reader = response.body.getReader();
				try { for (;;) { const { value, done } = await reader.read(); if (done) break; count += value.length; if (count > asset.byte_length) { await reader.cancel(); throw new Error("download_limits"); } await output.write(value); } } finally { reader.releaseLock(); }
				await output.close();
			} catch (error) { await output.abort().catch(() => undefined); throw error; }
			const file = await fileForPath(path);
			await verifyFile({ file, hash: asset.asset_hash, size: asset.byte_length });
			const staged = await stageOriginal({ file, stagingId: crypto.randomUUID() }); stagedPath = staged.stagingPath;
			let probe: ProbeReport;
			if (staged.detectedMime === "image/png") {
				if (file.size > 8 * 1024 * 1024) throw new Error("logo_byte_limit");
				const value: unknown = JSON.parse(probeLogoPng(new Uint8Array(await file.arrayBuffer())));
				if (!value || typeof value !== "object" || !("width" in value) || typeof value.width !== "number" || !("height" in value) || typeof value.height !== "number") throw new Error("logo_probe_contract");
				probe = { asset_hash: asset.asset_hash, byte_length: file.size, declared_mime: asset.content_type, detected_mime: staged.detectedMime, width: value.width, height: value.height, duration_ticks: 0, fps_num: 0, fps_den: 1, has_video: false, has_audio: false, video_codec: null, audio_codec: null, can_decode: true };
			} else probe = await probeMediaFile({ file, assetHash: asset.asset_hash, declaredMime: asset.content_type, detectedMime: staged.detectedMime });
			const plan = planMediaDerivatives(probe);
			// Never replace a damaged existing content-addressed original.
			let old: File | undefined;
			try { old = await fileForPath(`originals/${asset.asset_hash}`); } catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
			if (old) await verifyFile({ file: old, hash: asset.asset_hash, size: asset.byte_length });
			const receipt = await commitStagedOriginalWithReceipt(staged);
			await verifyFile({ file: await fileForPath(receipt.path), hash: asset.asset_hash, size: asset.byte_length });
			await saveMediaAsset({ asset_id: crypto.randomUUID(), campaign_id: state.campaign.id, scene_id: state.campaign.master_sequence.scenes[0]?.id ?? "", asset_hash: asset.asset_hash, name: asset.asset_hash.slice(0, 12), declared_mime: asset.content_type, detected_mime: staged.detectedMime, byte_length: file.size, original_path: receipt.path, probe, plan, created_at: new Date().toISOString() });
		} finally { await removeArtifact(path).catch(() => undefined); if (stagedPath) await removeArtifact(stagedPath).catch(() => undefined); }
	}
}
