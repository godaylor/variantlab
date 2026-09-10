import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("a named campaign survives reopening and exposes the complete workflow", async ({
	page,
}, testInfo) => {
	await page.goto("/variantlab");
	await expect(
		page.getByRole("button", { name: "+ Новая кампания", exact: true }),
	).toBeEnabled();
	await page.screenshot({ path: testInfo.outputPath("first-run.png") });
	await page.getByLabel("Название новой кампании").fill("Осенняя коллекция");
	await page
		.getByRole("button", { name: "+ Новая кампания", exact: true })
		.click();
	await expect(page.getByTestId("save-status")).toContainText(
		"Сохранено локально",
	);
	await expect(
		page.getByRole("heading", { name: "Осенняя коллекция", exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("campaign-workspace.png"),
	});
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Осенняя коллекция", exact: true }),
	).toBeVisible();
	await page.getByRole("link", { name: "Экспорт", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "Пакет экспорта", exact: true }),
	).toBeInViewport();
	const accessibility = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
		.analyze();
	expect(accessibility.violations).toEqual([]);
});
