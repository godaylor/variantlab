import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { verifyFiftyCellBatch } from "./m8-scale";
import { verifyChaosBatch } from "./m8-chaos";
import { verifyM9 } from "./m9-continuation";
import {
	addAuthoredOverlays,
	inspectOverlayVideo,
} from "./render-slot-fixture";

function databaseScalar(sql: string): string {
	return execFileSync("docker", ["exec", "variantlab-m8-postgres", "psql", "-U", "variantlab_admin", "-d", "variantlab", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
}

async function generatedWebm(page: Page): Promise<Buffer> {
	const fixtureNonce = randomUUID().slice(0, 8);
	const bytes = await page.evaluate(async (nonce) => {
		const mimeType = [
			"video/webm;codecs=vp8,opus",
			"video/webm;codecs=vp9,opus",
			"video/webm",
		].find((candidate) => MediaRecorder.isTypeSupported(candidate));
		if (!mimeType)
			throw new Error("Chromium cannot create the repository-owned M8 fixture");
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
		gain.gain.value = 0.05;
		oscillator.frequency.value = 440;
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
		for (let frame = 0; frame < 36; frame += 1) {
			context.fillStyle = frame % 2 === 0 ? "#172128" : "#d26532";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = "#f6f7f4";
			context.font = "bold 42px sans-serif";
			context.fillText(`VariantLab M8 / ${nonce} / ${frame}`, 48, 190);
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
	}, fixtureNonce);
	return Buffer.from(bytes);
}

test("M8 resumes upload and finishes a cloud batch after the tab closes", async ({
	page,
	context,
	request,
	browser,
	baseURL,
}, testInfo) => {
	// Crash recovery includes lease expiry plus a second complete render attempt.
	test.setTimeout(process.env.VARIANTLAB_SCALE_GATE === "1" ? 600_000 : process.env.VARIANTLAB_WORKER_CRASH_GATE === "1" ? 300_000 : 180_000);
	const accountEmail = `cloud-${randomUUID()}@example.invalid`;
	const accountPassword = `Fixture-${randomUUID()}`;
	let workerStopped = false;
	try {
		await page.goto("/variantlab");
		await page.getByRole("button", { name: "en", exact: true }).click();
		await page.getByRole("button", { name: "+ New campaign" }).click();
		await expect(page.getByTestId("save-status")).toContainText(
			"Saved locally",
		);
		if (process.env.VARIANTLAB_EXPECT_TEST_MODE_OFF === "1") {
			const account = page.getByRole("region", {
				name: "Connected account",
				exact: true,
			});
			await account
				.getByRole("button", { name: "Register", exact: true })
				.click();
			await account.getByLabel("Name", { exact: true }).fill("Cloud author");
			await account.getByLabel("Email", { exact: true }).fill(accountEmail);
			await account
				.getByLabel("Password", { exact: true })
				.fill(accountPassword);
			await account
				.getByRole("button", { name: "Create account", exact: true })
				.click();
			await expect(account).toContainText("Signed in: Cloud author");
		}

		const fixture = await generatedWebm(page);
		await testInfo.attach("source.webm", { body: fixture, contentType: "video/webm" });
		expect(fixture.byteLength).toBeGreaterThan(1_000);
		await page.getByLabel("Import master media").setInputFiles({
			name: "variantlab-m8-repository-fixture.webm",
			mimeType: "video/webm",
			buffer: fixture,
		});
		await expect(page.getByTestId("job-probe")).toContainText("succeeded", {
			timeout: 30_000,
		});
		await expect(page.getByTestId("job-proxy")).toContainText("succeeded", {
			timeout: 30_000,
		});
		await expect(page.getByTestId("job-waveform")).toContainText("succeeded", {
			timeout: 30_000,
		});
		await expect(page.getByTestId("save-status")).toContainText(
			"Saved locally",
		);
		await page.getByRole("button", { name: "Create adaptive 9:16" }).click();
		await addAuthoredOverlays(page);
		if (process.env.VARIANTLAB_SCALE_GATE === "1") {
			const matrix = page.getByTestId("variant-matrix");
			await matrix.getByRole("button", { name: "Add 16:9 + 1:1 profiles" }).click();
			await matrix.getByRole("button", { name: "Add review rows to 8" }).click();
			await matrix.getByText("Add a row or profile", { exact: true }).click();
			await matrix.getByLabel("Creative set name", { exact: true }).fill("Scale row 9");
			await matrix.getByRole("button", { name: "Add creative set", exact: true }).click();
			await expect(matrix.getByRole("grid")).toHaveAttribute("aria-rowcount", "9");
			for (let index = 0; index < 3; index++) {
				await matrix.getByLabel("Delivery profile name", { exact: true }).fill(`Scale profile ${index + 4}`);
				await matrix.getByRole("combobox", { name: "Copy profile settings", exact: true }).selectOption({ index });
				await matrix.getByRole("button", { name: "Add delivery profile", exact: true }).click();
				await expect(matrix.getByRole("grid")).toHaveAttribute("aria-colcount", String(index + 4));
			}
			await matrix.getByRole("button", { name: "Select first 50", exact: true }).click();
			const cell = matrix.getByRole("gridcell").first();
			await cell.focus(); await cell.press("Control+Enter");
			await expect(page.getByTestId("matrix-cell-count")).toContainText("50 / 100");
		}

		const board = page.getByRole("region", { name: "VariantLab cloud batch" });
		await expect(board.getByLabel("Source WebM").locator("option")).toHaveCount(
			2,
			{ timeout: 30_000 },
		);
		await board.getByLabel("Source WebM").selectOption({ index: 1 });
		await expect(board.getByLabel("Files for explicit upload")).toContainText(
			"Настоящий PNG.png",
		);

		const unauthenticated = await request.get("/api/variantlab/workspace");
		expect(unauthenticated.status()).toBe(401);
		const csrf = await request.post("/api/variantlab/uploads", {
			headers: { "x-variantlab-e2e": "1", "content-type": "application/json" },
			data: {
				campaign_id: "csrf",
				asset_hash: "0".repeat(64),
				content_type: "video/webm",
				total_bytes: 1,
			},
		});
		expect(csrf.status()).toBe(403);

		let interrupted = false;
		await page.route("**/api/variantlab/uploads/*/parts/*", async (route) => {
			if (!interrupted) {
				interrupted = true;
				await route.abort("internetdisconnected");
				return;
			}
			await route.continue();
		});
		await board.getByRole("button", { name: "Start cloud batch" }).click();
		await expect(board.getByRole("alert")).toBeVisible({ timeout: 30_000 });
		expect(interrupted).toBe(true);
		await page.unroute("**/api/variantlab/uploads/*/parts/*");

		expect(databaseScalar("SELECT count(*) FROM jobs WHERE state IN ('queued','preparing','running','cancelling')")).toBe("0");
		execFileSync("docker", ["stop", "variantlab-m8-worker"], { stdio: "pipe" });
		workerStopped = true;
		await board.getByRole("button", { name: "Start cloud batch" }).click();
		await expect(
			page.getByText(
				"Cloud batch accepted and will continue after the browser closes.",
			),
		).toBeVisible({ timeout: 30_000 });
		const batchId = await page.evaluate(() => {
			const key = Object.keys(localStorage).find((candidate) =>
				candidate.startsWith("variantlab:m8:batch:"),
			);
			return key ? localStorage.getItem(key) : null;
		});
		expect(batchId).toBeTruthy();

		await page.close();
		if (process.env.VARIANTLAB_CHAOS_GATE === "1") {
			await verifyChaosBatch(context, batchId!, testInfo);
			workerStopped = false;
			return;
		}
		execFileSync("docker", ["start", "variantlab-m8-worker"], {
			stdio: "pipe",
		});
		workerStopped = false;
		if (process.env.VARIANTLAB_SCALE_GATE === "1") {
			await verifyFiftyCellBatch(context, batchId!, testInfo);
			return;
		}
		if (process.env.VARIANTLAB_WORKER_CRASH_GATE === "1") {
			expect(batchId).toMatch(/^[a-f0-9-]{36}$/);
			await expect.poll(() => databaseScalar(`SELECT phase FROM jobs WHERE batch_id='${batchId}'`), { timeout: 15_000, intervals: [100, 200] }).toBe("rendering");
			expect(databaseScalar(`SELECT count(*) FROM jobs WHERE batch_id<>'${batchId}' AND state IN ('queued','preparing','running','cancelling')`)).toBe("0");
			execFileSync("docker", ["kill", "--signal=KILL", "variantlab-m8-worker"], { stdio: "pipe" });
			workerStopped = true;
			await expect.poll(() => databaseScalar(`SELECT state || ':' || attempt FROM jobs WHERE batch_id='${batchId}'`), { timeout: 60_000, intervals: [1000] }).toBe("queued:2");
			execFileSync("docker", ["start", "variantlab-m8-worker"], { stdio: "pipe" });
			workerStopped = false;
		}
		const reopened = await context.newPage();
		let interruptArtifactDownload = false;
		// Keep interception installed while media requests are active: changing
		// Chromium's interception patterns during recovery can stall the protocol.
		await reopened.route("**/api/variantlab/jobs/*/artifact", (route) =>
			interruptArtifactDownload
				? route.abort("internetdisconnected")
				: route.fallback(),
		);
		await reopened.goto("/variantlab");
		await expect(reopened.locator("html")).toHaveAttribute("lang", "en");
		const reopenedBoard = reopened.getByRole("region", {
			name: "VariantLab cloud batch",
		});
		await expect(reopenedBoard.getByText(/succeeded · 100%/)).toBeVisible({
			timeout: 90_000,
		});
		await expect(
			reopenedBoard.getByRole("button", { name: "Download" }),
		).toBeVisible();

		const jobsResponse = await context.request.get(
			`/api/variantlab/batches/${batchId}/jobs`,
			{ headers: { "x-variantlab-e2e": "1" } },
		);
		expect(jobsResponse.ok()).toBe(true);
		expect(jobsResponse.headers()["cache-control"]).toBe("no-store");
		expect(jobsResponse.headers()["x-content-type-options"]).toBe("nosniff");
		expect(jobsResponse.headers()["referrer-policy"]).toBe("no-referrer");
		const jobs = (await jobsResponse.json()) as {
			jobs: Array<{ id: string; state: string; artifact_ready: boolean }>;
		};
		expect(jobs.jobs).toHaveLength(1);
		expect(jobs.jobs[0]).toMatchObject({
			state: "succeeded",
			artifact_ready: true,
		});
		if (process.env.VARIANTLAB_WORKER_CRASH_GATE === "1") {
			expect(databaseScalar(`SELECT count(*) FROM export_artifacts WHERE job_id='${jobs.jobs[0].id}'`)).toBe("1");
			expect(databaseScalar(`SELECT count(*) FROM job_attempts WHERE job_id='${jobs.jobs[0].id}' AND finished_at IS NOT NULL`)).toBe("2");
		}
		const artifact = await context.request.get(
			`/api/variantlab/jobs/${jobs.jobs[0].id}/artifact`,
			{ headers: { "x-variantlab-e2e": "1" } },
		);
		expect(artifact.ok()).toBe(true);
		const receipt = (await artifact.json()) as {
			url: string;
			expires_in_seconds: number;
			sha256: string;
			byte_length: number;
		};
		expect(receipt.expires_in_seconds).toBe(300);
		expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(receipt.byte_length).toBeGreaterThan(1_000);
		expect(receipt.url).not.toContain("variantlab-m8-repository-fixture.webm");
		expect(new URL(receipt.url).origin).toBe("http://127.0.0.1:32212");
		const output = await request.get(receipt.url);
		expect(output.ok()).toBe(true);
		const outputBytes = await output.body();
		expect(outputBytes.byteLength).toBe(receipt.byte_length);
		const pixels = await inspectOverlayVideo(reopened, Array.from(outputBytes));
		expect(pixels.green).toBeGreaterThan(100);
		expect(pixels.blue).toBeGreaterThan(1000);
		if (process.env.VARIANTLAB_RENDER_PARITY_GATE === "1") {
			const local = reopened.getByRole("region", { name: "Render package", exact: true });
			await reopened.getByTestId("m7-cell-picker").locator('input[type="checkbox"]').first().check();
			await local.getByRole("button", { name: "Run preflight", exact: true }).click();
			await expect(reopened.getByTestId("m7-preflight")).toContainText("READY");
			await local.getByRole("button", { name: "Enqueue local batch", exact: true }).click();
			await expect(reopened.getByTestId("m7-job-center")).toContainText("succeeded · verified", { timeout: 60_000 });
			const pending = reopened.waitForEvent("download");
			await reopened.getByTestId("m7-artifacts").getByRole("button", { name: "Download", exact: true }).click();
			const path = testInfo.outputPath("parity-local.webm");
			await (await pending).saveAs(path);
			const localBytes = await readFile(path);
			await testInfo.attach("parity-cloud.webm", { body: outputBytes, contentType: "video/webm" });
			const parity = await reopened.evaluate(async ({ local, cloud }) => {
				async function frames(bytes: number[]) {
					const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/webm" }));
					const video = document.createElement("video"); video.muted = true; video.src = url;
					try {
						await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("parity decode failed")); });
						const canvas = document.createElement("canvas"); canvas.width = 108; canvas.height = 192;
						const ctx = canvas.getContext("2d")!; const samples: number[][] = [];
						// Sample inside output frames, not on a boundary where WebM
						// Opus pre-roll can shift the video presentation timestamp.
						for (const time of [0.317, 0.717, 1.217]) {
							await new Promise<void>((resolve) => { video.onseeked = () => resolve(); video.currentTime = time; });
							ctx.drawImage(video, 0, 0, 108, 192); samples.push(Array.from(ctx.getImageData(0, 0, 108, 192).data));
						}
						return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, samples };
					} finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
				}
				const a = await frames(local), b = await frames(cloud);
				return { dimensions: [a.width, a.height, b.width, b.height], durationDelta: Math.abs(a.duration-b.duration), frameMeanAbsoluteError: a.samples.map((sample, index) => sample.reduce((sum, value, channel) => sum + (channel % 4 === 3 ? 0 : Math.abs(value-b.samples[index][channel])), 0) / (108*192*3)) };
			}, { local: Array.from(localBytes), cloud: Array.from(outputBytes) });
			await testInfo.attach("render-parity.json", { body: JSON.stringify(parity, null, 2), contentType: "application/json" });
			expect(parity.dimensions).toEqual([1080, 1920, 1080, 1920]);
			expect(parity.durationDelta).toBeLessThanOrEqual(1/24);
			for (const error of parity.frameMeanAbsoluteError) expect(error).toBeLessThan(5);
			// Dedicated parity mode ends here. Auth/download/new-context and crash
			// have independent receipts; do not trigger another browser download.
			return;
		}
		expect(createHash("sha256").update(outputBytes).digest("hex")).toBe(
			receipt.sha256,
		);
		const dimensions = await reopened.evaluate(async (url) => {
			const video = document.createElement("video");
			try {
				video.src = url;
				await new Promise<void>((resolve, reject) => {
					video.onloadedmetadata = () => resolve();
					video.onerror = () =>
						reject(new Error("Downloaded artifact is not playable"));
				});
				return { width: video.videoWidth, height: video.videoHeight };
			} finally {
				// Release the metadata probe's range request after inspection.
				video.removeAttribute("src");
				video.load();
			}
		}, receipt.url);
		expect(dimensions).toEqual({ width: 1080, height: 1920 });
		const tampered = new URL(receipt.url);
		tampered.searchParams.set("X-Amz-Date", "20000101T000000Z");
		expect((await request.get(tampered.toString())).status()).toBe(403);
		expect(createHash("sha256").update(fixture).digest("hex")).toMatch(
			/^[a-f0-9]{64}$/,
		);
		const downloadErrors: string[] = [];
		reopened.on("pageerror", (error) => downloadErrors.push(error.message));
		interruptArtifactDownload = true;
		await reopenedBoard
			.getByRole("button", { name: "Download", exact: true })
			.click();
		await expect(reopenedBoard.getByRole("alert")).toContainText(
			"The operation did not complete",
		);
		expect(downloadErrors).toEqual([]);
		await reopened.getByRole("button", { name: "ru", exact: true }).click();
		await expect(
			reopened
				.getByRole("region", { name: "Облачный пакет VariantLab" })
				.getByRole("alert"),
		).toContainText("Операция не завершена");
		await reopened.getByRole("button", { name: "en", exact: true }).click();
		interruptArtifactDownload = false;
		const downloadPromise = reopened.waitForEvent("download");
		await reopenedBoard
			.getByRole("button", { name: "Download", exact: true })
			.click();
		expect((await downloadPromise).suggestedFilename()).toContain(".webm");
		await expect(reopenedBoard.getByRole("alert")).toHaveCount(0);
		if (process.env.VARIANTLAB_EXPECT_TEST_MODE_OFF === "1") {
			if (process.env.VARIANTLAB_M9_GATE !== "1") await reopened.close();
			const freshContext = await browser.newContext({ baseURL });
			try {
				const fresh = await freshContext.newPage();
				await fresh.goto("/variantlab");
				await fresh.getByRole("button", { name: "en", exact: true }).click();
				await fresh
					.getByRole("button", { name: "+ New campaign", exact: true })
					.click();
				const account = fresh.getByRole("region", {
					name: "Connected account",
					exact: true,
				});
				await account.getByLabel("Email", { exact: true }).fill(accountEmail);
				await account
					.getByLabel("Password", { exact: true })
					.fill(accountPassword);
				await account
					.getByRole("button", { name: "Sign in", exact: true })
					.click();
				await expect(account).toContainText("Signed in: Cloud author");
				if (process.env.VARIANTLAB_M9_GATE === "1") { await verifyM9({ author: reopened, second: fresh, browser, testInfo }); return; }
				await fresh
					.getByRole("button", { name: "Open server batches", exact: true })
					.click();
				await fresh
					.getByLabel("Saved server batch", { exact: true })
					.selectOption(batchId!);
				const cloud = fresh.getByRole("region", {
					name: "VariantLab cloud batch",
					exact: true,
				});
				await expect(cloud.getByText(/succeeded · 100%/)).toBeVisible();
				const download = fresh.waitForEvent("download");
				await cloud
					.getByRole("button", { name: "Download", exact: true })
					.click();
				expect((await download).suggestedFilename()).toContain(".webm");
			} finally {
				await freshContext.close();
			}
		}
	} finally {
		if (workerStopped)
			execFileSync("docker", ["start", "variantlab-m8-worker"], {
				stdio: "pipe",
			});
	}
});
