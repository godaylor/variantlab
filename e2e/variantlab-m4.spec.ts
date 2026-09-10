import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectRevision(page: Page, revision: number) {
	await expect(page.getByTestId("save-status")).toContainText(
		"revision " + revision,
	);
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
}

test("M4 creates three controlled hook rows with equivalent drag and menu commands", async ({
	page,
}, testInfo) => {
	test.setTimeout(90_000);
	await page.goto("/variantlab");
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "+ New campaign" }).click();
	await expectRevision(page, 0);

	await page.getByRole("button", { name: "Create adaptive 9:16" }).click();
	await expectRevision(page, 1);
	await page
		.getByRole("button", { name: "Declare standard creative slots" })
		.click();
	await expectRevision(page, 2);
	await page.getByRole("button", { name: "Create 3 hook sets" }).click();
	await expectRevision(page, 3);

	const board = page.getByTestId("creative-slot-board");
	await expect(board).toBeVisible();
	await expect(page.getByTestId("creative-row-limit")).toContainText(
		"Rows 4 / 12",
	);
	await expect(page.getByTestId("creative-slot-limit")).toContainText(
		"Slots 6 / 32",
	);
	for (const rowId of [
		"master",
		"creative-hook-a",
		"creative-hook-b",
		"creative-hook-c",
	]) {
		await expect(page.getByTestId("creative-row-" + rowId)).toBeVisible();
	}

	const source = page.getByTestId("creative-bundle-source");
	const rowA = page.getByTestId("creative-row-creative-hook-a");
	const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
	await source.dispatchEvent("dragstart", { dataTransfer });
	await rowA.dispatchEvent("dragenter", { dataTransfer });
	await rowA.dispatchEvent("dragover", { dataTransfer });
	await rowA.dispatchEvent("drop", { dataTransfer });
	await source.dispatchEvent("dragend", { dataTransfer });
	await expect(page.getByTestId("assignment-preview")).toContainText(
		"1 affected cell · 1 reused asset",
	);
	const dragPayload = await board.getAttribute("data-drag-payload");
	await page.getByRole("button", { name: "Apply staged assignment" }).click();
	await expectRevision(page, 4);
	await expect(rowA).toContainText("Headline A");
	await expect(rowA).toContainText("creative_set");

	await rowA.getByRole("button", { name: "Undo this row" }).click();
	await expectRevision(page, 5);
	await expect(rowA).toContainText("Master headline");

	const menuButton = rowA.getByRole("button", {
		name: "Assign bundle via menu",
	});
	await menuButton.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("assignment-preview")).toContainText(
		"1 affected cell · 1 reused asset",
	);
	const menuPayload = await board.getAttribute("data-menu-payload");
	expect(menuPayload).toBe(dragPayload);
	await page.getByRole("button", { name: "Apply staged assignment" }).click();
	await expectRevision(page, 6);

	for (const [rowId, revision] of [
		["creative-hook-b", 7],
		["creative-hook-c", 8],
	] as const) {
		const row = page.getByTestId("creative-row-" + rowId);
		await row.getByRole("button", { name: "Assign bundle via menu" }).click();
		await expect(page.getByTestId("assignment-preview")).toContainText(
			"1 affected cell",
		);
		await page.getByRole("button", { name: "Apply staged assignment" }).click();
		await expectRevision(page, revision);
		await expect(row).toContainText("creative_set");
	}

	const rowIds = [
		"master",
		"creative-hook-a",
		"creative-hook-b",
		"creative-hook-c",
	];
	const beforeStyle = await Promise.all(
		rowIds.map((rowId) =>
			page.getByTestId("creative-fingerprint-" + rowId).textContent(),
		),
	);
	await page
		.getByRole("button", { name: "Update master headline style" })
		.click();
	await expectRevision(page, 9);
	for (const [index, rowId] of rowIds.entries()) {
		await expect
			.poll(() =>
				page.getByTestId("creative-fingerprint-" + rowId).textContent(),
			)
			.not.toBe(beforeStyle[index]);
	}

	await page.getByRole("button", { name: "Delete live Hook slot" }).click();
	await expect(board.getByRole("alert")).toContainText(
		"remap or explicitly drop references",
	);
	await expect(page.getByTestId("save-status")).toContainText("revision 9");

	await page
		.getByRole("button", { name: "Remap Hook to fallback + delete" })
		.click();
	await expectRevision(page, 10);
	await expect(page.getByTestId("slot-audit")).toContainText(
		"remap · slot-hook to slot-hook-fallback",
	);
	await expect(rowA).toContainText("Fallback hook");
	await expect(rowA).toContainText("creative_set");

	await page.getByRole("button", { name: "Undo master slot change" }).click();
	await expectRevision(page, 11);
	await expect(page.getByTestId("slot-audit")).toHaveCount(0);
	await expect(rowA).toContainText("Opening hook");

	const accessibility = await new AxeBuilder({ page })
		.include("[data-testid='creative-slot-board']")
		.analyze();
	expect(accessibility.violations).toEqual([]);

	await page.screenshot({
		path: testInfo.outputPath("m4-creative-slots-green.png"),
		fullPage: true,
	});
});

// These interaction contracts use English names; default Russian has its own M8 gate.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("variantlab:language", "en")); });

