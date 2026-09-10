import { describe, expect, test } from "bun:test";
import type { PersistedRenderJob } from "@variantlab/studio-contract";
import {
	isCurrentRenderPreflight,
	renderFailureAction,
	renderJobControls,
	renderJobPhaseLabel,
	renderPreflightToken,
	selectExactBatchArtifacts,
	updateLocalCellSelection,
} from "../render-package-ui";
import type { StoredRenderArtifact } from "../render-store";

function job({
	state,
	retryable = false,
	stale = false,
}: {
	state: PersistedRenderJob["state"];
	retryable?: boolean;
	stale?: boolean;
}): PersistedRenderJob {
	return {
		spec: {
			schema_version: 1,
			job_id: "job",
			campaign_id: "campaign",
			master_sequence_id: "sequence",
			cell_id: "cell",
			campaign_revision: 7,
			render_manifest_sha256: "a".repeat(64),
			preset: "webm_vp9_opus",
			filename: "cell.webm",
			destination: "browser_download",
			idempotency_key: "key",
			engine_version: "variantlab-m7-v1",
		},
		state,
		phase: state === "succeeded" ? "complete" : "rendering",
		progress_milli: state === "succeeded" ? 1000 : 500,
		stale: stale,
		resumable_local: true,
		attempt: {
			attempt: 1,
			started_at: null,
			finished_at: null,
			failure:
				state === "failed"
					? {
							code: "worker_terminated",
							message: "worker stopped",
							action: "Retry failed",
							retryable: retryable,
						}
					: null,
		},
		artifact_path: null,
		updated_at: "2026-09-03T00:00:00Z",
	};
}

describe("M7 render package interaction presentation", () => {
	test("offers cancel only for active work and retry only for retryable failures", () => {
		expect(renderJobControls(job({ state: "running" }))).toEqual({
			canCancel: true,
			canRetryFailed: false,
		});
		expect(
			renderJobControls(job({ state: "failed", retryable: true })),
		).toEqual({
			canCancel: false,
			canRetryFailed: true,
		});
		expect(
			renderJobControls(job({ state: "failed", retryable: false })),
		).toEqual({
			canCancel: false,
			canRetryFailed: false,
		});
	});

	test("does not describe stale output as current verified output", () => {
		expect(renderJobPhaseLabel(job({ state: "succeeded" }))).toBe(
			"succeeded · verified",
		);
		expect(renderJobPhaseLabel(job({ state: "succeeded", stale: true }))).toBe(
			"succeeded · stale revision",
		);
	});

	test("keyboard checkbox selection remains stable at the local eight-cell UI boundary", () => {
		const eight = Array.from({ length: 8 }, (_, index) => `cell-${index}`);
		expect(
			updateLocalCellSelection({
				current: eight,
				cellId: "cell-9",
				checked: true,
			}),
		).toEqual(eight);
		expect(
			updateLocalCellSelection({
				current: eight,
				cellId: "cell-2",
				checked: false,
			}),
		).not.toContain("cell-2");
	});
	test("invalidates READY for every request dimension and rejects stale enqueue tokens", () => {
		const base = {
			cellId: "cell-a",
			campaignRevision: 7,
			preset: "webm_vp9_opus",
			manifestSha256: "a".repeat(64),
			idempotencyKey: "key-a",
			filename: "a.webm",
			destination: "browser_download",
		};
		const token = renderPreflightToken({
			requests: [base],
			requiredBytes: 100,
		});
		expect(
			isCurrentRenderPreflight({ preparedToken: token, currentToken: token }),
		).toBe(true);
		for (const changed of [
			{ ...base, cellId: "cell-b" },
			{ ...base, campaignRevision: 8 },
			{ ...base, preset: "other" },
			{ ...base, manifestSha256: "b".repeat(64) },
			{ ...base, filename: "renamed.webm" },
			{ ...base, destination: "user_granted_directory" },
		]) {
			const currentToken = renderPreflightToken({
				requests: [changed],
				requiredBytes: 100,
			});
			expect(
				isCurrentRenderPreflight({ preparedToken: token, currentToken }),
			).toBe(false);
		}
		expect(
			isCurrentRenderPreflight({
				preparedToken: token,
				currentToken: renderPreflightToken({
					requests: [base],
					requiredBytes: 101,
				}),
			}),
		).toBe(false);
	});

	test("selects exactly one artifact for the requested revision and never mixes cells", () => {
		const artifact = ({
			id,
			cell,
			revision,
			manifest,
			key,
		}: {
			id: string;
			cell: string;
			revision: number;
			manifest: string;
			key: string;
		}): StoredRenderArtifact => ({
			id,
			campaign_id: "campaign",
			campaign_revision: revision,
			master_sequence_id: "sequence",
			cell_id: cell,
			preset: "webm_vp9_opus",
			filename: `${cell}.webm`,
			destination: "browser_download",
			artifact_path: `renders/${id}.webm`,
			idempotency_key: key,
			created_at: "2026-09-03T00:00:00Z",
			media_type: "video/webm",
			byte_length: 1,
			sha256: "c".repeat(64),
			render_manifest_sha256: manifest,
			timing: {
				duration_ticks: 48_000,
				frame_count: 30,
				audio_sample_count: 48_000,
				trailing_frame_duration_ticks: 1_600,
			},
		});
		const revisionA = artifact({
			id: "a",
			cell: "cell-a",
			revision: 7,
			manifest: "a".repeat(64),
			key: "key-a",
		});
		const revisionB = artifact({
			id: "b",
			cell: "cell-a",
			revision: 8,
			manifest: "b".repeat(64),
			key: "key-b",
		});
		const requestA = {
			cellId: "cell-a",
			campaignRevision: 7,
			preset: "webm_vp9_opus",
			manifestSha256: "a".repeat(64),
			idempotencyKey: "key-a",
			filename: "cell-a.webm",
			destination: "browser_download",
		};
		expect(
			selectExactBatchArtifacts({
				artifacts: [revisionA, revisionB],
				requests: [requestA],
			}),
		).toEqual([revisionA]);
		expect(
			selectExactBatchArtifacts({
				artifacts: [revisionA, revisionB],
				requests: [requestA, requestA],
			}),
		).toBeNull();
		expect(
			selectExactBatchArtifacts({
				artifacts: [revisionA, { ...revisionA, id: "duplicate" }],
				requests: [requestA],
			}),
		).toBeNull();
	});

	test("maps storage, corrupt source, and codec failures to distinct actions", () => {
		expect(renderFailureAction("out_of_space")).toContain("Free storage");
		expect(renderFailureAction("corrupt_source")).toContain("Relink or repair");
		expect(renderFailureAction("unsupported_codec")).toContain(
			"supported codec",
		);
	});
});
