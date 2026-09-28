import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("guide is optional, keyboard accessible and readable across phone and desktop sizes", async ({ page }, testInfo) => {
	test.setTimeout(90_000);
	await page.goto("/variantlab?publication=browser-local");
	await expect(page.getByLabel("Название новой кампании")).toBeEnabled();
	for (const text of await page.getByRole("heading").allTextContents()) expect(text.trim()).not.toBe("");
	await page.getByLabel("Название новой кампании").fill("Учебная адаптивность");
	await page.getByRole("button", { name: "+ Новая кампания", exact: true }).click();
	await expect(page.getByRole("navigation", { name: "Этапы работы" }).getByRole("link", { name: "Файлы", exact: true })).toHaveAttribute("href", "#media-library");
	const start = page.getByRole("button", { name: "Как пользоваться", exact: true });
	const guide = page.getByRole("region", { name: "Как пользоваться", exact: true });
	await expect(guide).toHaveCount(0);
	await start.click();
	await page.emulateMedia({ reducedMotion: "reduce" });
	expect((await new AxeBuilder({ page }).include("#editor-guide").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
	for (const width of [320, 360, 390, 430, 640, 768, 1023, 1024, 1280, 1440, 1920, 2560, 3840, 5120, 7680]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(guide).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `page overflow at ${width}px`).toBe(true);
		if ([320, 1440].includes(width)) await page.screenshot({ path: testInfo.outputPath(`guide-${width}.png`) });
	}
	await page.setViewportSize({ width: 320, height: 800 });
	await page.keyboard.press("Escape");
	await expect(guide).toHaveCount(0);
	await expect(start).toBeFocused();
	await start.click();
	for (let index = 0; index < 5; index++) await guide.getByRole("button", { name: "Далее", exact: true }).click();
	await guide.getByRole("button", { name: "Завершить", exact: true }).click();
	await expect(start).toBeFocused();
	await page.reload();
	await expect(guide).toHaveCount(0);
	await page.getByRole("button", { name: "en", exact: true }).click();
	await page.getByRole("button", { name: "How to use", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Create a practice campaign", exact: true })).toBeVisible();
});
