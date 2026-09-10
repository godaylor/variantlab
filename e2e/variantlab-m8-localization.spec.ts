import { expect, test } from "@playwright/test";

test.describe("VariantLab M8 localization and public brand", () => {
	test("media workspace controls follow the selected language", async ({ page }) => {
		await page.goto("/variantlab");
		await page.getByRole("button", { name: "+ Новая кампания", exact: true }).click();
		await expect(page.getByText("Многоуровневая звуковая волна", { exact: true })).toBeVisible();
		await expect(page.getByText("Медиа-задачи готовы.", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "en", exact: true }).click();
		await expect(page.getByText("Waveform pyramid", { exact: true })).toBeVisible();
		await expect(page.getByText("Media jobs are ready.", { exact: true })).toBeVisible();
	});
	test("defaults to Russian, switches to English, and persists the choice", async ({ page }) => {
		await page.goto("/variantlab");
		await expect(page).toHaveTitle("VariantLab — студия рекламных вариантов");
		await expect(page.locator('meta[name="description"]')).toHaveAttribute(
			"content",
			"Управляемые рекламные варианты из одной мастер-таймлинии.",
		);
		await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "ru_RU");
		await expect(page.locator("html")).toHaveAttribute("lang", "ru");
		await expect(page.getByRole("button", { name: "+ Новая кампания" })).toBeVisible();

		await page.getByRole("button", { name: "en", exact: true }).click();
		await expect(page.locator("html")).toHaveAttribute("lang", "en");
		await expect(page).toHaveTitle("VariantLab — advertising variant studio");
		await expect(page.locator('meta[name="description"]')).toHaveAttribute(
			"content",
			"Controlled advertising variants from one master timeline.",
		);
		await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "en_US");
		await expect(page.getByRole("button", { name: "+ New campaign" })).toBeVisible();
		expect(await page.evaluate(() => localStorage.getItem("variantlab:language"))).toBe("en");

		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("lang", "en");
		await expect(page).toHaveTitle("VariantLab — advertising variant studio");
		await expect(page.locator('meta[name="description"]')).toHaveAttribute(
			"content",
			"Controlled advertising variants from one master timeline.",
		);
		await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "en_US");
		await expect(page.getByRole("button", { name: "+ New campaign" })).toBeVisible();
	});

	test("manifest and social metadata use VariantLab", async ({ page, request }) => {
		await page.goto("/variantlab");
		await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute("content", "VariantLab");
		const manifest = await request.get("/manifest.json");
		expect(manifest.ok()).toBe(true);
		const value = await manifest.json();
		expect(value.name).toBe("VariantLab");
		expect(value.lang).toBe("ru");
		expect(value.short_name).toBe("VariantLab");
		expect(value.start_url).toBe("/variantlab");
	});
});
