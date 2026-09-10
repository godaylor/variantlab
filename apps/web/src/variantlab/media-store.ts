import type {
	DerivativePlan,
	PersistedJob,
	ProbeReport,
} from "@variantlab/studio-contract";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const MEDIA_DATABASE = "variantlab-media-v1";
const MEDIA_DATABASE_VERSION = 1;
const ASSETS_STORE = "assets";
const JOBS_STORE = "jobs";
const DERIVATIVES_STORE = "derivatives";
const OPFS_ROOT = "variantlab-media-v1";

export type StoredMediaAsset = {
	asset_id: string;
	campaign_id: string;
	scene_id: string;
	asset_hash: string;
	name: string;
	declared_mime: string;
	detected_mime: string;
	byte_length: number;
	original_path: string;
	probe: ProbeReport;
	plan: DerivativePlan;
	created_at: string;
};

export type StoredDerivative = {
	idempotency_key: string;
	job_id: string;
	campaign_id: string;
	asset_hash: string;
	kind: "proxy" | "waveform";
	artifact_path: string;
	byte_length: number;
	metadata_json: string;
	created_at: string;
};

type JobRecord = {
	id: string;
	idempotency_key: string;
	campaign_id: string;
	priority: number;
	created_at: string;
	job: PersistedJob;
};

export type StagedOriginal = {
	stagingPath: string;
	assetHash: string;
	byteLength: number;
	detectedMime: string;
};

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result));
		request.addEventListener("error", () =>
			reject(request.error ?? new Error("IndexedDB request failed")),
		);
	});
}

function deleteByIndex({
	store,
	indexName,
	value,
}: {
	store: IDBObjectStore;
	indexName: string;
	value: IDBValidKey;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = store.index(indexName).openCursor(IDBKeyRange.only(value));
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

function openMediaDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(MEDIA_DATABASE, MEDIA_DATABASE_VERSION);
		request.addEventListener("upgradeneeded", () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(ASSETS_STORE)) {
				const assets = database.createObjectStore(ASSETS_STORE, {
					keyPath: "asset_id",
				});
				assets.createIndex("by-campaign", "campaign_id", { unique: false });
			}
			if (!database.objectStoreNames.contains(JOBS_STORE)) {
				const jobs = database.createObjectStore(JOBS_STORE, { keyPath: "id" });
				jobs.createIndex("by-campaign", "campaign_id", { unique: false });
				jobs.createIndex("by-idempotency", "idempotency_key", {
					unique: true,
				});
			}
			if (!database.objectStoreNames.contains(DERIVATIVES_STORE)) {
				const derivatives = database.createObjectStore(DERIVATIVES_STORE, {
					keyPath: "idempotency_key",
				});
				derivatives.createIndex("by-campaign", "campaign_id", {
					unique: false,
				});
			}
		});
		request.addEventListener("success", () => resolve(request.result));
		request.addEventListener("error", () =>
			reject(request.error ?? new Error("Could not open media database")),
		);
	});
}

async function mediaRoot(): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(OPFS_ROOT, { create: true });
}

async function directoryFor({
	segments,
	create,
}: {
	segments: string[];
	create: boolean;
}): Promise<FileSystemDirectoryHandle> {
	let directory = await mediaRoot();
	for (const segment of segments) {
		directory = await directory.getDirectoryHandle(segment, { create });
	}
	return directory;
}

export async function fileHandleForPath({
	path,
	create = false,
}: {
	path: string;
	create?: boolean;
}): Promise<FileSystemFileHandle> {
	const segments = path.split("/").filter(Boolean);
	const filename = segments.pop();
	if (!filename || segments.some((segment) => segment === "..")) {
		throw new Error("Invalid media artifact path");
	}
	const directory = await directoryFor({ segments, create });
	return directory.getFileHandle(filename, { create });
}

export async function fileForPath(path: string): Promise<File> {
	return (await fileHandleForPath({ path })).getFile();
}

function detectMime(header: Uint8Array): string {
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)) return "image/png";
	const ascii = ({ start, length }: { start: number; length: number }) =>
		String.fromCharCode(...header.slice(start, start + length));
	if (
		header.length >= 4 &&
		header[0] === 0x1a &&
		header[1] === 0x45 &&
		header[2] === 0xdf &&
		header[3] === 0xa3
	) {
		return "video/webm";
	}
	if (header.length >= 12 && ascii({ start: 4, length: 4 }) === "ftyp")
		return "video/mp4";
	if (
		header.length >= 12 &&
		ascii({ start: 0, length: 4 }) === "RIFF" &&
		ascii({ start: 8, length: 4 }) === "WAVE"
	) {
		return "audio/wav";
	}
	if (ascii({ start: 0, length: 4 }) === "OggS") return "audio/ogg";
	if (
		ascii({ start: 0, length: 3 }) === "ID3" ||
		(header[0] === 0xff && header[1] === 0xfb)
	) {
		return "audio/mpeg";
	}
	return "application/octet-stream";
}

export async function stageOriginal({
	file,
	stagingId,
	onProgress,
}: {
	file: File;
	stagingId: string;
	onProgress?: (completedBytes: number, totalBytes: number) => void;
}): Promise<StagedOriginal> {
	if (file.size <= 0) throw new Error("The selected media file is empty");
	const estimate = await navigator.storage.estimate();
	const available =
		typeof estimate.quota === "number" && typeof estimate.usage === "number"
			? estimate.quota - estimate.usage
			: null;
	if (available !== null && available < file.size * 1.15) {
		throw new DOMException(
			`Need ${file.size} bytes plus staging headroom, but only ${Math.max(0, available)} bytes are available`,
			"QuotaExceededError",
		);
	}
	const stagingPath = `staging/${stagingId}.part`;
	const handle = await fileHandleForPath({ path: stagingPath, create: true });
	const writable = await handle.createWritable({ keepExistingData: false });
	const hasher = sha256.create();
	const reader = file.stream().getReader();
	let completedBytes = 0;
	let header = new Uint8Array();
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			const chunk = result.value;
			if (header.length < 64) {
				const merged = new Uint8Array(
					Math.min(64, header.length + chunk.length),
				);
				merged.set(header);
				merged.set(
					chunk.subarray(0, merged.length - header.length),
					header.length,
				);
				header = merged;
			}
			hasher.update(chunk);
			await writable.write(chunk);
			completedBytes += chunk.byteLength;
			onProgress?.(completedBytes, file.size);
		}
		await writable.close();
	} catch (error) {
		await writable.abort(error).catch(() => undefined);
		await removeArtifact(stagingPath).catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	if (completedBytes !== file.size) {
		await removeArtifact(stagingPath).catch(() => undefined);
		throw new Error("Staged media byte count does not match the source");
	}
	return {
		stagingPath,
		assetHash: bytesToHex(hasher.digest()),
		byteLength: completedBytes,
		detectedMime: detectMime(header),
	};
}

export type CommittedOriginalReceipt = {
	path: string;
	assetHash: string;
	created: boolean;
};

export async function commitStagedOriginalWithReceipt(
	staged: StagedOriginal,
): Promise<CommittedOriginalReceipt> {
	const finalPath = `originals/${staged.assetHash}`;
	try {
		const existing = await fileForPath(finalPath);
		if (existing.size === staged.byteLength) {
			await removeArtifact(staged.stagingPath).catch(() => undefined);
			return { path: finalPath, assetHash: staged.assetHash, created: false };
		}
	} catch {
		// Missing final is the normal first-import path.
	}
	const source = await fileForPath(staged.stagingPath);
	const temporaryPath = `originals/${staged.assetHash}.part`;
	const temporary = await fileHandleForPath({
		path: temporaryPath,
		create: true,
	});
	const writable = await temporary.createWritable({ keepExistingData: false });
	try {
		await copyFileToWritable({ source, writable });
		const written = await temporary.getFile();
		if (written.size !== staged.byteLength) {
			throw new Error("Original commit verification failed");
		}
		const originals = await directoryFor({
			segments: ["originals"],
			create: true,
		});
		const movable = temporary as FileSystemFileHandle & {
			move?: (
				directory: FileSystemDirectoryHandle,
				name: string,
			) => Promise<void>;
		};
		if (typeof movable.move === "function") {
			await movable.move(originals, staged.assetHash);
		} else {
			const final = await fileHandleForPath({ path: finalPath, create: true });
			const finalWritable = await final.createWritable({
				keepExistingData: false,
			});
			await copyFileToWritable({ source: written, writable: finalWritable });
			await removeArtifact(temporaryPath);
		}
		await removeArtifact(staged.stagingPath).catch(() => undefined);
		return { path: finalPath, assetHash: staged.assetHash, created: true };
	} catch (error) {
		await removeArtifact(temporaryPath).catch(() => undefined);
		throw error;
	}
}

export async function commitStagedOriginal(
	staged: StagedOriginal,
): Promise<string> {
	return (await commitStagedOriginalWithReceipt(staged)).path;
}

async function copyFileToWritable({
	source,
	writable,
}: {
	source: File;
	writable: FileSystemWritableFileStream;
}): Promise<void> {
	const reader = source.stream().getReader();
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			await writable.write(result.value);
		}
		await writable.close();
	} catch (error) {
		await writable.abort(error).catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
}

export async function removeArtifact(path: string): Promise<void> {
	const segments = path.split("/").filter(Boolean);
	const filename = segments.pop();
	if (!filename) return;
	const directory = await directoryFor({ segments, create: false });
	await directory.removeEntry(filename);
}

export async function saveMediaAsset(asset: StoredMediaAsset): Promise<void> {
	const database = await openMediaDatabase();
	const transaction = database.transaction(ASSETS_STORE, "readwrite");
	transaction.objectStore(ASSETS_STORE).put(asset);
	await transactionComplete(transaction);
	database.close();
}

export async function listMediaAssets(
	campaignId: string,
): Promise<StoredMediaAsset[]> {
	const database = await openMediaDatabase();
	const transaction = database.transaction(ASSETS_STORE, "readonly");
	const assets = await requestValue(
		transaction
			.objectStore(ASSETS_STORE)
			.index("by-campaign")
			.getAll(campaignId),
	);
	await transactionComplete(transaction);
	database.close();
	// IndexedDB getAll returns structured-clone data as any in lib.dom.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (assets as StoredMediaAsset[]).toSorted((left, right) =>
		left.created_at.localeCompare(right.created_at),
	);
}

export async function deleteMediaAssetsForCampaign(
	campaignId: string,
): Promise<void> {
	const database = await openMediaDatabase();
	const transaction = database.transaction(ASSETS_STORE, "readwrite");
	await deleteByIndex({
		store: transaction.objectStore(ASSETS_STORE),
		indexName: "by-campaign",
		value: campaignId,
	});
	await transactionComplete(transaction);
	database.close();
}

export async function removeCommittedOriginalIfUnreferenced(
	receipt: CommittedOriginalReceipt,
): Promise<void> {
	if (!receipt.created) return;
	const database = await openMediaDatabase();
	const transaction = database.transaction(ASSETS_STORE, "readonly");
	const assets: unknown = await requestValue(
		transaction.objectStore(ASSETS_STORE).getAll(),
	);
	await transactionComplete(transaction);
	database.close();
	const referenced =
		Array.isArray(assets) &&
		assets.some(
			(asset: unknown) =>
				typeof asset === "object" &&
				asset !== null &&
				"asset_hash" in asset &&
				asset.asset_hash === receipt.assetHash,
		);
	if (!referenced) {
		await removeArtifact(receipt.path);
	}
}

export async function saveJob(job: PersistedJob): Promise<void> {
	const database = await openMediaDatabase();
	const transaction = database.transaction(JOBS_STORE, "readwrite");
	transaction.objectStore(JOBS_STORE).put({
		id: job.spec.job_id,
		idempotency_key: job.spec.idempotency_key,
		campaign_id: job.spec.campaign_id,
		priority: job.spec.priority,
		created_at: job.created_at,
		job,
	} satisfies JobRecord);
	await transactionComplete(transaction);
	database.close();
}

export async function jobByIdempotencyKey(
	key: string,
): Promise<PersistedJob | null> {
	const database = await openMediaDatabase();
	const transaction = database.transaction(JOBS_STORE, "readonly");
	const value = await requestValue(
		transaction.objectStore(JOBS_STORE).index("by-idempotency").get(key),
	);
	await transactionComplete(transaction);
	database.close();
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (value as JobRecord | undefined)?.job ?? null;
}

export async function listJobs(campaignId: string): Promise<PersistedJob[]> {
	const database = await openMediaDatabase();
	const transaction = database.transaction(JOBS_STORE, "readonly");
	const rows = await requestValue(
		transaction.objectStore(JOBS_STORE).index("by-campaign").getAll(campaignId),
	);
	await transactionComplete(transaction);
	database.close();
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (rows as JobRecord[])
		.toSorted(
			(left, right) =>
				left.priority - right.priority ||
				left.created_at.localeCompare(right.created_at),
		)
		.map((row) => row.job);
}

export async function saveDerivative(
	derivative: StoredDerivative,
): Promise<void> {
	const database = await openMediaDatabase();
	const transaction = database.transaction(DERIVATIVES_STORE, "readwrite");
	transaction.objectStore(DERIVATIVES_STORE).put(derivative);
	await transactionComplete(transaction);
	database.close();
}

export async function derivativeByKey(
	key: string,
): Promise<StoredDerivative | null> {
	const database = await openMediaDatabase();
	const transaction = database.transaction(DERIVATIVES_STORE, "readonly");
	const value = await requestValue(
		transaction.objectStore(DERIVATIVES_STORE).get(key),
	);
	await transactionComplete(transaction);
	database.close();
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (value as StoredDerivative | undefined) ?? null;
}

export async function resetMediaStoreForTest(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(MEDIA_DATABASE);
		request.addEventListener("success", () => resolve());
		request.addEventListener("error", () => reject(request.error));
	});
}
