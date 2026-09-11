import { expect, test } from "@playwright/test";

test("public browser-local demo opens the real workspace and creates a campaign", async ({ page }) => {
	await page.goto("/variantlab/?publication=browser-local");
	await expect(page).toHaveTitle(/VariantLab/);
	await expect(page.getByRole("heading", { name: "VariantLab", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "en", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "en", exact: true }).click();
	await page.getByRole("button", { name: "+ New campaign", exact: true }).click();
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	await page.getByRole("button", { name: "Create adaptive 9:16", exact: true }).click();
	await expect(page.getByTestId("matrix-cell-count")).toContainText("1 / 100");
	await expect(page.getByTestId("browser-local-mode")).toContainText("Local mode");
	await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Sync campaign", exact: true })).toHaveCount(0);
});
