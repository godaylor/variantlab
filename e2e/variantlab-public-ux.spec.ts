import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("RU visitor can edit and export without signing in, with a clear cloud sign-in boundary", async ({ page }, testInfo) => {
	test.setTimeout(120_000);
	// Anonymous provider responses only; no authenticated test identity.
	await page.route("**/api/variantlab/session", route => route.fulfill({ json: { authenticated: false, render_configured: true, render_available: false } }));
	await page.route("**/api/variantlab/workspace", route => route.fulfill({ status: 401, json: { error: { code: "sign_in_required" } } }));
	await page.goto("/variantlab?publication=sites-connected");
	await expect(page.getByTestId("editor-access-help")).toContainText("Попробуйте без регистрации");
	await expect(page.getByLabel("Название новой кампании")).toBeEnabled();
	await page.getByLabel("Название новой кампании").fill("Первый ролик");
	await page.getByRole("button", { name: "+ Новая кампания", exact: true }).click();
	await expect(page.getByTestId("save-status")).toContainText("Сохранено локально");
	await expect(page.getByRole("heading", { name: "Первый ролик", exact: true })).toBeVisible();
	const bytes = await page.evaluate(async () => {
		const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
		const ctx = canvas.getContext("2d")!;
		const stream = canvas.captureStream(20), chunks: Blob[] = [];
		const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
		recorder.ondataavailable = event => chunks.push(event.data);
		const done = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
		recorder.start();
		for (let i = 0; i < 20; i++) { ctx.fillStyle = i % 2 ? "#194f78" : "#dfc86f"; ctx.fillRect(0, 0, 320, 180); await new Promise(resolve => setTimeout(resolve, 50)); }
		recorder.stop(); await done; stream.getTracks().forEach(track => track.stop());
		return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
	});
	await page.getByLabel("Добавить видео или аудио").setInputFiles({ name: "Исходник.webm", mimeType: "video/webm", buffer: Buffer.from(bytes) });
	await expect(page.getByTestId("save-status")).toContainText("версия 1", { timeout: 30_000 });
	await page.getByRole("button", { name: "Создать вертикальную версию 9:16", exact: true }).click();
	await page.getByRole("button", { name: "Добавить форматы 16:9 и 1:1", exact: true }).click();
	const newCells = page.getByRole("gridcell", { name: /выключено/ });
	await expect(newCells).toHaveCount(2);
	for (const cell of await newCells.all()) await cell.click();
	await page.getByRole("button", { name: "Включить 2 выбрано", exact: true }).click();
	await expect(page.getByTestId("matrix-cell-count")).toContainText("3 / 100");
	const picker = page.getByTestId("m7-cell-picker").getByRole("checkbox");
	for (const checkbox of await picker.all()) await checkbox.check();
	await page.getByRole("link", { name: "Экспорт", exact: true }).click();
	const board = page.getByRole("region", { name: "Экспорт видео", exact: true });
	await board.getByRole("button", { name: "Проверить перед экспортом", exact: true }).click();
	await expect(page.getByTestId("m7-preflight")).toContainText("ГОТОВО К ЭКСПОРТУ");
	await board.getByRole("button", { name: "Создать видео на устройстве", exact: true }).click();
	await expect(page.getByTestId("m7-artifacts").getByRole("button", { name: "Скачать", exact: true })).toHaveCount(3, { timeout: 90_000 });
	const downloadPromise = page.waitForEvent("download");
	await page.getByTestId("m7-artifacts").getByRole("button", { name: "Скачать", exact: true }).first().click();
	const file = testInfo.outputPath("visitor-export.webm");
	await (await downloadPromise).saveAs(file);
	expect((await readFile(file)).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
	await page.getByRole("button", { name: "Сохранить кампанию в облако", exact: true }).click();
	await expect(page.getByRole("region", { name: "Синхронизация и согласование" }).getByRole("alert")).toContainText("войдите в свой аккаунт");
	await expect(page.getByRole("button", { name: "Загрузить оригиналы в облако", exact: true })).toBeDisabled();
	await page.reload();
	await expect(page.getByRole("heading", { name: "Первый ролик", exact: true })).toBeVisible();
	await expect(page.getByTestId("m7-artifacts").getByRole("button", { name: "Скачать", exact: true })).toHaveCount(3);
});
