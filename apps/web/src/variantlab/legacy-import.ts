import type {
	CreateCampaignInput,
	LegacyImportProvenance,
	Scene,
	StudioState,
} from "@variantlab/studio-contract";
import { createCampaign, snapshotHash } from "./domain";
import { createStoredCampaign, recoverCampaign } from "./local-store";

const LEGACY_DATABASE = "video-editor-projects";
const LEGACY_STORE = "projects";

type LegacyProjectSummary = {
	id: string;
	name: string;
	version: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve());
		transaction.addEventListener("abort", () =>
			reject(transaction.error ?? new Error("Legacy read transaction aborted")),
		);
		transaction.addEventListener("error", () =>
			reject(transaction.error ?? new Error("Legacy read transaction failed")),
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

async function legacyDatabaseExists(): Promise<boolean> {
	if (typeof indexedDB.databases !== "function") return true;
	const databases = await indexedDB.databases();
	return databases.some((database) => database.name === LEGACY_DATABASE);
}

async function openLegacyDatabase(): Promise<IDBDatabase | null> {
	if (!(await legacyDatabaseExists())) return null;
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(LEGACY_DATABASE);
		request.addEventListener("error", () => reject(request.error));
		request.addEventListener("success", () => resolve(request.result));
		request.addEventListener("upgradeneeded", () => {
			request.transaction?.abort();
			resolve(null);
		});
	});
}

async function readLegacyProjects(): Promise<unknown[]> {
	const database = await openLegacyDatabase();
	if (!database) return [];
	if (!database.objectStoreNames.contains(LEGACY_STORE)) {
		database.close();
		return [];
	}
	const transaction = database.transaction(LEGACY_STORE, "readonly");
	const value = await requestUnknown(
		transaction.objectStore(LEGACY_STORE).getAll(),
	);
	await transactionComplete(transaction);
	database.close();
	return Array.isArray(value) ? value : [];
}

function projectId(project: unknown): string | null {
	if (!isRecord(project)) return null;
	if (typeof project.id === "string") return project.id;
	if (isRecord(project.metadata) && typeof project.metadata.id === "string") {
		return project.metadata.id;
	}
	return null;
}

function projectName(project: unknown): string {
	if (!isRecord(project)) return "Imported campaign";
	if (typeof project.name === "string") return project.name;
	if (isRecord(project.metadata) && typeof project.metadata.name === "string") {
		return project.metadata.name;
	}
	return "Imported campaign";
}

function projectVersion(project: unknown): number | null {
	return isRecord(project) && typeof project.version === "number"
		? project.version
		: null;
}

export async function listLegacyProjects(): Promise<LegacyProjectSummary[]> {
	const projects = await readLegacyProjects();
	return projects.flatMap((project) => {
		const id = projectId(project);
		return id
			? [{ id, name: projectName(project), version: projectVersion(project) }]
			: [];
	});
}

function importScenes({
	project,
	now,
}: {
	project: unknown;
	now: string;
}): Scene[] {
	if (!isRecord(project) || !Array.isArray(project.scenes)) {
		return [
			{
				id: crypto.randomUUID(),
				name: "Main scene",
				created_at: now,
				updated_at: now,
				timeline: null,
			},
		];
	}
	const scenes = project.scenes.flatMap((scene): Scene[] => {
		if (!isRecord(scene)) return [];
		return [
			{
				id: typeof scene.id === "string" ? scene.id : crypto.randomUUID(),
				name: typeof scene.name === "string" ? scene.name : "Untitled scene",
				created_at: typeof scene.createdAt === "string" ? scene.createdAt : now,
				updated_at: typeof scene.updatedAt === "string" ? scene.updatedAt : now,
				timeline: null,
			},
		];
	});
	return scenes.length > 0
		? scenes
		: [
				{
					id: crypto.randomUUID(),
					name: "Main scene",
					created_at: now,
					updated_at: now,
					timeline: null,
				},
			];
}

export async function importLegacyProject(
	sourceProjectId: string,
): Promise<StudioState> {
	const projects = await readLegacyProjects();
	const source = projects.find(
		(project) => projectId(project) === sourceProjectId,
	);
	if (!source) throw new Error("Legacy project was not found");
	const sourceBefore = JSON.stringify(source);
	const now = new Date().toISOString();
	const campaignId = crypto.randomUUID();
	const provenance: LegacyImportProvenance = {
		source_namespace: LEGACY_DATABASE,
		source_project_id: sourceProjectId,
		source_version: projectVersion(source),
		imported_at: now,
	};
	const input: CreateCampaignInput = {
		campaign_id: campaignId,
		campaign_name: projectName(source),
		master_sequence_id: crypto.randomUUID(),
		created_at: now,
		scenes: importScenes({ project: source, now }),
		imported_from: provenance,
	};
	const state = createCampaign(input);
	await createStoredCampaign({
		state,
		legacyImport: {
			source_namespace: LEGACY_DATABASE,
			source_project_id: sourceProjectId,
			source_json: sourceBefore,
			imported_at: now,
		},
	});
	const reopened = await recoverCampaign(campaignId);
	if (snapshotHash(reopened.state) !== snapshotHash(state)) {
		throw new Error("Imported campaign failed reopen/hash verification");
	}
	const sourceAfter = (await readLegacyProjects()).find(
		(project) => projectId(project) === sourceProjectId,
	);
	if (JSON.stringify(sourceAfter) !== sourceBefore) {
		throw new Error("Legacy source changed during read-only import");
	}
	return reopened.state;
}
