import type { PersistedRenderJob } from "@variantlab/studio-contract";
import type { StoredRenderArtifact } from "./render-store";

export function renderJobPhaseLabel(job: PersistedRenderJob): string {
	if (job.state === "failed") {
		return `failed · ${job.attempt.failure?.code ?? "unknown"}`;
	}
	if (job.state === "succeeded") {
		return job.stale ? "succeeded · stale revision" : "succeeded · verified";
	}
	return `${job.state} · ${job.phase}`;
}

export function renderJobControls(job: PersistedRenderJob): {
	canCancel: boolean;
	canRetryFailed: boolean;
} {
	return {
		canCancel: ["queued", "preparing", "running"].includes(job.state),
		canRetryFailed:
			job.state === "failed" && Boolean(job.attempt.failure?.retryable),
	};
}

export function updateLocalCellSelection({
	current,
	cellId,
	checked,
}: {
	current: string[];
	cellId: string;
	checked: boolean;
}): string[] {
	if (!checked) return current.filter((id) => id !== cellId);
	if (current.includes(cellId) || current.length >= 8) return current;
	return [...current, cellId];
}

export type RenderRequestIdentity = {
	cellId: string;
	campaignRevision: number;
	preset: string;
	manifestSha256: string;
	idempotencyKey: string;
	filename: string;
	destination: string;
};

export function renderPreflightToken({
	requests,
	requiredBytes,
}: {
	requests: RenderRequestIdentity[];
	requiredBytes: number;
}): string {
	return JSON.stringify({
		requiredBytes,
		requests: requests
			.toSorted((left, right) => left.cellId.localeCompare(right.cellId))
			.map((request) => [
				request.cellId,
				request.campaignRevision,
				request.preset,
				request.manifestSha256,
				request.idempotencyKey,
				request.filename,
				request.destination,
			]),
	});
}

export function isCurrentRenderPreflight({
	preparedToken,
	currentToken,
}: {
	preparedToken: string | null;
	currentToken: string;
}): boolean {
	return preparedToken === currentToken;
}

export function selectExactBatchArtifacts({
	artifacts,
	requests,
}: {
	artifacts: StoredRenderArtifact[];
	requests: RenderRequestIdentity[];
}): StoredRenderArtifact[] | null {
	const requestedCells = new Set<string>();
	const selected: StoredRenderArtifact[] = [];
	for (const request of requests) {
		if (requestedCells.has(request.cellId)) return null;
		requestedCells.add(request.cellId);
		const matches = artifacts.filter(
			(artifact) =>
				artifact.cell_id === request.cellId &&
				artifact.campaign_revision === request.campaignRevision &&
				artifact.preset === request.preset &&
				artifact.render_manifest_sha256 === request.manifestSha256 &&
				artifact.idempotency_key === request.idempotencyKey &&
				artifact.filename === request.filename &&
				artifact.destination === request.destination,
		);
		if (matches.length !== 1) return null;
		const match = matches[0];
		if (!match) return null;
		selected.push(match);
	}
	return selected;
}

export function renderFailureAction(code: string): string {
	switch (code) {
		case "out_of_space":
			return "Free storage or change destination.";
		case "corrupt_source":
			return "Relink or repair the source media.";
		case "unsupported_codec":
			return "Choose a supported codec or preset.";
		default:
			return "Review the failure details before retrying.";
	}
}
