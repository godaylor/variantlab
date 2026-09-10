import { expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";



async function readState(page: Page) {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("variantlab-studio-v1"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
		const rows = await new Promise<any[]>((resolve, reject) => { const r = db.transaction("sync-outbox").objectStore("sync-outbox").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close(); return rows[0];
	});
}
async function rename(page: Page, name: string) { await page.getByLabel("Scene name", { exact: true }).fill(name); await page.getByRole("button", { name: "Save name", exact: true }).click(); await expect(page.getByTestId("save-status")).toContainText("Saved locally"); }
const board = (page: Page) => page.getByRole("region", { name: "Sync and review", exact: true });
async function sync(page: Page) { await board(page).getByRole("button", { name: "Sync campaign", exact: true }).click(); await expect(board(page).getByRole("button", { name: "Sync campaign", exact: true })).toBeEnabled(); await expect(board(page).getByRole("alert")).toHaveCount(0); }

export async function verifyM9({ author, second, browser, testInfo }: { author: Page; second: Page; browser: Browser; testInfo: TestInfo }) {
	let lostAcknowledgement = false;
	await author.route("**/api/variantlab/campaigns/*/sync", async (route) => { if (!lostAcknowledgement) { lostAcknowledgement = true; await route.fetch(); await route.abort("connectionreset"); } else await route.continue(); });
	await board(author).getByRole("button", { name: "Sync campaign", exact: true }).click();
	await expect(board(author).getByRole("alert")).toBeVisible();
	const pending = await readState(author); expect(pending.pending_request_id).toBeTruthy();
	await author.unroute("**/api/variantlab/campaigns/*/sync");
	await sync(author);
	const original = await readState(author);
	const expiry = await author.evaluate(async ({ campaign_id, base_revision }) => {
		const response = await fetch(`/api/variantlab/campaigns/${campaign_id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: base_revision, expires_in_seconds: 1 }) });
		if (!response.ok) throw new Error(`expiry_fixture_${response.status}`);
		return response.json();
	}, original);
	await expect.poll(async () => author.evaluate(async (token) => (await fetch("/api/variantlab/review-access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).status, expiry.token)).toBe(403);
	expect(original.commands).toHaveLength(0);
	await board(author).getByRole("button", { name: "Create review link" }).click();
	const reviewLink = board(author).getByRole("link", { name: "Open review link" });
	await expect(reviewLink).toBeVisible();
	const url = await reviewLink.getAttribute("href"); expect(url).toBeTruthy();
	const reviewContext = await browser.newContext();
	try {
		const review = await reviewContext.newPage(); await review.goto(url!); await review.getByRole("button", { name: "en", exact: true }).click();
		await expect(review.getByRole("button", { name: "Approve revision" })).toBeEnabled();
		await expect(review.locator("video")).toHaveCount(1);
		for (const language of ["ru", "en"]) {
			await review.getByRole("button", { name: language, exact: true }).click();
			expect((await new AxeBuilder({ page: review }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
			await review.setViewportSize({ width: 390, height: 844 });
			await review.evaluate(() => { document.documentElement.style.zoom = "2"; });
			expect(await review.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			const headingBox = await review.getByRole("heading", { level: 1 }).boundingBox();
			const languageBox = await review.getByRole("button", { name: "en", exact: true }).boundingBox();
			expect(languageBox!.y + languageBox!.height).toBeLessThanOrEqual(headingBox!.y);
			await review.screenshot({ path: testInfo.outputPath(`m9-review-${language}-mobile-200.png`), fullPage: true });
			await review.evaluate(() => { document.documentElement.style.zoom = "1"; });
			await review.setViewportSize({ width: 1440, height: 900 });
		}
		const token = new URL(url!).hash.slice(1);
		const unauthorized = await review.evaluate(async (token) => (await fetch("/api/variantlab/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).status, token);
		expect(unauthorized).toBe(401);
		await review.getByRole("button", { name: "Approve revision" }).focus(); await expect(review.getByRole("button", { name: "Approve revision" })).toBeFocused();
		await review.screenshot({ path: testInfo.outputPath("m9-review-keyboard-focus.png"), fullPage: true });
		await review.keyboard.press("Enter"); await expect(review.getByRole("status")).toContainText("Approved");
		const idempotency = await review.evaluate(async (token) => {
			const request_id = crypto.randomUUID();
			const send = (decision: string) => fetch("/api/variantlab/review-decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, request_id, decision }) }).then(r => r.status);
			return [await send("approved"), await send("approved"), await send("rejected")];
		}, token); expect(idempotency).toEqual([200, 200, 400]);
		await board(second).getByRole("button", { name: "Find cloud campaigns" }).click();
		let corrupted = false;
		await second.route("http://127.0.0.1:32212/**", async (route) => { if (!corrupted) { corrupted = true; await route.fulfill({ status: 200, body: Buffer.from("damaged fixture") }); } else await route.continue(); });
		await board(second).getByRole("button", { name: "Download and continue" }).click();
		await expect(board(second).getByRole("alert")).toContainText("download_size_mismatch"); expect(await readState(second)).toBeUndefined();
		await second.unroute("http://127.0.0.1:32212/**");
		await board(second).getByRole("button", { name: "Download and continue" }).click();
		await expect.poll(async () => (await readState(second))?.base_sha256).toBe(original.base_sha256);
		await board(second).getByRole("button", { name: "Sync campaign", exact: true }).click(); await expect(board(second).getByRole("alert")).toContainText("writer_lease_held");
		await board(author).getByRole("button", { name: "Release writer" }).click();
		await sync(second);
		await board(second).getByRole("button", { name: "Release writer" }).click();
		const media = await second.evaluate(async () => { const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("variantlab-media-v1"); r.onsuccess = () => resolve(r.result); }); const rows = await new Promise<any[]>((resolve) => { const r = db.transaction("assets").objectStore("assets").getAll(); r.onsuccess = () => resolve(r.result); }); db.close(); return rows.map(v => v.asset_hash).sort(); });
		expect(media.length).toBeGreaterThanOrEqual(2);
		await second.context().setOffline(true); await rename(second, "Offline second device");
		await rename(author, "First device online"); await sync(author);
		await review.getByRole("button", { name: "Refresh review" }).click(); await expect(review.getByRole("button", { name: "Approve revision" })).toBeDisabled();
		const stale = await review.evaluate(async (token) => (await fetch("/api/variantlab/review-decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, decision: "rejected", request_id: crypto.randomUUID() }) })).status, token); expect(stale).toBe(409);
		await second.context().setOffline(false); await sync(second);
		await expect(board(second)).toContainText("Conflict saved as a recovered branch");
		const conflict = await readState(second); expect(conflict.commands).toHaveLength(1); expect(conflict.branch_id).toBeTruthy();
		expect((await readState(author)).base_sha256).not.toBe(conflict.base_sha256);
		await second.reload(); await expect(second.getByLabel("Scene name", { exact: true })).toHaveValue("Offline second device");
		await sync(second); // Reopen does not discard local commands.
		await board(second).getByRole("button", { name: "Continue branch as new campaign" }).first().click();
		await expect(second.getByLabel("Scene name", { exact: true })).toHaveValue("Offline second device");
		await expect(second.getByTestId("save-status")).toContainText("Saved locally");
		await board(author).getByRole("button", { name: "Revoke link" }).first().click();
		await review.getByRole("button", { name: "Refresh review" }).click(); await expect(review.getByRole("main").getByRole("alert")).toContainText("review_link_invalid"); await expect(review.locator("video")).toHaveCount(0);
		await author.screenshot({ path: testInfo.outputPath("m9-author.png"), fullPage: true });
		await second.screenshot({ path: testInfo.outputPath("m9-recovered.png"), fullPage: true });
		await testInfo.attach("m9-continuation.json", { body: JSON.stringify({ originalRevision: original.base_revision, hashPreservedAcrossDevices: true, verifiedMedia: media, offlineCommandPreserved: true, conflictBranch: conflict.branch_id, anonymousCannotUpload: true, approvedThenStaleRejected: true, revokedDenied: true }), contentType: "application/json" });
	} finally { await second.context().setOffline(false); await reviewContext.close(); }
}

