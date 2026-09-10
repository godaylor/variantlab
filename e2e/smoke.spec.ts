import { expect, test } from "@playwright/test";

test("VariantLab imports, saves, and reloads", async ({ page }) => {
	await page.goto("/variantlab");
	await expect(page.getByRole("heading", { name: "VariantLab" })).toBeVisible();
	await page.evaluate(async () => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open("video-editor-projects", 1);
			request.addEventListener("upgradeneeded", () => {
				if (!request.result.objectStoreNames.contains("projects")) {
					request.result.createObjectStore("projects", { keyPath: "id" });
				}
			});
			request.addEventListener("error", () => reject(request.error));
			request.addEventListener("success", () => {
				const database = request.result;
				const transaction = database.transaction("projects", "readwrite");
				transaction.objectStore("projects").put({
					id: "cross-browser",
					name: "Cross Browser",
					version: 31,
					scenes: [{ id: "cross-browser-a", name: "Scene A" }],
				});
				transaction.addEventListener("complete", () => {
					database.close();
					resolve();
				});
				transaction.addEventListener("error", () => reject(transaction.error));
			});
		});
	});
	await page.reload();
	await page.getByRole("button", { name: "Import Cross Browser" }).click();
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	await page.getByLabel("Scene name").fill("Cross-browser saved");
	await page.getByRole("button", { name: "Save name" }).click();
	await expect(page.getByTestId("save-status")).toContainText("revision 1");
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Cross-browser saved" }),
	).toBeVisible();
});

// These interaction contracts use English names; default Russian has its own M8 gate.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("variantlab:language", "en")); });

