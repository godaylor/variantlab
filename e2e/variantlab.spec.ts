import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";

async function seedLegacyProject(page: import("@playwright/test").Page) {
	await page.evaluate(async () => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open("video-editor-projects", 1);
			request.addEventListener("upgradeneeded", () => {
				const database = request.result;
				if (!database.objectStoreNames.contains("projects")) {
					database.createObjectStore("projects", { keyPath: "id" });
				}
			});
			request.addEventListener("error", () => reject(request.error));
			request.addEventListener("success", () => {
				const database = request.result;
				const transaction = database.transaction("projects", "readwrite");
				transaction.objectStore("projects").put({
					id: "legacy-launch",
					name: "Legacy Launch",
					version: 31,
					unknownFutureField: { retained: true },
					scenes: [
						{ id: "legacy-a", name: "Scene A" },
						{ id: "legacy-b", name: "Scene B" },
					],
				});
				transaction.addEventListener("complete", () => {
					database.close();
					resolve();
				});
				transaction.addEventListener("error", () => reject(transaction.error));
			});
		});
	});
}

test("campaign survives scoped undo, close/reopen, and quota retry", async ({
	page,
	context,
}, testInfo) => {
	await context.route("**/*", async (route) => {
		const hostname = new URL(route.request().url()).hostname;
		if (hostname === "127.0.0.1" || hostname === "localhost") {
			await route.continue();
			return;
		}
		await route.abort("internetdisconnected");
	});
	await page.goto("/variantlab");
	await seedLegacyProject(page);
	await page.reload();

	await page.getByRole("button", { name: "Import Legacy Launch" }).click();
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	await expect(
		page.getByRole("heading", { name: "Legacy Launch" }),
	).toBeVisible();

	const legacyBefore = await page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("video-editor-projects");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const transaction = database.transaction("projects", "readonly");
		const value = await new Promise<unknown>((resolve, reject) => {
			const request = transaction.objectStore("projects").get("legacy-launch");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		database.close();
		return JSON.stringify(value);
	});

	const sceneName = page.getByLabel("Scene name");
	await sceneName.fill("Hook winner");
	await sceneName.press("Tab");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	await expect(page.getByTestId("save-status")).toContainText("revision 1");
	const receiptText = await page
		.getByText(/received a durable journal receipt in/i)
		.textContent();
	const receiptMatch = receiptText?.match(/([0-9.]+) ms/);
	expect(Number(receiptMatch?.[1])).toBeLessThan(100);
	await page.screenshot({
		path: testInfo.outputPath("saved-locally.png"),
		fullPage: true,
	});

	await page.getByRole("button", { name: /02 Scene B/ }).click();
	const beforeNoopUndo = await page.getByTestId("save-status").textContent();
	await page.getByRole("button", { name: "Undo active scene" }).click();
	// A scoped no-op must not emit a notification or create a durable revision.
	expect(await page.getByTestId("save-status").textContent()).toBe(beforeNoopUndo);
	await page.getByRole("button", { name: /01 Hook winner/ }).click();
	await expect(
		page.getByRole("heading", { name: "Hook winner" }),
	).toBeVisible();

	const accessibility = await new AxeBuilder({ page })
		.include("main")
		.analyze();
	expect(accessibility.violations).toEqual([]);

	await page.close();
	const reopened = await context.newPage();
	await reopened.goto("/variantlab");
	await expect(
		reopened.getByRole("heading", { name: "Hook winner" }),
	).toBeVisible();

	await reopened.getByRole("button", { name: "Fail next write" }).click();
	await reopened.getByLabel("Scene name").fill("Quota recovered");
	await reopened.getByRole("button", { name: "Save name" }).click();
	await expect(
		reopened.getByText("Save failed — campaign is dirty", { exact: true }),
	).toBeVisible();
	await expect(reopened.getByTestId("save-status")).toContainText(
		"Save failed",
	);
	await reopened.screenshot({
		path: testInfo.outputPath("save-failed-dirty.png"),
		fullPage: true,
	});
	await reopened.getByRole("button", { name: "Retry save" }).focus();
	await reopened.keyboard.press("Enter");
	await expect(reopened.getByTestId("save-status")).toContainText(
		"Saved locally",
	);
	await expect(
		reopened.getByRole("heading", { name: "Quota recovered" }),
	).toBeVisible();
	await reopened.screenshot({
		path: testInfo.outputPath("recovered-after-retry.png"),
		fullPage: true,
	});

	await reopened.locator("main").focus();
	await reopened.keyboard.press("Control+z");
	await expect(
		reopened.getByRole("heading", { name: "Hook winner" }),
	).toBeVisible();

	const legacyAfter = await reopened.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("video-editor-projects");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const transaction = database.transaction("projects", "readonly");
		const value = await new Promise<unknown>((resolve, reject) => {
			const request = transaction.objectStore("projects").get("legacy-launch");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		database.close();
		return JSON.stringify(value);
	});
	expect(legacyAfter).toBe(legacyBefore);
});

test("sub-1024 viewport provides deliberate review mode", async ({ page }) => {
	await page.setViewportSize({ width: 800, height: 900 });
	await page.goto("/variantlab");
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await expect(page.getByText("Review mode")).toBeVisible();
	await expect(page.getByLabel("Scene name")).toBeHidden();
});

test("1280 viewport keeps the full editor", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/variantlab");
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await expect(page.getByText("Review mode")).toBeHidden();
	await expect(page.getByLabel("Scene name")).toBeVisible();
});

test("durable receipt p95 and compaction stay within M1 budgets", async ({
	browser,
	browserName,
	page,
}, testInfo) => {
	await page.goto("/variantlab");
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await page.evaluate(() => {
		const durations: number[] = [];
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) durations.push(entry.duration);
		});
		observer.observe({ type: "longtask", buffered: false });
		const measuredWindow = window as typeof window & {
			__variantlabLongTasks?: number[];
			__variantlabLongTaskObserver?: PerformanceObserver;
		};
		measuredWindow.__variantlabLongTasks = durations;
		measuredWindow.__variantlabLongTaskObserver = observer;
	});

	const receipts: number[] = [];
	const sceneName = page.getByLabel("Scene name");
	for (let revision = 1; revision <= 55; revision += 1) {
		await sceneName.fill("Receipt sample " + revision);
		await page.getByRole("button", { name: "Save name" }).click();
		await expect(page.getByTestId("save-status")).toContainText(
			"revision " + revision,
		);
		const receiptText = await page
			.getByText(/received a durable journal receipt in/i)
			.textContent();
		const receipt = Number(receiptText?.match(/([0-9.]+) ms/)?.[1]);
		expect(Number.isFinite(receipt)).toBe(true);
		receipts.push(receipt);
	}
	await page.waitForTimeout(500);

	const longTasks = await page.evaluate(() => {
		const measuredWindow = window as typeof window & {
			__variantlabLongTasks?: number[];
			__variantlabLongTaskObserver?: PerformanceObserver;
		};
		measuredWindow.__variantlabLongTaskObserver?.disconnect();
		return measuredWindow.__variantlabLongTasks ?? [];
	});
	const compactionCounts = await page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("variantlab-studio-v1");
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () => reject(request.error));
		});
		const transaction = database.transaction(
			["journal", "snapshots"],
			"readonly",
		);
		const count = (storeName: string) =>
			new Promise<number>((resolve, reject) => {
				const request = transaction.objectStore(storeName).count();
				request.addEventListener("success", () => resolve(request.result));
				request.addEventListener("error", () => reject(request.error));
			});
		const [journalRows, snapshotRows] = await Promise.all([
			count("journal"),
			count("snapshots"),
		]);
		database.close();
		return { journalRows, snapshotRows };
	});
	const sortedReceipts = [...receipts].sort((left, right) => left - right);
	const p95Index = Math.ceil(sortedReceipts.length * 0.95) - 1;
	const receiptP95 = sortedReceipts[p95Index] ?? Number.POSITIVE_INFINITY;
	const maxLongTask = Math.max(0, ...longTasks);
	const evidence = {
		fixture: "one-scene campaign, 55 sequential rename journal commits",
		browser: browserName,
		browser_version: browser.version(),
		reference_hardware: {
			cpu: cpus()[0]?.model ?? "unknown",
			logical_cpus: cpus().length,
			memory_gib: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
			os: [platform(), release(), arch()].join(" "),
		},
		samples: receipts.length,
		receipt_p95_ms: receiptP95,
		max_long_task_ms: maxLongTask,
		journal_rows_after_compaction: compactionCounts.journalRows,
		snapshot_rows_after_compaction: compactionCounts.snapshotRows,
	};
	await writeFile(
		testInfo.outputPath("m1-performance.json"),
		JSON.stringify(evidence, null, 2),
		"utf8",
	);

	expect(receiptP95).toBeLessThan(100);
	expect(maxLongTask).toBeLessThanOrEqual(50);
	expect(compactionCounts.journalRows).toBeLessThan(50);
	expect(compactionCounts.snapshotRows).toBeGreaterThan(1);
});
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("variantlab:language", "en")); });
