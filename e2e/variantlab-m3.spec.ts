import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";

function percentile(values: number[], ratio: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? Number.POSITIVE_INFINITY;
}

async function generatedLicensedMaster(page: import("@playwright/test").Page): Promise<Buffer> {
	const bytes = await page.evaluate(async () => {
		const mimeType = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"]
			.find((candidate) => MediaRecorder.isTypeSupported(candidate));
		if (!mimeType) throw new Error("Chromium cannot create the repository-owned M3 fixture");
		const canvas = document.createElement("canvas");
		canvas.width = 1_280;
		canvas.height = 720;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas 2D unavailable");
		const stream = canvas.captureStream(24);
		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(stream, {
			mimeType,
			videoBitsPerSecond: 1_800_000,
		});
		recorder.addEventListener("dataavailable", (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		});
		const stopped = new Promise<void>((resolve) =>
			recorder.addEventListener("stop", () => resolve(), { once: true }),
		);
		recorder.start(100);
		for (let frame = 0; frame < 48; frame += 1) {
			context.fillStyle = "#172128";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = "#d26532";
			context.fillRect((frame * 22) % 920, 180, 360, 360);
			context.fillStyle = "#ffd277";
			context.font = "bold 64px sans-serif";
			context.fillText("VariantLab 16:9 master", 80, 110);
			context.fillText(String(frame).padStart(2, "0"), 1_050, 650);
			await new Promise((resolve) => window.setTimeout(resolve, 42));
		}
		recorder.stop();
		await stopped;
		for (const track of stream.getTracks()) track.stop();
		return Array.from(
			new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer()),
		);
	});
	return Buffer.from(bytes);
}

test("M3 sequence changes preserve the scene-name draft", async ({ page }) => {
	await page.goto("/variantlab");
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	await page.getByLabel("Scene name").fill("Uncommitted scene draft");
	await page.getByRole("button", { name: "Create adaptive 9:16" }).click();
	await expect(page.getByTestId("save-status")).toContainText("revision 1");
	await expect(page.getByLabel("Scene name")).toHaveValue("Uncommitted scene draft");
});

test("M3 creates one deterministic adaptive 9:16 variant without copying the master", async ({
	browser,
	browserName,
	page,
}, testInfo) => {
	test.setTimeout(150_000);
	await page.goto("/variantlab");
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");

	await page.getByRole("button", { name: "Create adaptive 9:16" }).click();
	await expect(page.getByTestId("save-status")).toContainText("revision 1");
	const wall = page.getByTestId("variant-preview-wall");
	await expect(wall).toHaveAttribute("data-variant-fingerprint", /[a-f0-9]{64}/);
	const initialFingerprint = await wall.getAttribute("data-variant-fingerprint");
	await expect(page.getByText(/PROVENANCE ·/)).toContainText("canvas_safe_area←delivery_profile");
	await expect(page.getByText(/SAFE AREA/)).toBeVisible();

	const cropControl = page.getByRole("button", { name: /Adjust 9:16 crop/ });
	await cropControl.focus();
	await page.keyboard.press("ArrowRight");
	await expect(page.getByTestId("save-status")).toContainText("revision 2");
	await expect(page.getByText(/CROP X 100 · Y 0/)).toBeVisible();
	await page.getByRole("button", { name: "Undo 9:16 crop" }).click();
	await expect(page.getByText(/CROP X 0 · Y 0/)).toBeVisible();
	await page.getByRole("button", { name: "Reset crop" }).click();
	await expect(page.getByText(/CROP X 0 · Y 0/)).toBeVisible();

	const cropBox = await cropControl.boundingBox();
	if (!cropBox) throw new Error("9:16 crop control has no layout box");
	const revisionBeforeCancel = await page.getByTestId("save-status").textContent();
	await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(cropBox.x + cropBox.width / 2 + 25, cropBox.y + cropBox.height / 2 + 15);
	await page.keyboard.press("Escape");
	await page.mouse.up();
	expect(await page.getByTestId("save-status").textContent()).toBe(revisionBeforeCancel);

	await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(cropBox.x + cropBox.width / 2 + 30, cropBox.y + cropBox.height / 2 + 20, { steps: 4 });
	await page.mouse.up();
	await expect(page.getByText(/CROP X [1-9]/)).toBeVisible();
	const cropBeforeMasterEdit = await page.getByText(/CROP X/).textContent();
	const fingerprintBeforeMasterEdit = await wall.getAttribute("data-variant-fingerprint");

	await page.getByLabel("Scene name").fill("Scene A — inherited master edit");
	await page.getByRole("button", { name: "Save name" }).click();
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	expect(await page.getByText(/CROP X/).textContent()).toBe(cropBeforeMasterEdit);
	await expect(wall).not.toHaveAttribute(
		"data-variant-fingerprint",
		fingerprintBeforeMasterEdit ?? "",
	);
	expect(await wall.getAttribute("data-variant-fingerprint")).not.toBe(initialFingerprint);

	const fixture = await generatedLicensedMaster(page);
	await page.getByLabel("Import master media", { exact: true }).setInputFiles({
		name: "variantlab-m3-repository-master.webm",
		mimeType: "video/webm",
		buffer: fixture,
	});
	await expect(page.getByTestId("job-probe")).toContainText("succeeded", {
		timeout: 30_000,
	});
	await expect(page.getByLabel("Master preview")).toBeVisible();
	await page.getByRole("button", { name: "Play shared clock" }).click();
	await expect(page.getByTestId("shared-clock-state")).toContainText("FORWARD 1×");
	await page.waitForTimeout(250);
	await page.getByRole("button", { name: "Check snapshot / thumbnail / export" }).click();
	await expect(page.getByTestId("surface-isolation-status")).toHaveText(
		"SURFACES ISOLATED",
	);
	await page.evaluate(async () => {
		const video = document.querySelector<HTMLVideoElement>(
			"video[aria-label='Master preview']",
		);
		if (!video) throw new Error("Master preview missing for warm seek setup");
		await new Promise<void>((resolve) => {
			video.addEventListener("seeked", () => resolve(), { once: true });
			video.currentTime = Math.min(0.1, video.duration || 0.1);
		});
		const target = window as Window & {
			__variantlabM3Metrics?: {
				resolveSamplesMs: number[];
				warmSeekSamplesMs: number[];
			};
		};
		if (target.__variantlabM3Metrics) {
			target.__variantlabM3Metrics.warmSeekSamplesMs = [];
		}
	});
	await page.getByRole("button", { name: "Seek +5 s" }).click();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const target = window as Window & {
					__variantlabM3Metrics?: { warmSeekSamplesMs: number[] };
				};
				return target.__variantlabM3Metrics?.warmSeekSamplesMs.length ?? 0;
			}),
		)
		.toBeGreaterThanOrEqual(1);
	await expect(page.getByTestId("shared-clock-state")).toContainText("STOPPED");
	await page.getByRole("button", { name: "Previous frame" }).click();
	await page.getByRole("button", { name: "Next frame" }).click();


	// Measure actual keyboard commands; production does not run synthetic
	// resolver loops on every state update merely to populate benchmark samples.
	for (let sample = 0; sample < 20; sample += 1) {
		const before = await wall.getAttribute("data-variant-fingerprint");
		await cropControl.focus();
		await cropControl.press(sample % 2 === 0 ? "ArrowRight" : "ArrowLeft");
		await expect(wall).not.toHaveAttribute("data-variant-fingerprint", before ?? "");
		await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	}
	const metrics = await page.evaluate(() => {
		const target = window as Window & {
			__variantlabM3Metrics?: {
				resolveSamplesMs: number[];
				warmSeekSamplesMs: number[];
			};
		};
		return target.__variantlabM3Metrics;
	});
	const persistedFingerprint = await wall.getAttribute("data-variant-fingerprint");
	const persistedCrop = await page.getByText(/CROP X/).textContent();
	await page.reload();
	await expect(page.getByTestId("variant-preview-wall")).toHaveAttribute(
		"data-variant-fingerprint",
		persistedFingerprint ?? "",
	);
	expect(await page.getByText(/CROP X/).textContent()).toBe(persistedCrop);

	expect(metrics?.resolveSamplesMs.length).toBeGreaterThanOrEqual(20);
	expect(metrics?.warmSeekSamplesMs.length).toBeGreaterThanOrEqual(1);
	const resolveP95 = percentile(metrics?.resolveSamplesMs ?? [], 0.95);
	const warmSeekP95 = percentile(metrics?.warmSeekSamplesMs ?? [], 0.95);
	expect(resolveP95).toBeLessThan(10);
	expect(warmSeekP95).toBeLessThan(120);

	await page.setViewportSize({ width: 900, height: 900 });
	await expect(page.getByText("Review mode")).toBeVisible();
	await expect(page.getByText(/Portrait 9:16 · 1080×1920/)).toBeVisible();
	await expect(page.getByTestId("variant-preview-wall")).toBeHidden();
	const accessibility = await new AxeBuilder({ page }).include("main").analyze();
	expect(accessibility.violations).toEqual([]);

	const evidence = {
		fixture: "repository-generated 1280x720 WebM master; one explicit 1080x1920 DeliveryProfile",
		browser: browserName,
		browser_version: browser.version(),
		reference_hardware: {
			cpu: cpus()[0]?.model ?? "unknown",
			logical_cpus: cpus().length,
			memory_gib: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
			os: [platform(), release(), arch()].join(" "),
		},
		resolve_variant_p95_ms: resolveP95,
		warm_seek_p95_ms: warmSeekP95,
		resolve_samples: metrics?.resolveSamplesMs.length ?? 0,
		warm_seek_samples: metrics?.warmSeekSamplesMs.length ?? 0,
		fingerprint: persistedFingerprint,
		surface_isolation: "preview, snapshot, thumbnail, and export canvases remained distinct",
	};
	await writeFile(
		testInfo.outputPath("m3-performance.json"),
		JSON.stringify(evidence, null, 2),
		"utf8",
	);
	await page.screenshot({
		path: testInfo.outputPath("m3-responsive-review-green.png"),
		fullPage: true,
	});
});

// These interaction contracts use English names; default Russian has its own M8 gate.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("variantlab:language", "en")); });


