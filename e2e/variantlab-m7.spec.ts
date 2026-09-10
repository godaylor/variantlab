import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";

async function expectRevisionAtLeast(page: Page, revision: number) {
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	await expect
		.poll(async () => {
			const text = await page.getByTestId("save-status").textContent();
			return Number(text?.match(/revision (\d+)/)?.[1] ?? -1);
		})
		.toBeGreaterThanOrEqual(revision);
}

async function currentRevision(page: Page) {
	const text = await page.getByTestId("save-status").textContent();
	return Number(text?.match(/revision (\d+)/)?.[1] ?? -1);
}

async function generatedLicensedAvFixture({
	page,
	seed,
}: {
	page: Page;
	seed: number;
}): Promise<Buffer> {
	const bytes = await page.evaluate(async (fixtureSeed) => {
		const mimeType = [
			"video/webm;codecs=vp8,opus",
			"video/webm;codecs=vp9,opus",
			"video/webm",
		].find((candidate) => MediaRecorder.isTypeSupported(candidate));
		if (!mimeType)
			throw new Error("Chromium cannot create the repository-owned M7 fixture");
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas 2D unavailable");
		const audio = new AudioContext({ sampleRate: 48_000 });
		await audio.resume();
		const oscillator = audio.createOscillator();
		const gain = audio.createGain();
		const destination = audio.createMediaStreamDestination();
		gain.gain.value = 0.06;
		oscillator.frequency.value = 330 + fixtureSeed * 70;
		oscillator.connect(gain).connect(destination);
		oscillator.start();
		const canvasStream = canvas.captureStream(24);
		const stream = new MediaStream([
			...canvasStream.getVideoTracks(),
			...destination.stream.getAudioTracks(),
		]);
		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(stream, {
			mimeType,
			videoBitsPerSecond: 900_000,
			audioBitsPerSecond: 64_000,
		});
		recorder.addEventListener("dataavailable", (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		});
		const stopped = new Promise<void>((resolve) =>
			recorder.addEventListener("stop", () => resolve(), { once: true }),
		);
		recorder.start(100);
		for (let frame = 0; frame < 20; frame += 1) {
			context.fillStyle =
				(frame + fixtureSeed) % 2 === 0 ? "#172128" : "#d26532";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = "#f6f7f4";
			context.font = "bold 42px sans-serif";
			context.fillText(`VariantLab M7 ${fixtureSeed} / ${frame}`, 48, 190);
			await new Promise((resolve) => window.setTimeout(resolve, 42));
		}
		recorder.stop();
		await stopped;
		oscillator.stop();
		for (const track of stream.getTracks()) track.stop();
		await audio.close();
		return Array.from(
			new Uint8Array(
				await new Blob(chunks, { type: "video/webm" }).arrayBuffer(),
			),
		);
	}, seed);
	return Buffer.from(bytes);
}

async function mediaAssetCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		// A read-only baseline must not create an empty v1 database before
		// the application's lazy media initialization installs its stores.
		const databases = await indexedDB.databases();
		if (!databases.some((database) => database.name === "variantlab-media-v1")) return 0;
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("variantlab-media-v1");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const rows = await new Promise<unknown[]>((resolve, reject) => {
			const request = database
				.transaction("assets", "readonly")
				.objectStore("assets")
				.getAll();
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		database.close();
		return rows.length;
	});
}

async function campaignCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("variantlab-studio-v1");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const count = await new Promise<number>((resolve, reject) => {
			const request = database
				.transaction("campaigns", "readonly")
				.objectStore("campaigns")
				.count();
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		database.close();
		return count;
	});
}

function editableBundleHeader(bytes: Buffer): {
	snapshot_sha256: string;
	entries: Array<{ sha256: string }>;
} {
	const headerLength = bytes.readUInt32LE(9);
	return JSON.parse(bytes.subarray(13, 13 + headerLength).toString("utf8")) as {
		snapshot_sha256: string;
		entries: Array<{ sha256: string }>;
	};
}

async function originalFileNames(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const media = await root.getDirectoryHandle("variantlab-media-v1", {
			create: true,
		});
		const originals = await media.getDirectoryHandle("originals", {
			create: true,
		});
		const names: string[] = [];
		for await (const [name, handle] of (
			originals as unknown as {
				entries(): AsyncIterable<[string, FileSystemHandle]>;
			}
		).entries()) {
			if (handle.kind === "file") names.push(name);
		}
		return names.toSorted();
	});
}

async function dedupedOriginalEvidence(page: Page): Promise<{
	campaigns: Array<{ id: string; latest_revision: number; name: string }>;
	mediaRows: Array<{
		assetId: string;
		campaignId: string;
		assetHash: string;
		originalPath: string;
		byteLength: number;
	}>;
	originals: Array<{ name: string; byteLength: number; sha256: string }>;
}> {
	return page.evaluate(async () => {
		const open = (name: string) =>
			new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.addEventListener("success", () => resolve(request.result));
				request.addEventListener("error", () => reject(request.error));
			});
		const rows = <T>(database: IDBDatabase, store: string) =>
			new Promise<T[]>((resolve, reject) => {
				const request = database
					.transaction(store, "readonly")
					.objectStore(store)
					.getAll();
				request.addEventListener("success", () => resolve(request.result));
				request.addEventListener("error", () => reject(request.error));
			});
		const studio = await open("variantlab-studio-v1");
		const campaigns = await rows<{
			id: string;
			latest_revision: number;
			name: string;
		}>(studio, "campaigns");
		studio.close();
		const media = await open("variantlab-media-v1");
		const mediaRows = await rows<{
			asset_id: string;
			campaign_id: string;
			asset_hash: string;
			original_path: string;
			byte_length: number;
		}>(media, "assets");
		media.close();

		const root = await navigator.storage.getDirectory();
		const mediaRoot = await root.getDirectoryHandle("variantlab-media-v1");
		const originals = await mediaRoot.getDirectoryHandle("originals");
		const originalEvidence: Array<{
			name: string;
			byteLength: number;
			sha256: string;
		}> = [];
		for await (const [name, handle] of (
			originals as unknown as {
				entries(): AsyncIterable<[string, FileSystemHandle]>;
			}
		).entries()) {
			if (handle.kind !== "file") continue;
			const file = await (handle as FileSystemFileHandle).getFile();
			const digest = await crypto.subtle.digest(
				"SHA-256",
				await file.arrayBuffer(),
			);
			originalEvidence.push({
				name,
				byteLength: file.size,
				sha256: Array.from(new Uint8Array(digest), (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join(""),
			});
		}
		return {
			campaigns: campaigns.toSorted((left, right) =>
				left.id.localeCompare(right.id),
			),
			mediaRows: mediaRows
				.map((row) => ({
					assetId: row.asset_id,
					campaignId: row.campaign_id,
					assetHash: row.asset_hash,
					originalPath: row.original_path,
					byteLength: row.byte_length,
				}))
				.toSorted((left, right) => left.assetId.localeCompare(right.assetId)),
			originals: originalEvidence.toSorted((left, right) =>
				left.name.localeCompare(right.name),
			),
		};
	});
}

async function restoredBundleIntegrity(page: Page): Promise<{
	snapshotHash: string;
	mediaHashes: string[];
}> {
	return page.evaluate(async () => {
		const mediaDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("variantlab-media-v1");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const mediaRows = await new Promise<
			Array<{ campaign_id: string; asset_hash: string }>
		>((resolve, reject) => {
			const request = mediaDatabase
				.transaction("assets", "readonly")
				.objectStore("assets")
				.getAll();
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		mediaDatabase.close();
		const campaignId = mediaRows[0]?.campaign_id;
		if (!campaignId) throw new Error("Imported media campaign is missing");
		if (!mediaRows.every((row) => row.campaign_id === campaignId))
			throw new Error("Imported media rows are mixed across campaigns");

		const studioDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("variantlab-studio-v1");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const snapshots = await new Promise<
			Array<{ campaign_id: string; revision: number; checksum: string }>
		>((resolve, reject) => {
			const request = studioDatabase
				.transaction("snapshots", "readonly")
				.objectStore("snapshots")
				.index("campaign_id")
				.getAll(campaignId);
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		studioDatabase.close();
		const latest = snapshots.toSorted(
			(left, right) => right.revision - left.revision,
		)[0];
		if (!latest) throw new Error("Imported snapshot is missing");
		return {
			snapshotHash: latest.checksum,
			mediaHashes: mediaRows.map((row) => row.asset_hash).toSorted(),
		};
	});
}

async function campaignPersistenceCounts(page: Page): Promise<number[]> {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("variantlab-studio-v1");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const stores = ["campaigns", "snapshots", "journal", "legacy-imports"];
		const counts = await Promise.all(
			stores.map(
				(store) =>
					new Promise<number>((resolve, reject) => {
						const request = database
							.transaction(store, "readonly")
							.objectStore(store)
							.count();
						request.addEventListener("success", () => resolve(request.result));
						request.addEventListener("error", () => reject(request.error));
					}),
			),
		);
		database.close();
		return counts;
	});
}

async function openCleanPage(browser: Browser, origin: string) {
	const context = await browser.newContext({ baseURL: origin });
	const page = await context.newPage();
	await page.goto("/variantlab?m7_reference=1");
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "en", exact: true }).click();
	return { context, page };
}

test("M7 freezes a full-sequence batch, recovers jobs, and roundtrips an untrusted editable package", async ({
	page,
	browser,
	browserName,
}, testInfo) => {
	test.setTimeout(300_000);
	await page.goto("/variantlab?m7_reference=1");
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "en", exact: true }).click();
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await expectRevisionAtLeast(page, 0);
	await expect(
		page.getByRole("navigation", { name: "Scenes" }).getByRole("button"),
	).toHaveCount(3);

	const sceneButtons = page
		.getByRole("navigation", { name: "Scenes" })
		.getByRole("button");
	for (let index = 0; index < 3; index += 1) {
		const fixture = await generatedLicensedAvFixture({ page, seed: index + 1 });
		expect(fixture.byteLength).toBeGreaterThan(1_000);
		await sceneButtons.nth(index).click();
		await page.getByLabel("Import master media").setInputFiles({
			name: `variantlab-m7-scene-${index + 1}.webm`,
			mimeType: "video/webm",
			buffer: fixture,
		});
		await expect
			.poll(() => mediaAssetCount(page), { timeout: 30_000 })
			.toBe(index + 1);
		await expectRevisionAtLeast(page, index + 1);
	}

	await page.getByRole("button", { name: "Create adaptive 9:16" }).click();
	const matrix = page.getByTestId("variant-matrix");
	await matrix.getByRole("button", { name: "Add 16:9 + 1:1 profiles" }).click();
	await matrix.getByRole("button", { name: "Add review rows to 8" }).click();
	await matrix.getByRole("button", { name: "Select first 24" }).click();
	await matrix.getByRole("button", { name: "Enable 24 selected" }).click();
	await expect(page.getByTestId("matrix-cell-count")).toContainText("24 / 100");

	const board = page.getByRole("region", { name: "Render package" });
	const picker = page.getByTestId("m7-cell-picker");
	const cellChecks = picker.locator("input[type='checkbox']");
	await expect(cellChecks).toHaveCount(24);
	for (let index = 0; index < 8; index += 1)
		await cellChecks.nth(index).check();
	await expect(board.getByText(/Deliverable cells/)).toContainText("8/8");

	await sceneButtons.nth(1).click();
	await expect(sceneButtons.nth(1)).toHaveAttribute("aria-pressed", "true");
	const inclusionChecks = page
		.getByTestId("m7-scene-inclusion")
		.locator("input[type='checkbox']");
	const revisionBeforeInclusion = await currentRevision(page);
	await inclusionChecks.nth(1).click();
	await expect(inclusionChecks.nth(1)).not.toBeChecked();
	await expectRevisionAtLeast(page, revisionBeforeInclusion + 1);

	const template = page.getByLabel("Filename template");
	await template.fill("{campaign}_{cell}");
	await expect(
		page.getByTestId("m7-filename-preview").getByRole("listitem"),
	).toHaveCount(8);
	await page.getByLabel("Destination").selectOption("user_granted_directory");
	await board.getByRole("button", { name: "Choose directory" }).click();
	await expect(page.getByLabel("Destination")).toHaveValue("browser_download");

	await board.getByRole("button", { name: "Disable codec" }).click();
	await board.getByRole("button", { name: "Run preflight" }).click();
	await expect(page.getByTestId("m7-preflight")).toContainText("BLOCKED");
	await expect(page.getByTestId("m7-preflight")).toContainText(
		"unsupported_codec",
	);
	await board.getByRole("button", { name: "Restore codec" }).click();
	await board.getByRole("button", { name: "Run preflight" }).click();
	await expect(page.getByTestId("m7-preflight")).toContainText("READY", {
		timeout: 30_000,
	});

	await page.evaluate(() => {
		const samples: number[] = [];
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) samples.push(entry.duration);
		}).observe({ type: "longtask", buffered: true });
		(window as Window & { __m7LongTasks?: number[] }).__m7LongTasks = samples;
		(
			window as Window & { __m7ProgressStalenessMs?: number[] }
		).__m7ProgressStalenessMs = [];
		(
			window as Window & {
				__m7VisibleProgressEvents?: Array<{
					attemptKey: string;
					atMs: number;
					kind: "progress" | "terminal";
				}>;
			}
		).__m7VisibleProgressEvents = [];
	});
	await board.getByRole("button", { name: "Crash next worker" }).click();
	await board.getByRole("button", { name: "Enqueue local batch" }).click();
	await page.getByRole("button", { name: "Play shared clock" }).click();
	await expect(
		page.getByRole("button", { name: "Pause shared clock" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Pause shared clock" }).click();
	const previewInteractionDuringExport = true;
	const jobs = page.getByTestId("m7-job-center");
	await expect(jobs.getByText("failed · worker_terminated")).toHaveCount(1, {
		timeout: 60_000,
	});
	await Promise.race([
		expect(jobs.getByText("succeeded · verified")).toHaveCount(7, {
			timeout: 180_000,
		}),
		page
			.waitForFunction(
				() => {
					const panel = document.querySelector('[data-testid="m7-job-center"]');
					return (panel?.textContent?.match(/failed ·/g)?.length ?? 0) > 1;
				},
				{},
				{ timeout: 180_000 },
			)
			.then(async () => {
				const failures = await page.evaluate(async () => {
					const db = await new Promise<IDBDatabase>((resolve, reject) => {
						const request = indexedDB.open("variantlab-render-v1");
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
					const rows = await new Promise<any[]>((resolve, reject) => {
						const request = db
							.transaction("render-jobs", "readonly")
							.objectStore("render-jobs")
							.getAll();
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
					db.close();
					return rows
						.filter((row) => row.job.state === "failed")
						.map((row) => row.job.attempt.failure);
				});
				throw new Error(
					"Unexpected export failures: " + JSON.stringify(failures),
				);
			}),
	]);
	await jobs.getByRole("button", { name: "Retry failed" }).click();
	await expect(jobs.getByText("succeeded · verified")).toHaveCount(8, {
		timeout: 90_000,
	});
	await expect(
		page.getByTestId("m7-artifacts").getByRole("listitem"),
	).toHaveCount(8);
	const progressStaleness = await page.evaluate(
		() =>
			(window as Window & { __m7ProgressStalenessMs?: number[] })
				.__m7ProgressStalenessMs ?? [],
	);
	expect(progressStaleness.length).toBeGreaterThan(0);
	expect(Math.max(...progressStaleness)).toBeLessThan(1_000);
	const visibleProgressCadence = await page.evaluate(() => {
		const events =
			(
				window as Window & {
					__m7VisibleProgressEvents?: Array<{
						attemptKey: string;
						atMs: number;
						kind: "progress" | "terminal";
					}>;
				}
			).__m7VisibleProgressEvents ?? [];
		const byAttempt = new Map<string, typeof events>();
		for (const event of events) {
			const attempt = byAttempt.get(event.attemptKey) ?? [];
			attempt.push(event);
			byAttempt.set(event.attemptKey, attempt);
		}
		const intervalsMs: number[] = [];
		for (const attempt of byAttempt.values()) {
			attempt.sort((left, right) => left.atMs - right.atMs);
			if (!attempt.some((event) => event.kind === "terminal")) {
				throw new Error("Active render attempt has no visible terminal update");
			}
			for (let index = 1; index < attempt.length; index += 1) {
				intervalsMs.push(attempt[index]!.atMs - attempt[index - 1]!.atMs);
			}
		}
		return { events, intervalsMs, attemptCount: byAttempt.size };
	});
	expect(visibleProgressCadence.attemptCount).toBe(9);
	expect(visibleProgressCadence.intervalsMs.length).toBeGreaterThan(0);
	expect(Math.max(...visibleProgressCadence.intervalsMs)).toBeLessThan(1_000);

	const frozenEvidence = await page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("variantlab-render-v1", 2);
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const rows = await new Promise<
			Array<{
				manifest: {
					scenes: Array<{ included: boolean; scene_id: string }>;
					clips: Array<{ scene_id: string }>;
					sequence_duration_ticks: number;
				};
				job: {
					state: string;
					attempt: { attempt: number };
					spec: { campaign_revision: number; render_manifest_sha256: string };
				};
			}>
		>((resolve, reject) => {
			const request = database
				.transaction("render-jobs", "readonly")
				.objectStore("render-jobs")
				.getAll();
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		database.close();
		const successful = rows.filter((row) => row.job.state === "succeeded");
		return {
			count: successful.length,
			sceneCount: successful[0]?.manifest.scenes.length ?? 0,
			included:
				successful[0]?.manifest.scenes.map((scene) => scene.included) ?? [],
			clipSceneIds: [
				...new Set(
					successful[0]?.manifest.clips.map((clip) => clip.scene_id) ?? [],
				),
			],
			duration: successful[0]?.manifest.sequence_duration_ticks ?? 0,
			attempts: successful.map((row) => row.job.attempt.attempt),
			manifestHashes: successful.map(
				(row) => row.job.spec.render_manifest_sha256,
			),
		};
	});
	expect(frozenEvidence.count).toBe(8);
	expect(frozenEvidence.sceneCount).toBe(3);
	expect(frozenEvidence.included).toEqual([true, false, true]);
	expect(frozenEvidence.clipSceneIds).toHaveLength(2);
	expect(frozenEvidence.duration).toBeGreaterThan(0);
	expect(frozenEvidence.attempts).toContain(2);
	expect(new Set(frozenEvidence.manifestHashes).size).toBe(8);

	await board.getByRole("button", { name: "Enqueue local batch" }).click();
	await expect(page.getByTestId("m7-live-status")).toContainText(
		"Skipped 8 already verified",
	);
	await expect(jobs.getByRole("listitem")).toHaveCount(8);

	const renderedMedia = await page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("variantlab-render-v1", 2);
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const artifacts = await new Promise<
			Array<{
				artifact_path: string;
				byte_length: number;
				sha256: string;
				timing: { frame_count: number; audio_sample_count: number };
			}>
		>((resolve, reject) => {
			const request = database
				.transaction("render-artifacts-v2", "readonly")
				.objectStore("render-artifacts-v2")
				.getAll();
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		database.close();
		const artifact = artifacts[0];
		if (!artifact) throw new Error("No committed artifact");
		const root = await navigator.storage.getDirectory();
		let directory = await root.getDirectoryHandle("variantlab-media-v1");
		const parts = artifact.artifact_path.split("/");
		for (const part of parts.slice(0, -1))
			directory = await directory.getDirectoryHandle(part);
		const file = await (await directory.getFileHandle(parts.at(-1)!)).getFile();
		const url = URL.createObjectURL(file);
		try {
			const video = document.createElement("video");
			video.src = url;
			await new Promise<void>((resolve, reject) => {
				video.addEventListener("loadedmetadata", () => resolve(), {
					once: true,
				});
				video.addEventListener("error", () => reject(video.error), {
					once: true,
				});
			});
			return {
				bytes: file.size,
				declaredBytes: artifact.byte_length,
				sha256: artifact.sha256,
				frames: artifact.timing.frame_count,
				audioSamples: artifact.timing.audio_sample_count,
				duration: video.duration,
				width: video.videoWidth,
				height: video.videoHeight,
			};
		} finally {
			URL.revokeObjectURL(url);
		}
	});
	expect(renderedMedia.bytes).toBe(renderedMedia.declaredBytes);
	expect(renderedMedia.bytes).toBeGreaterThan(1_000);
	expect(renderedMedia.sha256).toMatch(/^[a-f0-9]{64}$/);
	expect(renderedMedia.frames).toBeGreaterThan(0);
	expect(renderedMedia.audioSamples).toBeGreaterThan(0);
	expect(renderedMedia.duration).toBeGreaterThan(0);
	expect(renderedMedia.width).toBeGreaterThan(0);
	expect(renderedMedia.height).toBeGreaterThan(0);

	const manifestDownloadPromise = page.waitForEvent("download");
	await board.getByRole("button", { name: "Download manifest" }).click();
	const manifestDownload = await manifestDownloadPromise;
	const manifestPath = testInfo.outputPath("m7-deliverable-manifest.json");
	await manifestDownload.saveAs(manifestPath);
	const deliverable = JSON.parse(await readFile(manifestPath, "utf8")) as {
		campaign_revision: number;
		preset: string;
		artifacts: Array<{
			cell_id: string;
			campaign_revision: number;
			preset: string;
			sha256: string;
			render_manifest_sha256: string;
		}>;
		provenance: {
			engine: string;
			codec_provider: string;
			license_notice: string;
		};
	};
	expect(deliverable.artifacts).toHaveLength(8);
	expect(new Set(deliverable.artifacts.map((item) => item.cell_id)).size).toBe(
		8,
	);
	expect(deliverable.artifacts.every((item) => item.sha256.length === 64)).toBe(
		true,
	);
	expect(
		deliverable.artifacts.every(
			(item) => item.render_manifest_sha256.length === 64,
		),
	).toBe(true);
	expect(deliverable.provenance.engine).toBe("variantlab-render-v2");
	expect(deliverable.provenance.codec_provider).toBe(
		"browser_webcodecs_mediabunny-1.41.0",
	);
	expect(deliverable.provenance.license_notice).toContain(
		"VariantLab attribution preserved",
	);

	const revisionA = deliverable.campaign_revision;
	for (let index = 1; index < 8; index += 1)
		await cellChecks.nth(index).uncheck();

	await page.getByLabel("Scene name").fill("Scene B corrupt-source revision");
	await page.getByRole("button", { name: "Save name" }).click();
	const corruptRevision = await currentRevision(page);
	await expect(page.getByTestId("m7-preflight")).toContainText("stale request");
	await board.getByRole("button", { name: "Run preflight" }).click();
	await expect(page.getByTestId("m7-preflight")).toContainText("READY");
	await board.getByRole("button", { name: "Corrupt next source" }).click();
	await board.getByRole("button", { name: "Enqueue local batch" }).click();
	await expect(jobs.getByText("failed · corrupt_source")).toHaveCount(1, {
		timeout: 60_000,
	});
	await expect(
		jobs.getByText("Relink or repair the source media."),
	).toBeVisible();

	await page.getByLabel("Scene name").fill("Scene B out-of-space revision");
	await page.getByRole("button", { name: "Save name" }).click();
	await expectRevisionAtLeast(page, corruptRevision + 1);
	await board.getByRole("button", { name: "Run preflight" }).click();
	await expect(page.getByTestId("m7-preflight")).toContainText("READY");
	await board.getByRole("button", { name: "Exhaust next storage" }).click();
	await board.getByRole("button", { name: "Enqueue local batch" }).click();
	await expect(jobs.getByText("failed · out_of_space")).toHaveCount(1, {
		timeout: 60_000,
	});
	await expect(
		jobs.getByText("Free storage or change destination."),
	).toBeVisible();

	await page.getByLabel("Scene name").fill("Scene B revision B exact package");
	await page.getByRole("button", { name: "Save name" }).click();
	await expectRevisionAtLeast(page, corruptRevision + 2);
	const revisionB = await currentRevision(page);
	await board.getByRole("button", { name: "Run preflight" }).click();
	await expect(page.getByTestId("m7-preflight")).toContainText("READY");
	await board.getByRole("button", { name: "Enqueue local batch" }).click();
	await expect(jobs.getByText("succeeded · verified")).toHaveCount(1, {
		timeout: 90_000,
	});
	await expect(jobs.getByText("succeeded · stale revision")).toHaveCount(8);
	await expect(
		page.getByTestId("m7-artifacts").getByRole("listitem"),
	).toHaveCount(9);

	const revisionBDownloadPromise = page.waitForEvent("download");
	await board.getByRole("button", { name: "Download manifest" }).click();
	const revisionBDownload = await revisionBDownloadPromise;
	const revisionBManifestPath = testInfo.outputPath(
		"m7-deliverable-manifest-revision-b.json",
	);
	await revisionBDownload.saveAs(revisionBManifestPath);
	const revisionBManifest = JSON.parse(
		await readFile(revisionBManifestPath, "utf8"),
	) as {
		campaign_revision: number;
		preset: string;
		artifacts: Array<{
			cell_id: string;
			campaign_revision: number;
			preset: string;
		}>;
	};
	expect(revisionBManifest.campaign_revision).toBe(revisionB);
	expect(revisionBManifest.campaign_revision).not.toBe(revisionA);
	expect(revisionBManifest.artifacts).toHaveLength(1);
	expect(
		new Set(revisionBManifest.artifacts.map((item) => item.cell_id)).size,
	).toBe(1);
	expect(
		revisionBManifest.artifacts.every(
			(item) =>
				item.campaign_revision === revisionBManifest.campaign_revision &&
				item.preset === revisionBManifest.preset,
		),
	).toBe(true);

	await cellChecks.nth(1).check();

	for (let index = 2; index < 8; index += 1)
		await cellChecks.nth(index).uncheck();
	await page.getByLabel("Scene name").fill("Scene B live edit");
	await page.getByRole("button", { name: "Save name" }).click();
	await board.getByRole("button", { name: "Run preflight" }).click();
	await expect(page.getByTestId("m7-preflight")).toContainText("READY");
	await board.getByRole("button", { name: "Enqueue local batch" }).click();
	await expect(jobs.getByRole("button", { name: "Cancel" })).toHaveCount(2);
	await jobs.getByRole("button", { name: "Cancel" }).last().click();
	await expect(page.getByTestId("m7-job-center")).toContainText("cancelled", {
		timeout: 30_000,
	});
	await page.getByLabel("Scene name").fill("Scene B edited after enqueue");
	await page.getByRole("button", { name: "Save name" }).click();
	await page.reload();
	await page.waitForLoadState("domcontentloaded");
	// Fast fixtures may finish before reload; the transient recovery announcement
	// can already be replaced by verified completion. Assert durable outcomes below.
	await expect(page.getByTestId("m7-job-center")).toBeVisible();
	await expect(page.getByTestId("m7-job-center")).toContainText("cancelled", {
		timeout: 90_000,
	});
	await expect(page.getByTestId("m7-job-center")).toContainText(
		"succeeded · stale revision",
		{ timeout: 120_000 },
	);

	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.evaluate(() => {
		document.documentElement.style.zoom = "2";
	});
	const refreshedBoard = page.getByRole("region", { name: "Render package" });
	const accessibility = await new AxeBuilder({ page })
		.include("[aria-labelledby='render-package-heading']")
		.analyze();
	expect(accessibility.violations).toEqual([]);
	const focusedControl = refreshedBoard.getByRole("button", {
		name: "Run preflight",
	});
	await focusedControl.focus();
	await expect(focusedControl).toBeFocused();
	await page.screenshot({
		path: testInfo.outputPath("m7-keyboard-focus-200pct.png"),
		fullPage: true,
	});
	await page.evaluate(() => {
		document.documentElement.style.zoom = "";
	});

	const bundleDownloadPromise = page.waitForEvent("download");
	await refreshedBoard
		.getByRole("button", { name: "Export editable bundle" })
		.click();
	const bundleDownload = await bundleDownloadPromise;
	const bundlePath = testInfo.outputPath("m7-roundtrip.vlcampaign");
	await bundleDownload.saveAs(bundlePath);
	const bundleBytes = await readFile(bundlePath);
	expect(bundleBytes.subarray(0, 9).toString("utf8")).toBe("VLBUNDLE1");

	const origin = new URL(page.url()).origin;
	const clean = await openCleanPage(browser, origin);
	try {
		await clean.page.getByRole("button", { name: "+ New campaign" }).click();
		await expect(clean.page.getByTestId("save-status")).toContainText("Saved locally");
		await clean.context.setOffline(true);
		const beforeImport = await campaignCount(clean.page);
		const baselinePersistence = await campaignPersistenceCounts(clean.page);
		const baselineMedia = await mediaAssetCount(clean.page);
		const baselineOriginals = await originalFileNames(clean.page);
		const failurePoints = [
			"after_first_original_commit",
			"after_provenance",
			"after_probe",
			"after_first_media_commit",
			"after_campaign_commit",
		] as const;
		for (const failurePoint of failurePoints) {
			await clean.page
				.getByLabel("Bundle import failure")
				.selectOption(failurePoint);
			await clean.page.getByLabel("Import editable bundle").setInputFiles({
				name: `m7-rollback-${failurePoint}.vlcampaign`,
				mimeType: "application/octet-stream",
				buffer: bundleBytes,
			});
			await expect(clean.page.getByTestId("m7-live-status")).toContainText(
				`Injected editable bundle import failure: ${failurePoint}`,
				{ timeout: 60_000 },
			);
			expect(await campaignPersistenceCounts(clean.page)).toEqual(
				baselinePersistence,
			);
			expect(await mediaAssetCount(clean.page)).toBe(baselineMedia);
			expect(await originalFileNames(clean.page)).toEqual(baselineOriginals);
		}

		await clean.page.getByLabel("Bundle import failure").selectOption("");
		await clean.page.getByLabel("Import editable bundle").setInputFiles({
			name: "m7-roundtrip.vlcampaign",
			mimeType: "application/octet-stream",
			buffer: bundleBytes,
		});
		await expect(clean.page.getByText(/atomically imported/i)).toBeVisible({
			timeout: 60_000,
		});
		await expect.poll(() => campaignCount(clean.page)).toBe(beforeImport + 1);
		await expect.poll(() => mediaAssetCount(clean.page)).toBe(3);
		const bundleHeader = editableBundleHeader(bundleBytes);
		expect(bundleHeader.snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);
		const restored = await restoredBundleIntegrity(clean.page);
		const visibleRestoredHash = await clean.page
			.getByRole("region", { name: "Render package" })
			.getAttribute("data-snapshot-hash");
		expect(visibleRestoredHash).toBe(restored.snapshotHash);
		expect(restored.mediaHashes).toEqual(
			[
				...new Set(bundleHeader.entries.map((entry) => entry.sha256)),
			].toSorted(),
		);

		const sharedBefore = await dedupedOriginalEvidence(clean.page);
		expect(sharedBefore.mediaRows).toHaveLength(3);
		expect(sharedBefore.originals.map((entry) => entry.sha256)).toEqual(
			[
				...new Set(bundleHeader.entries.map((entry) => entry.sha256)),
			].toSorted(),
		);
		await clean.page
			.getByLabel("Bundle import failure")
			.selectOption("after_existing_original_commit");
		await clean.page.getByLabel("Import editable bundle").setInputFiles({
			name: "m7-shared-dedupe-rollback.vlcampaign",
			mimeType: "application/octet-stream",
			buffer: bundleBytes,
		});
		await expect(clean.page.getByTestId("m7-live-status")).toContainText(
			"Injected editable bundle import failure: after_existing_original_commit",
			{ timeout: 60_000 },
		);
		const sharedAfter = await dedupedOriginalEvidence(clean.page);
		expect(sharedAfter).toEqual(sharedBefore);

		const beforeCorrupt = await campaignPersistenceCounts(clean.page);
		const beforeCorruptMedia = await mediaAssetCount(clean.page);
		const beforeCorruptOriginals = await originalFileNames(clean.page);
		const corrupt = Buffer.from(bundleBytes);
		corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff;
		await clean.page.getByLabel("Import editable bundle").setInputFiles({
			name: "m7-corrupt.vlcampaign",
			mimeType: "application/octet-stream",
			buffer: corrupt,
		});
		await expect(clean.page.getByTestId("m7-live-status")).toContainText(
			"rolled back atomically",
			{ timeout: 60_000 },
		);
		expect(await campaignPersistenceCounts(clean.page)).toEqual(beforeCorrupt);
		expect(await mediaAssetCount(clean.page)).toBe(beforeCorruptMedia);
		expect(await originalFileNames(clean.page)).toEqual(beforeCorruptOriginals);
	} finally {
		await clean.context.close();
	}

	const longTasks = await page.evaluate(
		() => (window as Window & { __m7LongTasks?: number[] }).__m7LongTasks ?? [],
	);
	expect(longTasks).toEqual([]);
	const hostCpus = cpus();
	const performancePath = testInfo.outputPath("m7-performance.json");
	await writeFile(
		performancePath,
		JSON.stringify(
			{
				corpus:
					"8-cell local WebM VP9/Opus batch over three repository-generated AV scenes; active middle scene excluded; dedicated worker with 4 MiB OPFS chunks",
				browser: browserName,
				mainThreadLongTasksMs: longTasks,
				mainThreadEncodeLongTaskBudgetMs: 50,
				workerMessageReceiveLatencyMs: progressStaleness,
				workerMessageReceiveLatencyMaxMs: Math.max(...progressStaleness),
				visibleProgressCadenceMs: visibleProgressCadence.intervalsMs,
				visibleProgressCadenceMaxMs: Math.max(
					...visibleProgressCadence.intervalsMs,
				),
				visibleProgressCadenceBudgetMs: 1_000,
				previewInteractionDuringExport,
				artifact: renderedMedia,
				frozenManifest: frozenEvidence,
				hardware: {
					cpu: hostCpus[0]?.model ?? "unknown",
					logicalCpus: hostCpus.length,
					totalMemoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
					platform: platform(),
					release: release(),
					arch: arch(),
				},
			},
			null,
			2,
		),
		"utf8",
	);
	await testInfo.attach("m7-performance-and-frozen-manifest", {
		path: performancePath,
		contentType: "application/json",
	});
});

// These interaction contracts use English names; default Russian has its own M8 gate.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("variantlab:language", "en")); });

