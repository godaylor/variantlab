/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IndexedDB sync records are written exclusively from generated Rust contracts; domain append validates them before mutation. */
import type {
	CommandEnvelope,
	PreparedCommit,
	StudioState,
	ConnectedSyncOutbox,
	ConnectedSyncReceipt,
} from "@variantlab/studio-contract";
import { prepareCommand, snapshotHash } from "./domain";
import { appendSyncOutbox, acknowledgeSyncOutbox } from "variantlab-wasm";

const DATABASE_NAME = "variantlab-studio-v1";
const DATABASE_VERSION = 2;
const SYNC_STORE = "sync-outbox";
const SNAPSHOT_INTERVAL = 50;
const JOURNAL_BYTE_LIMIT = 2 * 1024 * 1024;

const CAMPAIGNS_STORE = "campaigns";
const SNAPSHOTS_STORE = "snapshots";
const JOURNAL_STORE = "journal";
const LEGACY_IMPORTS_STORE = "legacy-imports";

type CampaignRecord = {
	id: string;
	name: string;
	latest_revision: number;
	updated_at: string;
};

type SnapshotRecord = {
	key: string;
	campaign_id: string;
	revision: number;
	state_json: string;
	checksum: string;
	created_at: string;
};

type JournalRecord = {
	key: string;
	campaign_id: string;
	revision: number;
	envelope: CommandEnvelope;
	expected_hash: string;
	bytes: number;
	created_at: string;
};

type LegacyImportRecord = {
	key: string;
	campaign_id: string;
	source_namespace: string;
	source_project_id: string;
	source_json: string;
	imported_at: string;
};

export type CampaignSummary = Pick<
	CampaignRecord,
	"id" | "name" | "latest_revision" | "updated_at"
>;

export type RecoveryResult = {
	state: StudioState;
	replayedEntries: number;
	discardedEntries: number;
	fallbackUsed: boolean;
};

export type DurableReceipt = {
	campaignId: string;
	revision: number;
	durationMs: number;
};

let failNextWrite = false;

export function injectNextWriteFailure(): void {
	failNextWrite = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCampaignRecord(value: unknown): value is CampaignRecord {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.latest_revision === "number" &&
		typeof value.updated_at === "string"
	);
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
	return (
		isRecord(value) &&
		typeof value.key === "string" &&
		typeof value.campaign_id === "string" &&
		typeof value.revision === "number" &&
		typeof value.state_json === "string" &&
		typeof value.checksum === "string" &&
		typeof value.created_at === "string"
	);
}

function isJournalRecord(value: unknown): value is JournalRecord {
	return (
		isRecord(value) &&
		typeof value.key === "string" &&
		typeof value.campaign_id === "string" &&
		typeof value.revision === "number" &&
		isRecord(value.envelope) &&
		typeof value.expected_hash === "string" &&
		typeof value.bytes === "number" &&
		typeof value.created_at === "string"
	);
}

function deleteRowsByCampaign({
	store,
	campaignId,
}: {
	store: IDBObjectStore;
	campaignId: string;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = store
			.index("campaign_id")
			.openCursor(IDBKeyRange.only(campaignId));
		request.addEventListener("success", () => {
			const cursor = request.result;
			if (!cursor) {
				resolve();
				return;
			}
			cursor.delete();
			cursor.continue();
		});
		request.addEventListener("error", () =>
			reject(request.error ?? new Error("IndexedDB cursor failed")),
		);
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve());
		transaction.addEventListener("abort", () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
		);
		transaction.addEventListener("error", () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed")),
		);
	});
}

function requestUnknown(request: IDBRequest): Promise<unknown> {
	return new Promise((resolve, reject) => {
		request.addEventListener("error", () => reject(request.error));
		request.addEventListener("success", () => {
			const value: unknown = request.result;
			resolve(value);
		});
	});
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.addEventListener("error", () => reject(request.error));
		request.addEventListener("success", () => resolve(request.result));
		request.addEventListener("upgradeneeded", () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(SYNC_STORE)) database.createObjectStore(SYNC_STORE, { keyPath: "campaign_id" });
			if (!database.objectStoreNames.contains(CAMPAIGNS_STORE)) {
				database.createObjectStore(CAMPAIGNS_STORE, { keyPath: "id" });
			}
			if (!database.objectStoreNames.contains(SNAPSHOTS_STORE)) {
				const store = database.createObjectStore(SNAPSHOTS_STORE, {
					keyPath: "key",
				});
				store.createIndex("campaign_id", "campaign_id");
			}
			if (!database.objectStoreNames.contains(JOURNAL_STORE)) {
				const store = database.createObjectStore(JOURNAL_STORE, {
					keyPath: "key",
				});
				store.createIndex("campaign_id", "campaign_id");
			}
			if (!database.objectStoreNames.contains(LEGACY_IMPORTS_STORE)) {
				const store = database.createObjectStore(LEGACY_IMPORTS_STORE, {
					keyPath: "key",
				});
				store.createIndex("campaign_id", "campaign_id");
			}
		});
	});
}

async function getCampaignRows(): Promise<CampaignRecord[]> {
	const database = await openDatabase();
	const transaction = database.transaction(CAMPAIGNS_STORE, "readonly");
	const value = await requestUnknown(
		transaction.objectStore(CAMPAIGNS_STORE).getAll(),
	);
	await transactionComplete(transaction);
	database.close();
	return Array.isArray(value) ? value.filter(isCampaignRecord) : [];
}

async function getSnapshotRows(campaignId: string): Promise<SnapshotRecord[]> {
	const database = await openDatabase();
	const transaction = database.transaction(SNAPSHOTS_STORE, "readonly");
	const request = transaction
		.objectStore(SNAPSHOTS_STORE)
		.index("campaign_id")
		.getAll(IDBKeyRange.only(campaignId));
	const value = await requestUnknown(request);
	await transactionComplete(transaction);
	database.close();
	return Array.isArray(value) ? value.filter(isSnapshotRecord) : [];
}

async function getJournalRows(campaignId: string): Promise<JournalRecord[]> {
	const database = await openDatabase();
	const transaction = database.transaction(JOURNAL_STORE, "readonly");
	const request = transaction
		.objectStore(JOURNAL_STORE)
		.index("campaign_id")
		.getAll(IDBKeyRange.only(campaignId));
	const value = await requestUnknown(request);
	await transactionComplete(transaction);
	database.close();
	return Array.isArray(value) ? value.filter(isJournalRecord) : [];
}

export async function listCampaigns(): Promise<CampaignSummary[]> {
	const rows = await getCampaignRows();
	return rows
		.toSorted((left, right) => right.updated_at.localeCompare(left.updated_at))
		.map((row) => ({
			id: row.id,
			name: row.name,
			latest_revision: row.latest_revision,
			updated_at: row.updated_at,
		}));
}

export async function connectedOutbox(campaignId: string): Promise<ConnectedSyncOutbox | null> {
	const database = await openDatabase();
	try {
		const transaction = database.transaction(SYNC_STORE, "readonly");
		const value = await requestUnknown(transaction.objectStore(SYNC_STORE).get(campaignId));
		return value ? value as ConnectedSyncOutbox : null;
	} finally { database.close(); }
}

export async function enableConnectedSync(state: StudioState): Promise<void> {
	const database = await openDatabase();
	try {
		const transaction = database.transaction([CAMPAIGNS_STORE, SYNC_STORE], "readwrite");
		const done = transactionComplete(transaction);
		const row = await requestUnknown(transaction.objectStore(CAMPAIGNS_STORE).get(state.campaign.id));
		if (!isCampaignRecord(row) || row.latest_revision !== state.campaign.revision) { transaction.abort(); await done; return; }
		const existing = await requestUnknown(transaction.objectStore(SYNC_STORE).get(state.campaign.id));
		if (!existing) transaction.objectStore(SYNC_STORE).put({ campaign_id: state.campaign.id, base_revision: state.campaign.revision, base_sha256: snapshotHash(state), commands: [], pending_request_id: null, pending_commands_count: 0, branch_id: null, overflow: false, initial_snapshot: state } satisfies ConnectedSyncOutbox);
		await done;
	} finally { database.close(); }
}

export async function prepareConnectedSync(campaignId: string): Promise<ConnectedSyncOutbox> {
	const database = await openDatabase();
	try {
		const transaction = database.transaction(SYNC_STORE, "readwrite");
		const done = transactionComplete(transaction);
		const value = await requestUnknown(transaction.objectStore(SYNC_STORE).get(campaignId));
		if (!value) throw new Error("sync_not_enabled");
		const outbox = value as ConnectedSyncOutbox;
		if (!outbox.pending_request_id) {
			outbox.pending_request_id = crypto.randomUUID();
			outbox.pending_commands_count = outbox.initial_snapshot ? 0 : outbox.commands.length;
			transaction.objectStore(SYNC_STORE).put(outbox);
		}
		await done; return outbox;
	} finally { database.close(); }
}

export async function acknowledgeConnectedSync({ campaignId, requestId, receipt }: { campaignId:string; requestId:string; receipt:ConnectedSyncReceipt }): Promise<void> {
	const database = await openDatabase();
	try {
		const transaction = database.transaction(SYNC_STORE, "readwrite");
		const done = transactionComplete(transaction);
		const value = await requestUnknown(transaction.objectStore(SYNC_STORE).get(campaignId));
		if (value) {
			transaction.objectStore(SYNC_STORE).put(JSON.parse(acknowledgeSyncOutbox(JSON.stringify(value), requestId, JSON.stringify(receipt))));
		}
		await done;
	} finally { database.close(); }
}

/** Incoming state becomes visible only after hash verification and durable commit.
 * A local pending command/branch prevents replacement, including during download. */
export async function installConnectedSnapshot(state: StudioState): Promise<void> {
	const checksum = snapshotHash(state);
	const database = await openDatabase();
	try {
		const transaction = database.transaction([CAMPAIGNS_STORE, SNAPSHOTS_STORE, JOURNAL_STORE, SYNC_STORE], "readwrite");
		const done = transactionComplete(transaction);
		const record = await requestUnknown(transaction.objectStore(CAMPAIGNS_STORE).get(state.campaign.id));
		const value = await requestUnknown(transaction.objectStore(SYNC_STORE).get(state.campaign.id));
		const outbox = value as ConnectedSyncOutbox | undefined;
		if (record && (!outbox || outbox.commands.length || outbox.initial_snapshot || outbox.branch_id || outbox.overflow)) { transaction.abort(); await done; return; }
		if (isCampaignRecord(record) && (record.latest_revision > state.campaign.revision || (record.latest_revision === state.campaign.revision && outbox?.base_sha256 !== checksum))) { transaction.abort(); await done; return; }
		transaction.objectStore(SNAPSHOTS_STORE).put({ key:[state.campaign.id,state.campaign.revision].join(":"),campaign_id:state.campaign.id,revision:state.campaign.revision,state_json:JSON.stringify(state),checksum,created_at:state.campaign.updated_at } satisfies SnapshotRecord);
		transaction.objectStore(CAMPAIGNS_STORE).put({id:state.campaign.id,name:state.campaign.name,latest_revision:state.campaign.revision,updated_at:state.campaign.updated_at} satisfies CampaignRecord);
		transaction.objectStore(SYNC_STORE).put({campaign_id:state.campaign.id,base_revision:state.campaign.revision,base_sha256:checksum,commands:[],pending_request_id:null,pending_commands_count:0,branch_id:null,overflow:false,initial_snapshot:null} satisfies ConnectedSyncOutbox);
		await deleteRowsByCampaign({store:transaction.objectStore(JOURNAL_STORE),campaignId:state.campaign.id});
		await done;
	} finally { database.close(); }
}

export async function createStoredCampaign({
	state,
	legacyImport,
}: {
	state: StudioState;
	legacyImport?: Omit<LegacyImportRecord, "key" | "campaign_id">;
}): Promise<void> {
	const stateJson = JSON.stringify(state);
	const checksum = snapshotHash(state);
	const database = await openDatabase();
	const storeNames = legacyImport
		? [CAMPAIGNS_STORE, SNAPSHOTS_STORE, LEGACY_IMPORTS_STORE]
		: [CAMPAIGNS_STORE, SNAPSHOTS_STORE];
	const transaction = database.transaction(storeNames, "readwrite");
	transaction.objectStore(CAMPAIGNS_STORE).put({
		id: state.campaign.id,
		name: state.campaign.name,
		latest_revision: state.campaign.revision,
		updated_at: state.campaign.updated_at,
	} satisfies CampaignRecord);
	transaction.objectStore(SNAPSHOTS_STORE).put({
		key: [state.campaign.id, state.campaign.revision].join(":"),
		campaign_id: state.campaign.id,
		revision: state.campaign.revision,
		state_json: stateJson,
		checksum,
		created_at: state.campaign.updated_at,
	} satisfies SnapshotRecord);
	if (legacyImport) {
		transaction.objectStore(LEGACY_IMPORTS_STORE).put({
			...legacyImport,
			key: [state.campaign.id, legacyImport.source_project_id].join(":"),
			campaign_id: state.campaign.id,
		} satisfies LegacyImportRecord);
	}
	await transactionComplete(transaction);
	database.close();
}

export async function deleteStoredCampaign(campaignId: string): Promise<void> {
	const database = await openDatabase();
	const transaction = database.transaction(
		[CAMPAIGNS_STORE, SNAPSHOTS_STORE, JOURNAL_STORE, LEGACY_IMPORTS_STORE],
		"readwrite",
	);
	transaction.objectStore(CAMPAIGNS_STORE).delete(campaignId);
	await Promise.all([
		deleteRowsByCampaign({
			store: transaction.objectStore(SNAPSHOTS_STORE),
			campaignId,
		}),
		deleteRowsByCampaign({
			store: transaction.objectStore(JOURNAL_STORE),
			campaignId,
		}),
		deleteRowsByCampaign({
			store: transaction.objectStore(LEGACY_IMPORTS_STORE),
			campaignId,
		}),
	]);
	await transactionComplete(transaction);
	database.close();
}

export async function savePreparedCommit(
	commit: PreparedCommit,
): Promise<DurableReceipt> {
	const startedAt = performance.now();
	if (failNextWrite) {
		failNextWrite = false;
		throw new DOMException("Injected quota failure", "QuotaExceededError");
	}
	const database = await openDatabase();
	const transaction = database.transaction(
		[CAMPAIGNS_STORE, JOURNAL_STORE, SYNC_STORE],
		"readwrite",
	);
	const envelopeJson = JSON.stringify(commit.envelope);
	const syncRequest = transaction.objectStore(SYNC_STORE).get(commit.envelope.campaign_id);
	syncRequest.addEventListener("success", () => {
		const outbox = syncRequest.result as ConnectedSyncOutbox | undefined;
		if (!outbox) return;
		try { transaction.objectStore(SYNC_STORE).put(JSON.parse(appendSyncOutbox(JSON.stringify(outbox), envelopeJson))); }
		catch { transaction.abort(); }
	});
	transaction.objectStore(JOURNAL_STORE).put({
		key: [
			commit.envelope.campaign_id,
			commit.revision,
			commit.envelope.command_id,
		].join(":"),
		campaign_id: commit.envelope.campaign_id,
		revision: commit.revision,
		envelope: commit.envelope,
		expected_hash: commit.snapshot_hash,
		bytes: new TextEncoder().encode(envelopeJson).byteLength,
		created_at: commit.envelope.issued_at,
	} satisfies JournalRecord);
	transaction.objectStore(CAMPAIGNS_STORE).put({
		id: commit.next_state.campaign.id,
		name: commit.next_state.campaign.name,
		latest_revision: commit.revision,
		updated_at: commit.next_state.campaign.updated_at,
	} satisfies CampaignRecord);
	await transactionComplete(transaction);
	database.close();

	void compactIfNeeded(commit);
	return {
		campaignId: commit.envelope.campaign_id,
		revision: commit.revision,
		durationMs: performance.now() - startedAt,
	};
}

function isStudioState(value: unknown): value is StudioState {
	return (
		isRecord(value) &&
		isRecord(value.campaign) &&
		typeof value.schema_version === "number" &&
		typeof value.campaign.id === "string" &&
		typeof value.campaign.revision === "number" &&
		Array.isArray(value.history) &&
		Array.isArray(value.redo)
	);
}

function studioStateFromUnknown(value: unknown): StudioState {
	if (!isStudioState(value)) {
		throw new Error(
			"Snapshot does not match the generated StudioState contract",
		);
	}
	return {
		...value,
		campaign: {
			...value.campaign,
			slots: Array.isArray(value.campaign.slots) ? value.campaign.slots : [],
			creative_sets: Array.isArray(value.campaign.creative_sets)
				? value.campaign.creative_sets
				: [],
			slot_audit_events: Array.isArray(value.campaign.slot_audit_events)
				? value.campaign.slot_audit_events
				: [],
			transcript_artifacts: Array.isArray(value.campaign.transcript_artifacts)
				? value.campaign.transcript_artifacts
				: [],
			caption_tracks: Array.isArray(value.campaign.caption_tracks)
				? value.campaign.caption_tracks
				: [],
			locale_profiles: Array.isArray(value.campaign.locale_profiles)
				? value.campaign.locale_profiles
				: [],
			font_manifest: value.campaign.font_manifest ?? null,
		},
	};
}

export async function recoverCampaign(
	campaignId: string,
): Promise<RecoveryResult> {
	const snapshots = (await getSnapshotRows(campaignId)).toSorted(
		(left, right) => right.revision - left.revision,
	);
	let state: StudioState | null = null;
	let snapshotRevision = -1;
	let invalidSnapshots = 0;
	for (const snapshot of snapshots) {
		try {
			const parsed: unknown = JSON.parse(snapshot.state_json);
			const candidate = studioStateFromUnknown(parsed);
			if (snapshotHash(candidate) !== snapshot.checksum) {
				invalidSnapshots += 1;
				continue;
			}
			state = candidate;
			snapshotRevision = snapshot.revision;
			break;
		} catch {
			invalidSnapshots += 1;
		}
	}
	if (!state) {
		throw new Error("No checksum-valid campaign snapshot is available");
	}

	const entries = (await getJournalRows(campaignId))
		.filter((entry) => entry.revision > snapshotRevision)
		.toSorted((left, right) => left.revision - right.revision);
	let replayedEntries = 0;
	for (const entry of entries) {
		try {
			const result = prepareCommand({ state, envelope: entry.envelope });
			if (result.status !== "prepared") break;
			if (result.commit.snapshot_hash !== entry.expected_hash) break;
			state = result.commit.next_state;
			replayedEntries += 1;
		} catch {
			break;
		}
	}
	return {
		state,
		replayedEntries,
		discardedEntries: entries.length - replayedEntries,
		fallbackUsed: invalidSnapshots > 0,
	};
}

type SnapshotWorkerResponse =
	| { ok: true; hash: string; bytes: number }
	| { ok: false; error: string };

function isSnapshotWorkerResponse(
	value: unknown,
): value is SnapshotWorkerResponse {
	return (
		isRecord(value) &&
		typeof value.ok === "boolean" &&
		(value.ok
			? typeof value.hash === "string" && typeof value.bytes === "number"
			: typeof value.error === "string")
	);
}

async function prepareSnapshotInWorker({
	stateJson,
	expectedHash,
}: {
	stateJson: string;
	expectedHash: string;
}): Promise<SnapshotWorkerResponse> {
	const worker = new Worker(new URL("./snapshot-worker.ts", import.meta.url));
	return new Promise((resolve, reject) => {
		worker.addEventListener("error", () => {
			worker.terminate();
			reject(new Error("Snapshot worker failed"));
		});
		worker.addEventListener("message", (event: MessageEvent<unknown>) => {
			worker.terminate();
			if (!isSnapshotWorkerResponse(event.data)) {
				reject(new Error("Snapshot worker returned an invalid response"));
				return;
			}
			resolve(event.data);
		});
		worker.postMessage({ stateJson, expectedHash });
	});
}

async function compactIfNeeded(commit: PreparedCommit): Promise<void> {
	const entries = await getJournalRows(commit.envelope.campaign_id);
	const journalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
	if (entries.length < SNAPSHOT_INTERVAL && journalBytes < JOURNAL_BYTE_LIMIT) {
		return;
	}
	const stateJson = JSON.stringify(commit.next_state);
	const prepared = await prepareSnapshotInWorker({
		stateJson,
		expectedHash: commit.snapshot_hash,
	});
	if (!prepared.ok) {
		console.error("[variantlab] Snapshot compaction rejected:", prepared.error);
		return;
	}

	const database = await openDatabase();
	const transaction = database.transaction(
		[SNAPSHOTS_STORE, JOURNAL_STORE],
		"readwrite",
	);
	transaction.objectStore(SNAPSHOTS_STORE).put({
		key: [commit.envelope.campaign_id, commit.revision].join(":"),
		campaign_id: commit.envelope.campaign_id,
		revision: commit.revision,
		state_json: stateJson,
		checksum: prepared.hash,
		created_at: commit.envelope.issued_at,
	} satisfies SnapshotRecord);
	const journalStore = transaction.objectStore(JOURNAL_STORE);
	for (const entry of entries) {
		if (entry.revision <= commit.revision) journalStore.delete(entry.key);
	}
	await transactionComplete(transaction);
	database.close();
}

export async function storeLegacyImport({
	campaignId,
	sourceProjectId,
	source,
	importedAt,
}: {
	campaignId: string;
	sourceProjectId: string;
	source: unknown;
	importedAt: string;
}): Promise<void> {
	const database = await openDatabase();
	const transaction = database.transaction(LEGACY_IMPORTS_STORE, "readwrite");
	transaction.objectStore(LEGACY_IMPORTS_STORE).put({
		key: [campaignId, sourceProjectId].join(":"),
		campaign_id: campaignId,
		source_namespace: "video-editor-projects",
		source_project_id: sourceProjectId,
		source_json: JSON.stringify(source),
		imported_at: importedAt,
	} satisfies LegacyImportRecord);
	await transactionComplete(transaction);
	database.close();
}

export async function corruptNewestSnapshotForTest(
	campaignId: string,
): Promise<void> {
	const snapshots = (await getSnapshotRows(campaignId)).toSorted(
		(left, right) => right.revision - left.revision,
	);
	const newest = snapshots[0];
	if (!newest) return;
	const database = await openDatabase();
	const transaction = database.transaction(SNAPSHOTS_STORE, "readwrite");
	transaction.objectStore(SNAPSHOTS_STORE).put({
		...newest,
		checksum: "corrupt-checksum",
	});
	await transactionComplete(transaction);
	database.close();
}

export async function writeSnapshotForTest(state: StudioState): Promise<void> {
	const database = await openDatabase();
	const transaction = database.transaction(SNAPSHOTS_STORE, "readwrite");
	transaction.objectStore(SNAPSHOTS_STORE).put({
		key: [state.campaign.id, state.campaign.revision].join(":"),
		campaign_id: state.campaign.id,
		revision: state.campaign.revision,
		state_json: JSON.stringify(state),
		checksum: snapshotHash(state),
		created_at: state.campaign.updated_at,
	} satisfies SnapshotRecord);
	await transactionComplete(transaction);
	database.close();
}

export async function writePreM4SnapshotForTest(
	state: StudioState,
): Promise<void> {
	const stateJson = JSON.stringify(state, (key, value: unknown) =>
		[
			"slots",
			"creative_sets",
			"slot_audit_events",
			"transcript_artifacts",
			"caption_tracks",
			"locale_profiles",
			"font_manifest",
		].includes(key)
			? undefined
			: value,
	);
	const parsed: unknown = JSON.parse(stateJson);
	const normalized = studioStateFromUnknown(parsed);
	const database = await openDatabase();
	const transaction = database.transaction(SNAPSHOTS_STORE, "readwrite");
	transaction.objectStore(SNAPSHOTS_STORE).put({
		key: [state.campaign.id, state.campaign.revision].join(":"),
		campaign_id: state.campaign.id,
		revision: state.campaign.revision,
		state_json: stateJson,
		checksum: snapshotHash(normalized),
		created_at: state.campaign.updated_at,
	} satisfies SnapshotRecord);
	await transactionComplete(transaction);
	database.close();
}

