import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("explicit master placement preserves legacy slots, language and scoped undo", async ({
	page,
}) => {
	test.setTimeout(120000);
	page.on("pageerror", (error) =>
		console.error("Binding fixture runtime error:", error.message),
	);
	await page.goto("/variantlab");
	await page.waitForLoadState("networkidle");
	await page
		.getByRole("button", { name: "+ Новая кампания", exact: true })
		.click();
	await expect(page.getByTestId("save-status")).toContainText("версия 0");
	const bytes = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 320;
		canvas.height = 180;
		const context = canvas.getContext("2d")!;
		const stream = canvas.captureStream(20);
		const recorder = new MediaRecorder(stream, {
			mimeType: "video/webm;codecs=vp8",
		});
		const parts: Blob[] = [];
		recorder.ondataavailable = (event) => parts.push(event.data);
		const done = new Promise<void>((resolve) => {
			recorder.onstop = () => resolve();
		});
		recorder.start();
		for (let i = 0; i < 20; i++) {
			context.fillStyle = i % 2 ? "#194f78" : "#dfc86f";
			context.fillRect(0, 0, 320, 180);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		recorder.stop();
		await done;
		stream.getTracks().forEach((track) => track.stop());
		return Array.from(
			new Uint8Array(
				await new Blob(parts, { type: "video/webm" }).arrayBuffer(),
			),
		);
	});
	await page.getByLabel("Добавить видео или аудио").setInputFiles({
		name: "Свой исходник.webm",
		mimeType: "video/webm",
		buffer: Buffer.from(bytes),
	});
	await expect(page.getByTestId("save-status")).toContainText("версия 1", {
		timeout: 30000,
	});
	await page
		.getByRole("button", {
			name: "Создать стандартные креативные слоты",
			exact: true,
		})
		.click();
	const board = page.getByRole("region", {
		name: "Явные привязки master",
		exact: true,
	});
	await board
		.getByRole("combobox", { name: "Слот", exact: true })
		.selectOption("slot-headline");
	await expect(board).toContainText("Слот не привязан");
	for (const name of [
		"start",
		"end",
		"x",
		"y",
		"width",
		"height",
		"z",
		"font",
		"hash",
		"size",
		"line",
		"lines",
		"red",
		"green",
		"blue",
		"alpha",
	])
		await expect(board.locator(`[name="${name}"]`)).toHaveValue("");
	const scene = await board
		.locator('[name="scene"] option')
		.nth(1)
		.getAttribute("value");
	await board.locator('[name="scene"]').selectOption(scene!);
	const values = {
		start: "0",
		end: "12000",
		x: "1000",
		y: "1000",
		width: "6000",
		height: "2000",
		z: "1",
		font: "inter-regular-4.1",
		hash: "40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82",
		size: "24",
		line: "32",
		lines: "2",
		red: "255",
		green: "255",
		blue: "255",
		alpha: "255",
	};
	for (const [name, value] of Object.entries(values))
		await board.locator(`[name="${name}"]`).fill(value);
	await board.locator('[name="alignment"]').selectOption("left");
	await board
		.getByRole("button", { name: "Сохранить привязку", exact: true })
		.focus();
	await page.keyboard.press("Enter");
	await expect(board).toContainText("Явная привязка задана");
	await page.getByRole("button", { name: "en", exact: true }).click();
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await expect(
		page.getByRole("region", { name: "Explicit master bindings", exact: true }),
	).toContainText("Master command saved. Undo is available.");
	await expect(
		page.getByRole("region", { name: "Explicit master bindings", exact: true }),
	).toContainText("Explicit binding exists");
	await page.reload();
	const english = page.getByRole("region", {
		name: "Explicit master bindings",
		exact: true,
	});
	await english
		.getByRole("combobox", { name: "Slot", exact: true })
		.selectOption("slot-headline");
	await expect(english).toContainText("Explicit binding exists");
	await expect(english.locator('option[value="slot-headline"]')).toHaveText(
		"Headline",
	);
	await page
		.getByRole("button", { name: "Undo master slot change", exact: true })
		.click();
	await expect(english).toContainText("Unbound slot");
	await english.getByText("Create your own slot", { exact: true }).click();
	await english
		.getByLabel("New slot name", { exact: true })
		.fill("Мой настоящий логотип");
	await english
		.getByRole("combobox", { name: "New slot type", exact: true })
		.selectOption("logo");
	const png = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 32;
		canvas.height = 16;
		const context = canvas.getContext("2d")!;
		context.fillStyle = "#e45b12";
		context.fillRect(4, 4, 24, 8);
		const blob = await new Promise<Blob>((resolve) =>
			canvas.toBlob((value) => resolve(value!), "image/png"),
		);
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	await english
		.locator('[name="logo"]')
		.setInputFiles({
			name: "Настоящий логотип.png",
			mimeType: "image/png",
			buffer: Buffer.from(png),
		});
	await english.locator('[name="logo_scene"]').selectOption(scene!);
	await english
		.getByRole("button", { name: "Create slot without placement", exact: true })
		.click();
	await expect(english).toContainText("PNG saved locally");
	await expect(english).toContainText("Unbound slot");
	await expect(english.locator('[name="x"]')).toHaveValue("");
	await expect(english.locator('[name="font"]')).toHaveCount(0);
	await english.locator('[name="scene"]').selectOption(scene!);
	for (const [name, value] of Object.entries({
		start: "0",
		end: "12000",
		x: "1000",
		y: "2000",
		width: "2000",
		height: "1000",
		z: "2",
	}))
		await english.locator(`[name="${name}"]`).fill(value);
	await english
		.getByRole("button", { name: "Save binding", exact: true })
		.click();
	await expect(english).toContainText("Explicit binding exists");
	const logoId = await english
		.getByRole("combobox", { name: "Slot", exact: true })
		.inputValue();
	await page.reload();
	await english
		.getByRole("combobox", { name: "Slot", exact: true })
		.selectOption(logoId);
	await expect(english).toContainText("Explicit binding exists");
	await expect(english.locator(`option[value="${logoId}"]`)).toHaveText(
		"Мой настоящий логотип",
	);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.evaluate(() => {
		document.body.style.zoom = "2";
	});
	await english.getByRole("combobox", { name: "Slot", exact: true }).focus();
	await expect(
		english.getByRole("combobox", { name: "Slot", exact: true }),
	).toBeFocused();
	expect(
		(
			await new AxeBuilder({ page })
				.include('[aria-label="Explicit master bindings"]')
				.analyze()
		).violations,
	).toEqual([]);
});

