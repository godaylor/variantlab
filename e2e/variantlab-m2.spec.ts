import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";

function percentile(values: number[], ratio: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? Number.POSITIVE_INFINITY;
}

async function generatedLicensed4kWebm(page: import("@playwright/test").Page): Promise<Buffer> {
	const bytes = await page.evaluate(async () => {
		const mimeType = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]
			.find((candidate) => MediaRecorder.isTypeSupported(candidate));
		if (!mimeType) throw new Error("This Chromium cannot create the repository-owned WebM fixture");
		const canvas = document.createElement("canvas");
		canvas.width = 3_840;
		canvas.height = 2_160;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas 2D unavailable");
		const audio = new AudioContext({ sampleRate: 48_000 });
		await audio.resume();
		const oscillator = audio.createOscillator();
		const gain = audio.createGain();
		const destination = audio.createMediaStreamDestination();
		gain.gain.value = 0.08;
		oscillator.frequency.value = 440;
		oscillator.connect(gain).connect(destination);
		oscillator.start();
		const canvasStream = canvas.captureStream(12);
		const stream = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 });
		recorder.addEventListener("dataavailable", (event) => { if (event.data.size > 0) chunks.push(event.data); });
		const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
		recorder.start(100);
		for (let frame = 0; frame < 24; frame += 1) {
			context.fillStyle = frame % 2 === 0 ? "#172128" : "#27475a";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = "#f0b44d";
			context.fillRect((frame * 180) % 3_000, 520, 720, 720);
			context.fillStyle = "white";
			context.font = "bold 160px sans-serif";
			context.fillText(`VariantLab fixture ${frame}`, 180, 340);
			await new Promise((resolve) => window.setTimeout(resolve, 85));
		}
		recorder.stop();
		await stopped;
		oscillator.stop();
		for (const track of stream.getTracks()) track.stop();
		await audio.close();
		return Array.from(new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer()));
	});
	return Buffer.from(bytes);
}

async function mediaRows(page: import("@playwright/test").Page) {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("variantlab-media-v1");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const readAll = (storeName: string) => new Promise<unknown[]>((resolve, reject) => {
			const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const [jobs, assets, derivatives] = await Promise.all([readAll("jobs"), readAll("assets"), readAll("derivatives")]);
		database.close();
		return { jobs, assets, derivatives };
	});
}

test("M2 import jobs recover and the rough cut has pointer/keyboard parity", async ({ page }, testInfo) => {
	test.setTimeout(150_000);
	await page.goto("/variantlab?m2WorkerDelayMs=2500&m2ExposeTestPipeline=1");
	await page.getByRole("button", { name: "+ New campaign" }).click();
	const mediaInput = page.getByLabel("Import master media", { exact: true });
	await expect(mediaInput).toBeAttached();
	const fixture = await generatedLicensed4kWebm(page);
	expect(fixture.byteLength).toBeGreaterThan(1_000);
	await mediaInput.setInputFiles({
		name: "variantlab-repository-4k-fixture.webm",
		mimeType: "video/webm",
		buffer: fixture,
	});

	const probe = page.getByTestId("job-probe");
	const proxy = page.getByTestId("job-proxy");
	const waveform = page.getByTestId("job-waveform");
	await expect(probe).toContainText("succeeded", { timeout: 30_000 });
	await expect(page.getByLabel("Master preview")).toBeVisible();
	await expect(proxy).toContainText("running", { timeout: 30_000 });
	const beforeReload = await mediaRows(page);
	const proxyBefore = (beforeReload.jobs as Array<{ job: { spec: { kind: string; job_id: string; idempotency_key: string }; attempt: { attempt: number } } }>).find((row) => row.job.spec.kind === "proxy")?.job;
	expect(proxyBefore?.attempt.attempt).toBe(1);

	await page.reload();
	await expect(proxy).toContainText("running", { timeout: 30_000 });
	await expect(proxy).toContainText("attempt 2");
	const afterReload = await mediaRows(page);
	const proxyAfter = (afterReload.jobs as Array<{ job: { spec: { kind: string; job_id: string; idempotency_key: string } } }>).find((row) => row.job.spec.kind === "proxy")?.job;
	expect(proxyAfter?.spec.job_id).toBe(proxyBefore?.spec.job_id);
	expect(proxyAfter?.spec.idempotency_key).toBe(proxyBefore?.spec.idempotency_key);
	await expect(proxy).toContainText("succeeded", { timeout: 30_000 });

	await expect(waveform).toContainText("running", { timeout: 30_000 });
	const preview = page.getByLabel("Master preview");
	await expect.poll(() => preview.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
	const previewSource = await preview.getAttribute("src");
	await page.evaluate(() => {
		const testWindow = window as typeof window & { __variantlabM2CrashWorker?: () => void };
		testWindow.__variantlabM2CrashWorker?.();
	});
	await expect(waveform).toContainText("failed", { timeout: 15_000 });
	await expect(waveform).toContainText("worker_crash");
	await expect(preview).toHaveAttribute("src", previewSource ?? "");
	await waveform.getByRole("button", { name: "Retry" }).click();
	await expect(waveform).toContainText("attempt 2", { timeout: 15_000 });
	await expect(waveform).toContainText("succeeded", { timeout: 90_000 });
	await expect(page.locator("[data-waveform-level]")).not.toHaveAttribute("data-waveform-level", "pending", { timeout: 15_000 });

	const completedMedia = await mediaRows(page);
	expect(completedMedia.assets).toHaveLength(1);
	expect(completedMedia.derivatives).toHaveLength(2);
	const derivativeKeys = new Set((completedMedia.derivatives as Array<{ idempotency_key: string }>).map((row) => row.idempotency_key));
	expect(derivativeKeys.size).toBe(2);

	const timeline = page.getByTestId("m2-timeline");
	let clips = timeline.locator("[data-clip-id]");
	await expect(clips).toHaveCount(1);
	await clips.first().click();
	await timeline.focus();
	await page.keyboard.press("l");
	await expect(page.getByText(/FORWARD 1/)).toBeVisible({ timeout: 500 });
	await page.keyboard.press("l");
	await expect(page.getByText(/FORWARD 2/)).toBeVisible({ timeout: 500 });
	await page.keyboard.press("k");
	for (let frame = 0; frame < 10; frame += 1) await page.keyboard.press(".");
	await page.keyboard.press("s");
	await expect(clips).toHaveCount(2);
	await timeline.focus();
	await page.keyboard.press("Control+a");
	await expect(page.getByText(/2 selected/)).toBeVisible();
	await page.keyboard.press("Alt+ArrowDown");
	await expect(page.getByTestId("save-status")).toContainText("revision 3");
	await page.keyboard.press("r");
	await page.keyboard.press(",");
	await page.keyboard.press("]");
	await expect(page.getByTestId("save-status")).toContainText("revision 4");

	await page.getByLabel("Timeline zoom").fill("120");
	clips = timeline.locator("[data-clip-id]");
	await clips.first().click();
	const clipBox = await clips.first().boundingBox();
	if (!clipBox) throw new Error("Timeline clip has no box");
	const revisionBeforeCancel = await page.getByTestId("save-status").textContent();
	await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(clipBox.x + clipBox.width / 2 + 48, clipBox.y + clipBox.height / 2);
	await page.keyboard.press("Escape");
	await page.mouse.up();
	expect(await page.getByTestId("save-status").textContent()).toBe(revisionBeforeCancel);

	await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2);
	await page.mouse.down();
	await page.keyboard.down("Shift");
	await page.mouse.move(clipBox.x + clipBox.width / 2 + 32, clipBox.y + clipBox.height / 2);
	await expect(page.getByText("Snap bypassed")).toBeVisible();
	await page.keyboard.press("Escape");
	await page.keyboard.up("Shift");
	await page.mouse.up();

	const listbox = timeline.getByRole("group", { name: "Timeline clips" });
	const listboxBox = await listbox.boundingBox();
	if (!listboxBox) throw new Error("Timeline listbox has no box");
	await page.mouse.move(listboxBox.x + 8, listboxBox.y + 82);
	await page.mouse.down();
	await page.mouse.move(listboxBox.x + 260, listboxBox.y + 175, { steps: 8 });
	await page.mouse.up();
	await expect(page.getByText(/2 selected/)).toBeVisible();

	await clips.first().click();
	await page.keyboard.press("Delete");
	await expect(clips).toHaveCount(1);
	await page.getByRole("button", { name: /02 Scene B/ }).click();
	await page.getByRole("button", { name: "Undo active scene" }).click();
	await page.getByRole("button", { name: /01 Scene A/ }).click();
	clips = page.getByTestId("m2-timeline").locator("[data-clip-id]");
	await expect(clips).toHaveCount(1);
	await page.getByRole("button", { name: "Undo active scene" }).click();
	await expect(clips).toHaveCount(2);

	await clips.first().focus();
	await page.keyboard.press("Enter");
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", { name: /Trim start of/ }).first()).toBeFocused();
	const accessibility = await new AxeBuilder({ page }).include("main").analyze();
	expect(accessibility.violations).toEqual([]);
	await page.screenshot({ path: testInfo.outputPath("m2-rough-cut-green.png"), fullPage: true });
});

test("M2 import rejects quota exhaustion and corrupt content before asset commit", async ({ page }) => {
	await page.addInitScript(() => {
		const open = IDBFactory.prototype.open;
		IDBFactory.prototype.open = function (...args: Parameters<IDBFactory["open"]>) {
			const request = open.apply(this, args);
			if (args[0] === "variantlab-media-v1") {
				const listen = request.addEventListener.bind(request);
				request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
					listen(type, type === "success" ? (event: Event) => {
						setTimeout(() => typeof listener === "function" ? listener.call(request, event) : listener.handleEvent(event), 500);
					} : listener, options);
				}) as typeof request.addEventListener;
			}
			return request;
		};
	});
	await page.goto("/variantlab");
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await page.evaluate(() => {
		const controlled = window as typeof window & {
			__m2OriginalEstimate?: StorageManager["estimate"];
		};
		controlled.__m2OriginalEstimate = navigator.storage.estimate.bind(navigator.storage);
		Object.defineProperty(navigator.storage, "estimate", {
			configurable: true,
			value: async () => ({ quota: 1, usage: 1 }),
		});
	});
	const input = page.getByLabel("Import master media", { exact: true });
	await input.setInputFiles({
		name: "quota-fixture.webm",
		mimeType: "video/webm",
		buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]),
	});
	await expect(page.getByText("Import stopped before the asset manifest was committed.")).toBeVisible();
	// The eventual initialization receipt must not overwrite the import failure.
	await page.waitForTimeout(600);
	await expect(page.getByText("Import stopped before the asset manifest was committed.")).toBeVisible();
	let rows = await mediaRows(page);
	expect(rows.jobs).toHaveLength(0);
	expect(rows.assets).toHaveLength(0);

	await page.evaluate(() => {
		const controlled = window as typeof window & {
			__m2OriginalEstimate?: StorageManager["estimate"];
		};
		if (controlled.__m2OriginalEstimate) {
			Object.defineProperty(navigator.storage, "estimate", {
				configurable: true,
				value: controlled.__m2OriginalEstimate,
			});
		}
	});
	await input.setInputFiles({
		name: "corrupt-fixture.mp4",
		mimeType: "video/mp4",
		buffer: Buffer.from("this is not a media container", "utf8"),
	});
	await expect(page.getByTestId("job-probe")).toContainText("failed", { timeout: 15_000 });
	await expect(page.getByText(/Import failed before the asset manifest was committed/)).toBeVisible();
	rows = await mediaRows(page);
	expect(rows.jobs).toHaveLength(1);
	expect(rows.assets).toHaveLength(0);
	expect(rows.derivatives).toHaveLength(0);
});

test("M2 reference corpus keeps interaction, command and DOM budgets", async ({ browser, browserName, page }, testInfo) => {
	test.skip(!testInfo.project.name.includes("production"), "The M2 performance budget is measured against the production bundle.");
	await page.goto("/variantlab/m2-performance");
	await expect(page.getByRole("heading", { name: "2h · 20 tracks · 10,000 clips" })).toBeVisible();
	const timeline = page.getByTestId("m2-timeline");
	await expect(timeline).toBeVisible();
	expect(await page.locator("[data-timeline-node]").count()).toBeLessThanOrEqual(300);

	await page.evaluate(() => {
		window.__variantlabM2Metrics = { pointerToPaintMs: [], reactCommitMs: [], rustApplyMs: [] };
		const measured = window as typeof window & { __m2LongTasks?: number[]; __m2LongTaskObserver?: PerformanceObserver };
		measured.__m2LongTasks = [];
		measured.__m2LongTaskObserver = new PerformanceObserver((entries) => {
			for (const entry of entries.getEntries()) measured.__m2LongTasks?.push(entry.duration);
		});
		measured.__m2LongTaskObserver.observe({ type: "longtask", buffered: false });
	});

	const clip = page.locator("[data-timeline-node] > button").first();
	await clip.click();
	const box = await clip.boundingBox();
	expect(box).not.toBeNull();
	if (!box) throw new Error("Reference clip has no layout box");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	for (let step = 1; step <= 24; step += 1) {
		await page.mouse.move(box.x + box.width / 2 + step * 3, box.y + box.height / 2);
		await page.waitForTimeout(18);
	}
	await page.mouse.up();

	const motion = await page.evaluate(async () => {
		const scroller = document.querySelector<HTMLElement>("[data-testid='m2-timeline']");
		const zoom = document.querySelector<HTMLInputElement>("input[aria-label='Timeline zoom']");
		if (!scroller || !zoom) throw new Error("Performance controls missing");
		const frames: number[] = [];
		for (let index = 0; index < 120; index += 1) {
			await new Promise<void>((resolve) => requestAnimationFrame((timestamp) => {
				frames.push(timestamp);
				scroller.scrollLeft = (index * 5_000) % Math.max(1, scroller.scrollWidth - scroller.clientWidth);
				if (index % 20 === 0) {
					zoom.value = String(index % 40 === 0 ? 18 : 62);
					zoom.dispatchEvent(new Event("input", { bubbles: true }));
					zoom.dispatchEvent(new Event("change", { bubbles: true }));
				}
				resolve();
			}));
		}
		return { frames: frames.length, elapsedMs: (frames.at(-1) ?? 0) - (frames[0] ?? 0) };
	});

	await page.waitForTimeout(100);
	const result = await page.evaluate(() => {
		const measured = window as typeof window & { __m2LongTasks?: number[]; __m2LongTaskObserver?: PerformanceObserver };
		measured.__m2LongTaskObserver?.disconnect();
		return { metrics: window.__variantlabM2Metrics, longTasks: measured.__m2LongTasks ?? [], nodes: document.querySelectorAll("[data-timeline-node]").length };
	});
	const metrics = result.metrics;
	expect(metrics?.pointerToPaintMs.length).toBeGreaterThanOrEqual(3);
	expect(metrics?.rustApplyMs.length).toBeGreaterThanOrEqual(3);
	const pointerP95 = percentile(metrics?.pointerToPaintMs ?? [], 0.95);
	const rustApplyP95 = percentile(metrics?.rustApplyMs ?? [], 0.95);
	const reactCommitP95 = percentile(metrics?.reactCommitMs ?? [], 0.95);
	const panZoomFps = ((motion.frames - 1) * 1_000) / Math.max(1, motion.elapsedMs);
	const maxLongTaskMs = Math.max(0, ...result.longTasks);

	const evidence = {
		fixture: "deterministic Rust timeline: 2 hours, 20 variable-height tracks, 10,000 clips",
		browser: browserName,
		browser_version: browser.version(),
		reference_hardware: {
			cpu: cpus()[0]?.model ?? "unknown",
			logical_cpus: cpus().length,
			memory_gib: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
			os: [platform(), release(), arch()].join(" "),
		},
		mounted_timeline_nodes: result.nodes,
		pointer_to_paint_p95_ms: pointerP95,
		rust_command_apply_p95_ms: rustApplyP95,
		react_commit_p95_ms: reactCommitP95,
		pan_zoom_fps: panZoomFps,
		max_long_task_ms: maxLongTaskMs,
		samples: { pointer: metrics?.pointerToPaintMs.length ?? 0, rust_apply: metrics?.rustApplyMs.length ?? 0, react_commit: metrics?.reactCommitMs.length ?? 0, frames: motion.frames },
	};
	await writeFile(testInfo.outputPath("m2-performance.json"), JSON.stringify(evidence, null, 2), "utf8");
	await page.screenshot({ path: testInfo.outputPath("m2-10k-timeline.png"), fullPage: true });

	expect(result.nodes).toBeLessThanOrEqual(300);
	expect(pointerP95).toBeLessThan(16.7);
	expect(rustApplyP95).toBeLessThan(8);
	expect(reactCommitP95).toBeLessThan(8);
	expect(panZoomFps).toBeGreaterThanOrEqual(55);
	const accessibility = await new AxeBuilder({ page }).include("main").analyze();
	expect(accessibility.violations).toEqual([]);
});

// These interaction contracts use English names; default Russian has its own M8 gate.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("variantlab:language", "en")); });


