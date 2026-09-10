import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";

async function expectRevision(page: Page, revision: number) {
	await expect(page.getByTestId("save-status")).toContainText(
		"revision " + revision,
	);
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
}

async function generatedMaster(page: Page): Promise<Buffer> {
	const bytes = await page.evaluate(async () => {
		const mimeType = ["video/webm;codecs=vp8", "video/webm"].find((item) =>
			MediaRecorder.isTypeSupported(item),
		);
		if (!mimeType)
			throw new Error("Chromium cannot create the repository-owned M5 fixture");
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas 2D unavailable");
		const stream = canvas.captureStream(24);
		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(stream, { mimeType });
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
			await new Promise((resolve) => window.setTimeout(resolve, 42));
		}
		recorder.stop();
		await stopped;
		for (const mediaTrack of stream.getTracks()) mediaTrack.stop();
		return Array.from(
			new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer()),
		);
	});
	return Buffer.from(bytes);
}

test("M5 transcribes, edits locale captions, reloads, and focuses actionable diagnostics", async ({
	page,
	browserName,
}, testInfo) => {
	test.setTimeout(120_000);
	await page.goto("/variantlab");
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await expectRevision(page, 0);
	await page.getByRole("button", { name: "Create adaptive 9:16" }).click();
	await expectRevision(page, 1);

	const board = page.getByTestId("caption-locale-board");
	await board
		.getByRole("button", { name: "Start local transcription" })
		.click();
	await board.getByRole("button", { name: "Cancel transcription" }).click();
	await expect(page.getByTestId("transcription-status")).toHaveText(
		"cancelled",
	);

	await board
		.getByRole("button", { name: "Start local transcription" })
		.click();
	await board.getByRole("button", { name: "Simulate worker error" }).click();
	await expect(page.getByTestId("transcription-status")).toHaveText("failed");
	await board.getByRole("button", { name: "Retry transcription" }).click();
	await expect(page.getByTestId("transcription-status")).toHaveText(
		"succeeded",
	);
	await expectRevision(page, 2);

	const firstCaption = page.getByLabel(
		"Edit caption transcript-master-m5-cue-0",
	);
	await firstCaption.fill(
		"Очень длинный русский caption العربية with unsupported emoji 🚀 for diagnostics and readability",
	);
	await firstCaption.press("Enter");
	await expectRevision(page, 3);
	await board
		.getByRole("button", { name: "Add RU + RTL locale profile" })
		.click();
	await expectRevision(page, 4);
	await expect(page.getByTestId("locale-profile")).toContainText(
		"Locale ru-RU",
	);

	const diagnostics = page.getByTestId("text-diagnostics");
	await expect(diagnostics).toContainText("overflow");
	await expect(diagnostics).toContainText("missing glyph");
	await expect(diagnostics).toContainText("readability");
	await expect(diagnostics).toContainText("Fix:");
	await diagnostics
		.getByRole("button", { name: "Jump to exact caption" })
		.first()
		.click();
	await expect(firstCaption).toBeFocused();

	await page.reload();
	await page.waitForLoadState("domcontentloaded");
	await expect(page.getByTestId("locale-profile")).toContainText(
		"Locale ru-RU",
	);
	await expect(
		page.getByLabel("Edit caption transcript-master-m5-cue-0"),
	).toHaveValue(/Очень длинный/);
	await expect(page.getByTestId("text-diagnostics")).toContainText("Fix:");

	const fixture = await generatedMaster(page);
	await page.getByLabel("Import master media", { exact: true }).setInputFiles({
		name: "variantlab-m5-repository-master.webm",
		mimeType: "video/webm",
		buffer: fixture,
	});
	await expect(page.getByTestId("job-probe")).toContainText("succeeded", {
		timeout: 30_000,
	});
	await expect(page.getByLabel("Master preview")).toBeVisible();
	await board
		.getByRole("button", { name: "Start local transcription" })
		.click();
	await page.getByRole("button", { name: "Play shared clock" }).click();
	await expect(page.getByTestId("transcription-status")).toContainText(
		"yielding to playback",
	);
	const frameDeltas = await page.evaluate(async () => {
		const values: number[] = [];
		let previous = performance.now();
		for (let index = 0; index < 24; index += 1) {
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			const now = performance.now();
			values.push(now - previous);
			previous = now;
		}
		return values;
	});
	const ordered = frameDeltas.toSorted((left, right) => left - right);
	const p95 = ordered[Math.floor((ordered.length - 1) * 0.95)] ?? 0;
	expect(p95).toBeLessThan(20);
	await page.getByRole("button", { name: "Pause shared clock" }).click();

	const accessibility = await new AxeBuilder({ page })
		.include("[data-testid='caption-locale-board']")
		.analyze();
	expect(accessibility.violations).toEqual([]);
	const performancePath = testInfo.outputPath("m5-performance.json");
	const hostCpus = cpus();
	await writeFile(
		performancePath,
		JSON.stringify(
			{
				corpus:
					"24 animation frames while a repository-owned 640x360 WebM plays and transcription yields",
				browser: browserName,
				p95Ms: Number(p95.toFixed(2)),
				budgetMs: 20,
				hardware: {
					cpu: hostCpus[0] ? hostCpus[0].model : "unknown",
					logicalCpus: hostCpus.length,
					totalMemoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
					platform: platform(),
					release: release(),
				},
			},
			null,
			2,
		),
	);
	await testInfo.attach("m5-playback-analysis-budget", {
		path: performancePath,
		contentType: "application/json",
	});
	await page.screenshot({
		path: testInfo.outputPath("m5-caption-locale-green.png"),
		fullPage: true,
	});
});

// These interaction contracts use English names; default Russian has its own M8 gate.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("variantlab:language", "en")); });


