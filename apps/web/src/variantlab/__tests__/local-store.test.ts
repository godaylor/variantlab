import { describe, expect, mock, test } from "bun:test";
import "fake-indexeddb/auto";
import type {
	CommandEnvelope,
	PreparedCommit,
	PrepareResult,
	StudioState,
} from "@variantlab/studio-contract";

function hash(state: StudioState): string {
	return JSON.stringify(state, (key, value: unknown) => {
		if (
			["slots", "creative_sets", "slot_audit_events", "transcript_artifacts", "caption_tracks", "locale_profiles"].includes(key) &&
			Array.isArray(value) &&
			value.length === 0
		) return undefined;
		if (key === "font_manifest" && value === null) return undefined;
		return value;
	});
}

function applyEnvelope({
	state,
	envelope,
}: {
	state: StudioState;
	envelope: CommandEnvelope;
}): PrepareResult {
	const payload = envelope.payload;
	if (payload.command !== "rename_scene") {
		return { status: "no_op", reason: "test no-op", state };
	}
	const nextState: StudioState = {
		...state,
		campaign: {
			...state.campaign,
			revision: state.campaign.revision + 1,
			updated_at: envelope.issued_at,
			master_sequence: {
				...state.campaign.master_sequence,
				scenes: state.campaign.master_sequence.scenes.map((scene) =>
					scene.id === payload.scene_id
						? {
								...scene,
								name: payload.new_name,
								updated_at: envelope.issued_at,
							}
						: scene,
				),
			},
		},
	};
	const commit: PreparedCommit = {
		envelope,
		next_state: nextState,
		revision: nextState.campaign.revision,
		snapshot_hash: hash(nextState),
		label: "Rename scene",
		change_set: {
			changed_entities: ["scene:" + payload.scene_id],
			dirty_time_ranges: [],
			affected_variant_cells: [],
			invalidated_render_keys: [],
			warnings: [],
		},
	};
	return { status: "prepared", commit };
}

mock.module("../domain", () => ({
	snapshotHash: hash,
	prepareCommand: applyEnvelope,
}));

const {
	corruptNewestSnapshotForTest,
	createStoredCampaign,
	injectNextWriteFailure,
	recoverCampaign,
	savePreparedCommit,
	writeSnapshotForTest,
	writePreM4SnapshotForTest,
	enableConnectedSync, connectedOutbox, prepareConnectedSync, acknowledgeConnectedSync, installConnectedSnapshot,
} = await import("../local-store");

function state(campaignId: string): StudioState {
	const now = "2026-08-27T00:00:00.000Z";
	return {
		schema_version: 1,
		campaign: {
			id: campaignId,
			name: "Campaign",
			revision: 0,
			created_at: now,
			updated_at: now,
			imported_from: null,
			delivery_profiles: [],
			variant_cells: [],
			slots: [],
			creative_sets: [],
			slot_audit_events: [],
			transcript_artifacts: [],
			caption_tracks: [],
			locale_profiles: [],
			font_manifest: null,
			master_sequence: {
				id: "sequence-" + campaignId,
				scenes: [
					{
						id: "scene-a",
						name: "Scene A",
						created_at: now,
						updated_at: now,
						timeline: null,
					},
				],
			},
		},
		history: [],
		redo: [],
	};
}

function envelope(initial: StudioState): CommandEnvelope {
	const sceneScope = { kind: "scene", scene_id: "scene-a" } as const;
	const variantScope = { kind: "master" } as const;
	return {
		schema_version: 1,
		command_id: "command-" + initial.campaign.id,
		transaction_id: "transaction-" + initial.campaign.id,
		campaign_id: initial.campaign.id,
		master_sequence_id: initial.campaign.master_sequence.id,
		scene_scope: sceneScope,
		variant_scope: variantScope,
		history_scope: {
			campaign_id: initial.campaign.id,
			master_sequence_id: initial.campaign.master_sequence.id,
			scene_scope: sceneScope,
			variant_scope: variantScope,
		},
		base_revision: initial.campaign.revision,
		actor_id: "test",
		device_id: "test-device",
		issued_at: "2026-08-27T00:00:01.000Z",
		payload: {
			command: "rename_scene",
			scene_id: "scene-a",
			new_name: "Renamed",
		},
	};
}

describe("VariantLab durable local store", () => {
	test("sync outbox and journal commit atomically; pending requests survive reload and remote replacement is rejected", async () => {
		const initial = state("atomic-sync");
		await createStoredCampaign({ state: initial }); await enableConnectedSync(initial);
		const first = await prepareConnectedSync(initial.campaign.id);
		expect((await prepareConnectedSync(initial.campaign.id)).pending_request_id).toBe(first.pending_request_id);
		await acknowledgeConnectedSync({ campaignId: initial.campaign.id, requestId: first.pending_request_id!, receipt: { status: "synced", revision: 0, snapshot_sha256: hash(initial), branch_id: null, server_revision: null } });
		const result = applyEnvelope({ state: initial, envelope: envelope(initial) }); if (result.status !== "prepared") throw new Error("fixture");
		injectNextWriteFailure(); await expect(savePreparedCommit(result.commit)).rejects.toThrow();
		expect((await connectedOutbox(initial.campaign.id))?.commands).toHaveLength(0);
		await savePreparedCommit(result.commit);
		expect((await connectedOutbox(initial.campaign.id))?.commands).toHaveLength(1);
		await expect(installConnectedSnapshot(initial)).rejects.toThrow();
		expect((await recoverCampaign(initial.campaign.id)).state.campaign.revision).toBe(1);
		const pending = await prepareConnectedSync(initial.campaign.id);
		await acknowledgeConnectedSync({ campaignId: initial.campaign.id, requestId: pending.pending_request_id!, receipt: { status: "recovered_branch", revision: 1, snapshot_sha256: hash(result.commit.next_state), branch_id: "separate-branch", server_revision: 1 } });
		expect((await connectedOutbox(initial.campaign.id))?.commands).toHaveLength(1);
		expect((await connectedOutbox(initial.campaign.id))?.branch_id).toBe("separate-branch");
	});
	test("failed write stays dirty until the same idempotent commit is retried", async () => {
		const initial = state("failure-retry");
		await createStoredCampaign({ state: initial });
		const result = applyEnvelope({
			state: initial,
			envelope: envelope(initial),
		});
		if (result.status !== "prepared")
			throw new Error("Expected prepared commit");

		injectNextWriteFailure();
		await expect(savePreparedCommit(result.commit)).rejects.toThrow(
			"Injected quota failure",
		);
		expect((await recoverCampaign(initial.campaign.id)).state).toEqual(initial);

		await savePreparedCommit(result.commit);
		const recovered = await recoverCampaign(initial.campaign.id);
		expect(recovered.state.campaign.revision).toBe(1);
		expect(recovered.state.campaign.master_sequence.scenes[0]?.name).toBe(
			"Renamed",
		);
	});

	test("corrupt newest snapshot falls back and replays the valid journal", async () => {
		const initial = state("corrupt-fallback");
		await createStoredCampaign({ state: initial });
		const result = applyEnvelope({
			state: initial,
			envelope: envelope(initial),
		});
		if (result.status !== "prepared")
			throw new Error("Expected prepared commit");
		await savePreparedCommit(result.commit);
		await writeSnapshotForTest(result.commit.next_state);
		await corruptNewestSnapshotForTest(initial.campaign.id);

		const recovered = await recoverCampaign(initial.campaign.id);
		expect(recovered.fallbackUsed).toBe(true);
		expect(recovered.replayedEntries).toBe(1);
		expect(recovered.state.campaign.revision).toBe(1);
	});

	test("pre-M4 snapshot receives empty creative collections on recovery", async () => {
		const initial = state("pre-m4-collections");
		await writePreM4SnapshotForTest(initial);

		const recovered = await recoverCampaign(initial.campaign.id);
		expect(recovered.state.campaign.slots).toEqual([]);
		expect(recovered.state.campaign.creative_sets).toEqual([]);
		expect(recovered.state.campaign.slot_audit_events).toEqual([]);
		expect(recovered.state.campaign.transcript_artifacts).toEqual([]);
		expect(recovered.state.campaign.caption_tracks).toEqual([]);
		expect(recovered.state.campaign.locale_profiles).toEqual([]);
		expect(recovered.state.campaign.font_manifest).toBeNull();
		expect(recovered.state.campaign.revision).toBe(0);
	});
});
