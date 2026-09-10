import { probeLogoPng } from "variantlab-wasm";
import type { ProbeReport } from "@variantlab/studio-contract";
import { planMediaDerivatives } from "./domain";
import {
	stageOriginal,
	commitStagedOriginalWithReceipt,
	fileForPath,
	saveMediaAsset,
	removeArtifact,
	removeCommittedOriginalIfUnreferenced,
	type CommittedOriginalReceipt,
} from "./media-store";

/** Explicit local import. Never uploads, rewrites a legacy asset, or invents timing. */
export async function importLogo({
	file,
	campaignId,
	sceneId,
	assetId,
	stagingId,
	createdAt,
}: {
	file: File;
	campaignId: string;
	sceneId: string;
	assetId: string;
	stagingId: string;
	createdAt: string;
}): Promise<string> {
	if (file.size === 0 || file.size > 8 * 1024 * 1024)
		throw new Error("logo_byte_limit");
	const bytes = new Uint8Array(await file.arrayBuffer());
	const probe: unknown = JSON.parse(probeLogoPng(bytes));
	if (
		!probe ||
		typeof probe !== "object" ||
		!("sha256" in probe) ||
		typeof probe.sha256 !== "string" ||
		!("width" in probe) ||
		typeof probe.width !== "number" ||
		!("height" in probe) ||
		typeof probe.height !== "number"
	)
		throw new Error("logo_probe_contract");
	const report: ProbeReport = {
		asset_hash: probe.sha256,
		byte_length: file.size,
		declared_mime: file.type,
		detected_mime: "image/png",
		duration_ticks: 0,
		width: probe.width,
		height: probe.height,
		fps_num: 0,
		fps_den: 1,
		has_video: false,
		has_audio: false,
		video_codec: null,
		audio_codec: null,
		can_decode: true,
	};
	const plan = planMediaDerivatives(report);
	const staged = await stageOriginal({ file, stagingId });
	let receipt: CommittedOriginalReceipt | undefined;
	try {
		if (staged.assetHash !== probe.sha256)
			throw new Error("logo_checksum_mismatch");
		// An existing content-addressed original is immutable, including a damaged one.
		let existing: File | undefined;
		try {
			existing = await fileForPath(`originals/${probe.sha256}`);
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "NotFoundError"))
				throw error;
		}
		if (
			existing &&
			(existing.size !== file.size ||
				probeLogoPng(new Uint8Array(await existing.arrayBuffer())) !==
					probeLogoPng(bytes))
		)
			throw new Error("existing_logo_integrity");
		receipt = await commitStagedOriginalWithReceipt(staged);
		const durable = await fileForPath(receipt.path);
		if (
			durable.size !== file.size ||
			probeLogoPng(new Uint8Array(await durable.arrayBuffer())) !==
				probeLogoPng(bytes)
		)
			throw new Error("durable_logo_integrity");
		await saveMediaAsset({
			asset_id: assetId,
			campaign_id: campaignId,
			scene_id: sceneId,
			asset_hash: probe.sha256,
			name: file.name,
			declared_mime: file.type,
			detected_mime: "image/png",
			byte_length: file.size,
			original_path: receipt.path,
			probe: report,
			plan,
			created_at: createdAt,
		});
		return probe.sha256;
	} catch (error) {
		await removeArtifact(staged.stagingPath).catch(() => undefined);
		if (receipt) await removeCommittedOriginalIfUnreferenced(receipt);
		throw error;
	}
}
