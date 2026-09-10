import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
	addAuthoredOverlays,
	inspectOverlayVideo,
} from "./render-slot-fixture";

test("local exported video contains authored text and real PNG", async ({
	page,
}, testInfo) => {
	test.setTimeout(120000);
	await page.goto("/variantlab");
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "en", exact: true }).click();
	await page
		.getByRole("button", { name: "+ New campaign", exact: true })
		.click();
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	const bytes = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const ctx = canvas.getContext("2d")!;
		const stream = canvas.captureStream(20);
		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(stream, {
			mimeType: "video/webm;codecs=vp8",
		});
		recorder.ondataavailable = (event) => chunks.push(event.data);
		const done = new Promise<void>((resolve) => {
			recorder.onstop = () => resolve();
		});
		recorder.start();
		for (let i = 0; i < 32; i++) {
			ctx.fillStyle = "#aa4020";
			ctx.fillRect(0, 0, 640, 360);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		recorder.stop();
		await done;
		stream.getTracks().forEach((track) => track.stop());
		return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
	});
	await page.getByLabel("Import master media").setInputFiles({
		name: "Собственный исходник.webm",
		mimeType: "video/webm",
		buffer: Buffer.from(bytes),
	});
	await expect(page.getByTestId("save-status")).toContainText("revision 1", {
		timeout: 30000,
	});
	await page
		.getByRole("button", { name: "Create adaptive 9:16", exact: true })
		.click();
	await addAuthoredOverlays(page);
	if (process.env.VARIANTLAB_CAPTION_GATE === "1") {
		const captions = page.getByTestId("caption-locale-board");
		await captions
			.getByRole("button", { name: "Start local transcription", exact: true })
			.click();
		await expect(page.getByTestId("transcription-status")).toHaveText(
			"succeeded",
		);
		await page
			.getByLabel("Edit caption transcript-master-m5-cue-0", { exact: true })
			.fill("Субтитры VariantLab");
		await page
			.getByLabel("Edit caption transcript-master-m5-cue-0", { exact: true })
			.press("Enter");
		const placement = page.getByRole("form", {
			name: "Caption placement",
			exact: true,
		});
		await expect(placement.locator('[name="x"]')).toHaveValue("");
		const source = await placement
			.locator('[name="source"] option')
			.nth(1)
			.getAttribute("value");
		await placement.locator('[name="source"]').selectOption(source!);
		for (const [name, value] of Object.entries({
			x: "500",
			y: "7500",
			width: "9000",
			height: "2000",
			z: "4",
			size: "56",
			line: "64",
			lines: "2",
			color: "#00ff00",
		})) {
			await placement.locator(`[name="${name}"]`).fill(value);
		}
		await placement.locator('[name="font"]').selectOption("inter-regular-4.1");
		await placement.locator('[name="alignment"]').selectOption("center");
		await placement
			.getByRole("button", { name: "Save caption placement", exact: true })
			.click();
		await expect(placement).toContainText("Caption placement saved.");
		await page.reload();
		await expect(placement.locator('[name="y"]')).toHaveValue("7500");
		await expect(
			page.getByLabel("Edit caption transcript-master-m5-cue-0", {
				exact: true,
			}),
		).toHaveValue("Субтитры VariantLab");
		await page.getByRole("button", { name: "ru", exact: true }).click();
		await expect(
			page.getByRole("form", { name: "Размещение субтитров", exact: true }),
		).toBeVisible();
		await expect(page.getByTestId("caption-locale-board")).toContainText(
			"Субтитры и языковые профили",
		);
		await expect(page.locator("html")).toHaveAttribute("lang", "ru");
		await page.getByRole("button", { name: "en", exact: true }).click();
	}
	const wall = page.getByTestId("m6-preview-prism");
	await wall.scrollIntoViewIfNeeded();
	const preview = wall.locator("canvas").first();
	await expect(preview).toHaveAttribute("data-render-tick", "0", {
		timeout: 30000,
	});
	const previewPixels = await preview.evaluate((canvas) => {
		const node = canvas as HTMLCanvasElement;
		const rgba = node
			.getContext("2d")!
			.getImageData(0, 0, node.width, node.height).data;
		let green = 0;
		let blue = 0;
		for (let i = 0; i < rgba.length; i += 4) {
			if (rgba[i + 1] > 130 && rgba[i] < 100 && rgba[i + 2] < 100) green++;
			if (rgba[i + 2] > 130 && rgba[i] < 100 && rgba[i + 1] < 100) blue++;
		}
		return { green, blue };
	});
	expect(previewPixels.green).toBeGreaterThan(5);
	expect(previewPixels.blue).toBeGreaterThan(50);
	await wall.screenshot({
		path: testInfo.outputPath("manifest-preview-wall.png"),
	});
	if (process.env.VARIANTLAB_CAPTION_GATE === "1") {
		await page
			.getByRole("slider", { name: "Preview wall time" })
			.evaluate((element) => {
				const setter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)!.set!;
				setter.call(element, "69000");
				element.dispatchEvent(new Event("input", { bubbles: true }));
				element.dispatchEvent(new Event("change", { bubbles: true }));
			});
		await expect(preview).toHaveAttribute("data-render-tick", "69000");
		const gapGreen = await preview.evaluate((element) => {
			const canvas = element as HTMLCanvasElement;
			const bytes = canvas
				.getContext("2d")!
				.getImageData(0, 0, canvas.width, canvas.height).data;
			let green = 0;
			for (let i = 0; i < bytes.length; i += 4)
				if (bytes[i] < 100 && bytes[i + 1] > 130 && bytes[i + 2] < 100) green++;
			return green;
		});
		expect(gapGreen).toBe(0);
	}
	const board = page.getByRole("region", {
		name: "Render package",
		exact: true,
	});
	await page
		.getByTestId("m7-cell-picker")
		.locator('input[type="checkbox"]')
		.first()
		.check();
	await board
		.getByRole("button", { name: "Run preflight", exact: true })
		.click();
	await expect(page.getByTestId("m7-preflight")).toContainText("READY");
	await board
		.getByRole("button", { name: "Enqueue local batch", exact: true })
		.click();
	await expect(page.getByTestId("m7-job-center")).toContainText(
		"succeeded · verified",
		{ timeout: 60000 },
	);
	const downloaded = page.waitForEvent("download");
	await page
		.getByTestId("m7-artifacts")
		.getByRole("button", { name: "Download", exact: true })
		.click();
	const download = await downloaded;
	const file = testInfo.outputPath("authored-local.webm");
	await download.saveAs(file);
	const rendered = await readFile(file);
	const pixels = await inspectOverlayVideo(page, Array.from(rendered));
	expect(pixels.width).toBe(1080);
	expect(pixels.height).toBe(1920);
	expect(pixels.green).toBeGreaterThan(100);
	expect(pixels.blue).toBeGreaterThan(1000);
	if (process.env.VARIANTLAB_CAPTION_GATE === "1")
		expect(pixels.captionGreen).toBeGreaterThan(100);
	await page.reload();
	await expect(
		page
			.getByTestId("m7-artifacts")
			.getByRole("button", { name: "Download", exact: true }),
	).toBeVisible();
});
