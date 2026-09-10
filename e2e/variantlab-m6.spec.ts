import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";

async function expectRevision(page: Page, revision: number) {
	await expect(page.getByTestId("save-status")).toContainText(
		`revision ${revision}`,
	);
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
}

function brandKit(version: number) {
	return {
		id: "brand-kit-launch",
		name: "Launch BrandKit",
		version,
		fingerprint: "",
		provenance: {
			source: "repo-e2e-fixture",
			revision: `fixture-${version}`,
			asset_hash: "b".repeat(64),
		},
		logo_required: true,
		allowed_color_tokens: [],
		allowed_font_ids: [],
		minimum_text_size_px: 40,
		custom_safe_regions: [
			{
				id: "brand-copy",
				safe_area: {
					top_basis_points: 1_200,
					right_basis_points: 1_200,
					bottom_basis_points: 1_200,
					left_basis_points: 1_200,
				},
			},
		],
		master_duration: null,
	};
}

async function importKit(page: Page, version: number) {
	await page.getByLabel("Import versioned BrandKit JSON").setInputFiles({
		name: `brand-kit-v${version}.json`,
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(brandKit(version))),
	});
}

test("M6 builds an explicit 100-cell matrix, applies BrandKit QA, and keeps the Prism bounded", async ({
	page,
	browserName,
}, testInfo) => {
	test.setTimeout(180_000);
	await page.goto("/variantlab");
	await expect(page.getByRole("button", { name: "+ New campaign" })).toBeEnabled();
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await expectRevision(page, 0);
	await page.getByRole("button", { name: "Create adaptive 9:16" }).click();
	await expectRevision(page, 1);

	const firstRunStartedAt = Date.now();
	const matrix = page.getByTestId("variant-matrix");
	await matrix.getByRole("button", { name: "Add 16:9 + 1:1 profiles" }).click();
	await expectRevision(page, 2);
	await matrix.getByRole("button", { name: "Add review rows to 8" }).click();
	await expectRevision(page, 3);
	await matrix.getByRole("button", { name: "Select first 24" }).click();
	await expect(page.getByTestId("matrix-cost-preview")).toContainText(
		"24 cells",
	);
	await expect(page.getByTestId("matrix-cost-preview")).toContainText(
		"no Cartesian materialization",
	);
	await matrix.getByRole("button", { name: "Enable 24 selected" }).click();
	await expectRevision(page, 4);
	await expect(page.getByTestId("matrix-cell-count")).toContainText("24 / 100");
	const firstRunElapsedMs = Date.now() - firstRunStartedAt;

	const firstCell = matrix.getByRole("gridcell").first();
	await firstCell.focus();
	await firstCell.press("ArrowRight");
	await expect(page.locator(":focus")).toHaveAttribute("aria-colindex", "2");
	await page.locator(":focus").press("End");
	await expect(page.locator(":focus")).toHaveAttribute("aria-colindex", "3");
	await page.locator(":focus").press("Control+End");
	await expect(page.locator(":focus")).toHaveAttribute("aria-rowindex", "8");
	await page.locator(":focus").press("Space");
	await expect(page.locator(":focus")).toHaveAttribute("aria-selected", "true");

	await importKit(page, 1);
	await expectRevision(page, 5);
	await expect(page.getByTestId("brand-kit-receipt")).toContainText(
		"repo-e2e-fixture@fixture-1",
	);
	const diagnostics = page.getByTestId("m6-diagnostics");
	await expect(diagnostics).toContainText("brand.logo_required");
	await expect(diagnostics).toContainText("brand.minimum_text_size");
	await expect(diagnostics).toContainText("brand.safe_region");
	await expect(diagnostics).toContainText("SOURCE repo-e2e-fixture");
	await diagnostics
		.getByRole("button", { name: /Focus exact cell/ })
		.first()
		.click();
	await expect(page.locator(":focus")).toHaveAttribute("role", "gridcell");

	await page
		.getByRole("button", { name: "Declare standard creative slots" })
		.click();
	await expectRevision(page, 6);
	await expect(diagnostics).not.toContainText("brand.logo_required");
	await expect(diagnostics).toContainText("brand.minimum_text_size");
	await expect(diagnostics).toContainText("brand.safe_region");
	const textRule = diagnostics
		.getByRole("listitem")
		.filter({ hasText: "brand.minimum_text_size" })
		.first();
	await textRule
		.getByRole("button", { name: /Focus exact cell \/ slot/ })
		.click();
	await expect(page.locator(":focus")).toHaveAttribute(
		"data-slot-id",
		"slot-cta",
	);

	await page
		.getByRole("button", { name: "Apply BrandKit text + safe-area fixes" })
		.click();
	await expectRevision(page, 7);
	await expect(diagnostics).not.toContainText("brand.minimum_text_size");
	await expect(diagnostics).not.toContainText("brand.safe_region");

	await importKit(page, 2);
	await expectRevision(page, 8);
	await expect(page.getByTestId("brand-kit-receipt")).toContainText(
		"repo-e2e-fixture@fixture-2",
	);
	await expect(diagnostics).not.toContainText("brand.minimum_text_size");
	await expect(diagnostics).not.toContainText("brand.safe_region");

	const grid = matrix.getByRole("grid", {
		name: "Creative sets by delivery profiles",
	});
	await expect(grid).toHaveAttribute("aria-rowcount", "8");
	await expect(grid).toHaveAttribute("aria-colcount", "3");
	let domCells = Number(
		(await page.getByTestId("matrix-dom-count").textContent())?.match(
			/DOM GRIDCELLS (\d+)/,
		)?.[1] ?? "999",
	);
	expect(domCells).toBeLessThanOrEqual(80);

	const corpusStep = page.getByTestId("m6-corpus-step");
	for (let revision = 9; revision <= 14; revision += 1) {
		await corpusStep.click();
		await expectRevision(page, revision);
	}
	await expect(corpusStep).toHaveText("Select first 100 explicit cells");
	await corpusStep.click();
	await expect(page.getByTestId("matrix-cost-preview")).toContainText(
		"100 cells",
	);
	const capacityCell = matrix.getByRole("gridcell").first();
	await capacityCell.focus();
	await capacityCell.press("Control+Enter");
	await expectRevision(page, 15);
	await expect(page.getByTestId("matrix-cell-count")).toContainText(
		"100 / 100",
	);
	await expect(grid).toHaveAttribute("aria-rowcount", "12");
	await expect(grid).toHaveAttribute("aria-colcount", "9");
	domCells = Number(
		(await page.getByTestId("matrix-dom-count").textContent())?.match(
			/DOM GRIDCELLS (\d+)/,
		)?.[1] ?? "999",
	);
	expect(domCells).toBeLessThanOrEqual(80);
	const matrixMetrics = await page.evaluate(() => {
		const metrics = (
			window as Window & {
				__variantlabM6Metrics?: {
					renders: number;
					projectionSamplesMs: number[];
				};
			}
		).__variantlabM6Metrics;
		return metrics ?? { renders: 0, projectionSamplesMs: [] };
	});
	const latestProjectionMs = matrixMetrics.projectionSamplesMs.at(-1) ?? 999;
	expect(latestProjectionMs).toBeLessThan(100);
	expect(matrixMetrics.renders).toBeLessThan(200);

	const viewport = page.getByTestId("matrix-viewport");
	const traceSession = await page.context().newCDPSession(page);
	await traceSession.send("Tracing.start", { categories: "devtools.timeline,v8.execute,blink.user_timing", transferMode: "ReturnAsStream" });
	const frameDeltas = await viewport.evaluate(async (element) => {
		const values: number[] = [];
		let previous = performance.now();
		for (let index = 0; index < 30; index += 1) {
			element.scrollTop =
				(element.scrollHeight - element.clientHeight) * ((index + 1) / 30);
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
	const traceDone = new Promise<{ stream: string }>(resolve => traceSession.once("Tracing.tracingComplete", resolve));
	await traceSession.send("Tracing.end");
	const { stream } = await traceDone;
	let browserTrace = "";
	for (;;) { const chunk = await traceSession.send("IO.read", { handle: stream }); browserTrace += chunk.data; if (chunk.eof) break; }
	await traceSession.send("IO.close", { handle: stream });
	await traceSession.detach();
	await writeFile(testInfo.outputPath("m6-browser-trace.json"), browserTrace);
	await testInfo.attach("m6-frame-deltas", { body: JSON.stringify(frameDeltas), contentType: "application/json" });
	const p95 = ordered[Math.floor((ordered.length - 1) * 0.95)] ?? 999;
	const scrollFps =
		(frameDeltas.length * 1_000) /
		Math.max(1, frameDeltas.reduce((total, sample) => total + sample, 0));
	expect(scrollFps).toBeGreaterThanOrEqual(55);

	const decoderTiles = page.locator("[data-decoder-quality]");
	expect(
		await page.locator('[data-decoder-quality="full"]').count(),
	).toBeLessThanOrEqual(1);
	expect(await decoderTiles.count()).toBeLessThanOrEqual(24);

	await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
	await page.evaluate(() => {
		document.documentElement.style.zoom = "2";
	});
	const accessibility = await new AxeBuilder({ page })
		.include("[data-testid='variant-matrix']")
		.analyze();
	expect(accessibility.violations).toEqual([]);
	await page.evaluate(() => {
		document.documentElement.style.zoom = "";
	});

	await page.reload();
	await page.waitForLoadState("domcontentloaded");
	await expect(page.getByTestId("matrix-cell-count")).toContainText(
		"100 / 100",
	);
	await expect(page.getByTestId("brand-kit-receipt")).toContainText(
		"repo-e2e-fixture@fixture-2",
	);

	await page.goto("/variantlab?m6_reference=1");
	await expect(page.getByRole("button", { name: "+ New campaign" })).toBeEnabled();
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await expectRevision(page, 0);
	await expect(page.getByTestId("m2-timeline")).toHaveAttribute(
		"data-timeline-element-count",
		"5000",
	);
	await page.getByRole("button", { name: "Create adaptive 9:16" }).click();
	await expectRevision(page, 1);
	await matrix.getByRole("button", { name: "Add 16:9 + 1:1 profiles" }).click();
	await expectRevision(page, 2);
	await matrix.getByRole("button", { name: "Add review rows to 8" }).click();
	await expectRevision(page, 3);
	const stressCorpusStep = page.getByTestId("m6-corpus-step");
	await stressCorpusStep.click();
	await expectRevision(page, 4);
	await stressCorpusStep.click();
	await expectRevision(page, 5);
	const stressCell = matrix.getByRole("gridcell").first();
	await stressCell.focus();
	await stressCell.press("Control+a");
	await expect(page.getByTestId("matrix-cost-preview")).toContainText("72 cells");
	await stressCell.press("Control+Enter");
	await expectRevision(page, 6);
	await expect(page.getByTestId("matrix-cell-count")).toContainText("72 / 100");

	const reopenStartedAt = Date.now();
	await page.reload();
	await page.waitForLoadState("domcontentloaded");
	await expect(page.getByTestId("matrix-cell-count")).toContainText("72 / 100");
	await expect(page.getByTestId("m2-timeline")).toHaveAttribute(
		"data-timeline-element-count",
		"5000",
	);
	const warmOpenMs = Date.now() - reopenStartedAt;
	expect(warmOpenMs).toBeLessThan(2_000);

	const metricsPath = testInfo.outputPath("m6-performance.json");
	const hostCpus = cpus();
	await writeFile(
		metricsPath,
		JSON.stringify(
			{
				corpus:
					"projection/scroll: 12 creative rows, 9 explicit profiles, 100 enabled cells; warm open: 2-hour/20-track/5,000-element Rust timeline with 72 explicit cells; semantic window capped at 80; 30 rAF scroll samples",
				browser: browserName,
				scrollP95Ms: Number(p95.toFixed(2)),
				scrollFps: Number(scrollFps.toFixed(2)),
				scrollFloorFps: 55,
				warmOpenMs,
				warmOpenBudgetMs: 2_000,
				firstRun24Ms: firstRunElapsedMs,
				firstRunActions: 4,
				domCellCount: domCells,
				domCellBudget: 80,
				latestProjectionMs: Number(latestProjectionMs.toFixed(2)),
				projectionBudgetMs: 100,
				matrixRenderCount: matrixMetrics.renders,
				hardware: {
					cpu: hostCpus[0]?.model ?? "unknown",
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
	await testInfo.attach("m6-performance-budget", {
		path: metricsPath,
		contentType: "application/json",
	});
	await page.screenshot({
		path: testInfo.outputPath("m6-variant-matrix-green.png"),
		fullPage: true,
	});
});

// These interaction contracts use English names; default Russian has its own M8 gate.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("variantlab:language", "en")); });

