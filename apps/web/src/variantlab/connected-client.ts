/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, variantlab/prefer-object-params -- generated contracts at the same-origin JSON boundary. */
import type { ConnectedSnapshot, ConnectedSyncReceipt } from "@variantlab/studio-contract";
import { snapshotHash } from "./domain";
import { acknowledgeConnectedSync, prepareConnectedSync } from "./local-store";

export async function connectedApi<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(`/api/variantlab${path}`, body === undefined ? {} : {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
	});
	const value: unknown = await response.json();
	if (!response.ok) {
		const error = value as { error?: { code?: string } };
		throw new Error(error.error?.code ?? `connected_${response.status}`);
	}
	return value as T;
}

export function deviceId(): string {
	let id = localStorage.getItem("variantlab:device");
	if (!id) { id = crypto.randomUUID(); localStorage.setItem("variantlab:device", id); }
	return id;
}

export function verifyConnectedSnapshot(value: ConnectedSnapshot) {
	if (snapshotHash(value.snapshot) !== value.snapshot_sha256) throw new Error("remote_snapshot_corrupt");
	return value.snapshot;
}

export async function flushConnectedSync(campaignId: string): Promise<ConnectedSyncReceipt> {
	const outbox = await prepareConnectedSync(campaignId);
	if (outbox.overflow) throw new Error("sync_outbox_full");
	const requestId = outbox.pending_request_id;
	if (!requestId) throw new Error("sync_request_missing");
	const receipt = await connectedApi<ConnectedSyncReceipt>(`/campaigns/${campaignId}/sync`, {
		schema_version: 1, request_id: requestId, device_id: deviceId(),
		base_revision: outbox.base_revision, base_sha256: outbox.base_sha256,
		initial_snapshot: outbox.initial_snapshot,
		commands: outbox.commands.slice(0, outbox.pending_commands_count),
	});
	await acknowledgeConnectedSync({ campaignId, requestId, receipt });
	// Changes made after enabling remain in the atomic journal/outbox, never folded
	// into a retried initial request with the same idempotency identity.
	if (outbox.initial_snapshot && outbox.commands.length) return flushConnectedSync(campaignId);
	return receipt;
}
