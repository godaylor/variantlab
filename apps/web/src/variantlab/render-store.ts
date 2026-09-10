import type {
	DeliverableArtifact,
	PersistedRenderJob,
	RenderManifest,
} from "@variantlab/studio-contract";
import { fileForPath } from "./media-store";

const DATABASE_NAME = "variantlab-render-v1";
const DATABASE_VERSION = 2;
const JOBS_STORE = "render-jobs";
const ARTIFACTS_STORE = "render-artifacts-v2";

type RenderJobRecord = {
	id: string;
	campaign_id: string;
	idempotency_key: string;
	job: PersistedRenderJob;
	manifest: RenderManifest;
};

export type StoredRenderArtifact = DeliverableArtifact & {
	id: string;
	campaign_id: string;
	artifact_path: string;
	idempotency_key: string;
	master_sequence_id: string;
	destination: string;
	created_at: string;
};

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result));
		request.addEventListener("error", () =>
			reject(request.error ?? new Error("Render database request failed")),
		);
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve());
		transaction.addEventListener("abort", () =>
			reject(
				transaction.error ?? new Error("Render database transaction aborted"),
			),
		);
		transaction.addEventListener("error", () =>
			reject(
				transaction.error ?? new Error("Render database transaction failed"),
			),
		);
	});
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.addEventListener("upgradeneeded", () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(JOBS_STORE)) {
				const store = database.createObjectStore(JOBS_STORE, { keyPath: "id" });
				store.createIndex("by-campaign", "campaign_id");
				store.createIndex("by-idempotency", "idempotency_key", {
					unique: true,
				});
			}
			if (!database.objectStoreNames.contains(ARTIFACTS_STORE)) {
				const store = database.createObjectStore(ARTIFACTS_STORE, {
					keyPath: "id",
				});
				store.createIndex("by-campaign", "campaign_id");
			}
		});
		request.addEventListener("success", () => resolve(request.result));
		request.addEventListener("error", () =>
			reject(request.error ?? new Error("Could not open render database")),
		);
	});
}

export async function saveRenderJob({
	job,
	manifest,
}: {
	job: PersistedRenderJob;
	manifest: RenderManifest;
}): Promise<void> {
	const database = await openDatabase();
	const transaction = database.transaction(JOBS_STORE, "readwrite");
	transaction.objectStore(JOBS_STORE).put({
		id: job.spec.job_id,
		campaign_id: job.spec.campaign_id,
		idempotency_key: job.spec.idempotency_key,
		job,
		manifest,
	} satisfies RenderJobRecord);
	await transactionComplete(transaction);
	database.close();
}

export async function listRenderJobs(
	campaignId: string,
): Promise<Array<{ job: PersistedRenderJob; manifest: RenderManifest }>> {
	const database = await openDatabase();
	const transaction = database.transaction(JOBS_STORE, "readonly");
	const rows = await requestValue(
		transaction.objectStore(JOBS_STORE).index("by-campaign").getAll(campaignId),
	);
	await transactionComplete(transaction);
	database.close();
	// IndexedDB structured-clone values are not typed by lib.dom.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (rows as RenderJobRecord[])
		.toSorted((left, right) => left.id.localeCompare(right.id))
		.map(({ job, manifest }) => ({ job, manifest }));
}

export async function succeededRenderKeys(
	campaignId: string,
): Promise<string[]> {
	return (await listRenderJobs(campaignId))
		.filter(({ job }) => job.state === "succeeded")
		.map(({ job }) => job.spec.idempotency_key)
		.toSorted();
}

export async function saveRenderArtifact(
	artifact: StoredRenderArtifact,
): Promise<void> {
	const database = await openDatabase();
	const transaction = database.transaction(ARTIFACTS_STORE, "readwrite");
	transaction.objectStore(ARTIFACTS_STORE).put(artifact);
	await transactionComplete(transaction);
	database.close();
}

export async function listRenderArtifacts(
	campaignId: string,
): Promise<StoredRenderArtifact[]> {
	const database = await openDatabase();
	const transaction = database.transaction(ARTIFACTS_STORE, "readonly");
	const rows = await requestValue(
		transaction
			.objectStore(ARTIFACTS_STORE)
			.index("by-campaign")
			.getAll(campaignId),
	);
	await transactionComplete(transaction);
	database.close();
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (rows as StoredRenderArtifact[]).toSorted((left, right) =>
		left.filename.localeCompare(right.filename),
	);
}

export async function storageCapacity(requiredBytes: number): Promise<{
	availableBytes: number;
	requiredBytes: number;
	opfsSupported: boolean;
}> {
	const estimate = await navigator.storage.estimate();
	const available =
		typeof estimate.quota === "number" && typeof estimate.usage === "number"
			? Math.max(0, estimate.quota - estimate.usage)
			: 0;
	return {
		availableBytes: available,
		requiredBytes,
		opfsSupported: typeof navigator.storage.getDirectory === "function",
	};
}

export async function copyArtifactToDirectory({
	artifactPath,
	filename,
	directory,
}: {
	artifactPath: string;
	filename: string;
	directory: FileSystemDirectoryHandle;
}): Promise<void> {
	const source = await fileForPath(artifactPath);
	const target = await directory.getFileHandle(filename, { create: true });
	const writable = await target.createWritable({ keepExistingData: false });
	try {
		await source.stream().pipeTo(writable);
	} catch (error) {
		await writable.abort(error).catch(() => undefined);
		throw error;
	}
}

export async function downloadArtifact({
	artifactPath,
	filename,
}: {
	artifactPath: string;
	filename: string;
}): Promise<void> {
	const file = await fileForPath(artifactPath);
	const url = URL.createObjectURL(file);
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
	} finally {
		queueMicrotask(() => URL.revokeObjectURL(url));
	}
}

export async function resetRenderStoreForTest(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(DATABASE_NAME);
		request.addEventListener("success", () => resolve());
		request.addEventListener("error", () => reject(request.error));
	});
}
