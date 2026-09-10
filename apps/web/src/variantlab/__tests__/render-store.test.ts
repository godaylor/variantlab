import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	PersistedRenderJob,
	RenderManifest,
} from "@variantlab/studio-contract";
import { indexedDB } from "fake-indexeddb";
import {
	listRenderArtifacts,
	listRenderJobs,
	resetRenderStoreForTest,
	saveRenderArtifact,
	saveRenderJob,
	succeededRenderKeys,
} from "../render-store";

Object.defineProperty(globalThis, "indexedDB", {
	configurable: true,
	value: indexedDB,
});

const manifest: RenderManifest = {
	schema_version: 1,
	engine_version: "variantlab-m7-v1",
	campaign_revision: 7,
	master_sequence_id: "sequence-m7",
	scenes: [
		{
			scene_id: "scene-a",
			scene_revision: 7,
			included: true,
			start_tick: 0,
			duration_ticks: 48_000,
		},
	],
	clips: [],
	sequence_duration_ticks: 48_000,
	variant_fingerprint: "f".repeat(64),
	canvas: { width: 1080, height: 1920 },
	fps_num: 30,
	fps_den: 1,
	safe_area: {
		top_basis_points: 0,
		right_basis_points: 0,
		bottom_basis_points: 0,
		left_basis_points: 0,
	},
	crop: {
		x_basis_points: 0,
		y_basis_points: 0,
		scale_basis_points: 10_000,
	},
	asset_hashes: [],
	font_revisions: [],
	fps_source: "master",
	audio_mix_source: "master",
};

function job({
	id,
	state,
}: {
	id: string;
	state: PersistedRenderJob["state"];
}): PersistedRenderJob {
	return {
		spec: {
			schema_version: 1,
			job_id: id,
			campaign_id: "campaign-m7",
			master_sequence_id: "sequence-m7",
			cell_id: `cell-${id}`,
			campaign_revision: 7,
			render_manifest_sha256: "m".repeat(64),
			preset: "webm_vp9_opus",
			filename: `${id}.webm`,
			destination: "browser_download",
			idempotency_key: `key-${id}`,
			engine_version: "variantlab-m7-v1",
		},
		state,
		phase: state === "succeeded" ? "complete" : "preflight",
		progress_milli: state === "succeeded" ? 1000 : 0,
		stale: false,
		resumable_local: true,
		attempt: {
			attempt: 1,
			started_at: null,
			finished_at: null,
			failure: null,
		},
		artifact_path: state === "succeeded" ? `renders/${id}.webm` : null,
		updated_at: "2026-09-03T00:00:00Z",
	};
}

describe("M7 persistent render queue", () => {
	beforeEach(resetRenderStoreForTest);
	afterEach(resetRenderStoreForTest);

	test("persists queued attempts and exposes succeeded idempotency keys", async () => {
		await saveRenderJob({
			job: job({ id: "queued", state: "queued" }),
			manifest,
		});
		await saveRenderJob({
			job: job({ id: "done", state: "succeeded" }),
			manifest,
		});
		expect(
			(await listRenderJobs("campaign-m7")).map((row) => row.job.state),
		).toEqual(["succeeded", "queued"]);
		expect(await succeededRenderKeys("campaign-m7")).toEqual(["key-done"]);
	});

	test("keeps distinct artifacts even when they share a frozen manifest checksum", async () => {
		const common = {
			campaign_id: "campaign-m7",
			campaign_revision: 7,
			artifact_path: "renders/shared.webm",
			idempotency_key: "key-shared",
			master_sequence_id: "sequence-main",
			destination: "browser_download",
			preset: "webm_vp9_opus",
			created_at: "2026-09-03T00:00:00Z",
			media_type: "video/webm",
			byte_length: 1024,
			sha256: "a".repeat(64),
			render_manifest_sha256: "b".repeat(64),
			timing: {
				duration_ticks: 48_000,
				frame_count: 30,
				audio_sample_count: 48_000,
				trailing_frame_duration_ticks: 1_600,
			},
		};
		await saveRenderArtifact({
			...common,
			id: "job-a",
			cell_id: "cell-a",
			filename: "a.webm",
			idempotency_key: "key-a",
		});
		await saveRenderArtifact({
			...common,
			id: "job-b",
			cell_id: "cell-b",
			filename: "b.webm",
			idempotency_key: "key-b",
		});
		expect(
			(await listRenderArtifacts("campaign-m7")).map((item) => item.id),
		).toEqual(["job-a", "job-b"]);
	});
});
