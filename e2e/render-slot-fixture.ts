import { expect, type Page } from "@playwright/test";

/** Repository-generated media/copy, entered through the real authoring controls. */
export async function addAuthoredOverlays(page: Page) {
	const board = page.getByRole("region", {
		name: "Explicit master bindings",
		exact: true,
	});
	await board.getByText("Create your own slot", { exact: true }).click();
	await board
		.getByLabel("New slot name", { exact: true })
		.fill("Проверка текста");
	await board
		.getByRole("combobox", { name: "New slot type", exact: true })
		.selectOption("headline");
	await board.locator('[name="copy"]').fill("VariantLab ТЕСТ");
	await board
		.getByRole("button", { name: "Create slot without placement", exact: true })
		.click();
	await board
		.getByRole("combobox", { name: "Slot", exact: true })
		.selectOption({ label: "Проверка текста" });
	const scene = await board
		.locator('[name="scene"] option')
		.nth(1)
		.getAttribute("value");
	await board.locator('[name="scene"]').selectOption(scene!);
	for (const [name, value] of Object.entries({
		start: "0",
		end: "48000",
		x: "1000",
		y: "1000",
		width: "8000",
		height: "2000",
		z: "1",
		font: "inter-regular-4.1",
		hash: "40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82",
		size: "48",
		line: "64",
		lines: "2",
		red: "0",
		green: "255",
		blue: "0",
		alpha: "255",
	}))
		await board.locator(`[name="${name}"]`).fill(value);
	await board.locator('[name="alignment"]').selectOption("left");
	await board
		.getByRole("button", { name: "Save binding", exact: true })
		.click();
	await expect(board).toContainText("Explicit binding exists");
	await board
		.getByLabel("New slot name", { exact: true })
		.fill("Настоящий PNG");
	await board
		.getByRole("combobox", { name: "New slot type", exact: true })
		.selectOption("logo");
	const png = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 32;
		canvas.height = 16;
		const ctx = canvas.getContext("2d")!;
		ctx.fillStyle = "#0000ff";
		ctx.fillRect(0, 0, 32, 16);
		const blob = await new Promise<Blob>((resolve) =>
			canvas.toBlob((value) => resolve(value!), "image/png"),
		);
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	await board
		.locator('[name="logo"]')
		.setInputFiles({
			name: "Настоящий PNG.png",
			mimeType: "image/png",
			buffer: Buffer.from(png),
		});
	await board.locator('[name="logo_scene"]').selectOption(scene!);
	await board
		.getByRole("button", { name: "Create slot without placement", exact: true })
		.click();
	await expect(board).toContainText("PNG saved locally");
	await board.locator('[name="scene"]').selectOption(scene!);
	for (const [name, value] of Object.entries({
		start: "0",
		end: "48000",
		x: "5000",
		y: "5000",
		width: "2000",
		height: "1000",
		z: "2",
	}))
		await board.locator(`[name="${name}"]`).fill(value);
	await board
		.getByRole("button", { name: "Save binding", exact: true })
		.click();
	await expect(board).toContainText("Explicit binding exists");
}

export async function inspectOverlayVideo(page: Page, bytes: number[]) {
	return page.evaluate(async (input) => {
		const url = URL.createObjectURL(
			new Blob([new Uint8Array(input)], { type: "video/webm" }),
		);
		const video = document.createElement("video");
		video.muted = true;
		video.src = url;
		try {
			await new Promise<void>((resolve, reject) => {
				video.onloadeddata = () => resolve();
				video.onerror = () => reject(new Error("export decode failed"));
			});
			video.currentTime = 0.3;
			await new Promise<void>((resolve, reject) => {
				video.onseeked = () => resolve();
				video.onerror = () => reject(new Error("export seek failed"));
			});
			const canvas = document.createElement("canvas");
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(video, 0, 0);
			const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			let green = 0,
				blue = 0;
			let captionGreen = 0;
			for (let i = 0; i < pixels.length; i += 4) {
				if (pixels[i]! < 100 && pixels[i + 1]! > 170 && pixels[i + 2]! < 100)
					green++;
				if (i / 4 / canvas.width >= canvas.height * 0.75 && pixels[i]! < 100 && pixels[i + 1]! > 170 && pixels[i + 2]! < 100) captionGreen++;
				if (pixels[i]! < 80 && pixels[i + 1]! < 80 && pixels[i + 2]! > 180)
					blue++;
			}
			return {
				width: canvas.width,
				height: canvas.height,
				green,
				blue,
				captionGreen,
				duration: video.duration,
			};
		} finally {
			video.removeAttribute("src");
			video.load();
			URL.revokeObjectURL(url);
		}
	}, bytes);
}
