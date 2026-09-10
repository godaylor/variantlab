import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("M8 real account, durable session, CSRF and personal tenant isolation", async ({ page, context, browser, baseURL }, testInfo) => {
	test.setTimeout(60_000);
	const email = `variantlab-${randomUUID()}@example.invalid`;
	const password = `Fixture-${randomUUID()}`;
	await page.goto("/variantlab");
	await page.getByRole("button", { name: "en", exact: true }).click();
	await page.getByRole("button", { name: "+ New campaign" }).click();
	const account = page.getByRole("region", { name: "Connected account", exact: true });
	expect((await context.request.get("/api/variantlab/workspace")).status()).toBe(401);
	expect((await context.request.get("/api/variantlab/batches")).status()).toBe(401);
	if (process.env.VARIANTLAB_EXPECT_TEST_MODE_OFF === "1") {
		expect((await context.request.get("/api/variantlab/workspace", {
			headers: { "x-variantlab-e2e": "1" },
		})).status()).toBe(401);
	}
	await account.getByRole("button", { name: "Register", exact: true }).click();
	await account.getByLabel("Name", { exact: true }).fill("Имя автора не переводится");
	await account.getByLabel("Email", { exact: true }).fill(email);
	await account.getByLabel("Password", { exact: true }).fill(password);
	await account.getByRole("button", { name: "Create account", exact: true }).press("Enter");
	await expect(account).toContainText("Signed in: Имя автора не переводится");
	const first = await context.request.get("/api/variantlab/workspace");
	expect(first.status()).toBe(200);
	const workspace = await first.json() as { tenant_id: string };
	const sessionCookies = (await context.cookies()).filter(cookie => cookie.name.includes("session_token"));
	expect(sessionCookies).toHaveLength(1);
	expect(sessionCookies[0].httpOnly).toBe(true);
	expect(sessionCookies[0].sameSite).toBe("Lax");
	// A test header must not replace an authenticated user's actual identity.
	const withTestHeader = await context.request.get("/api/variantlab/workspace", { headers: { "x-variantlab-e2e": "1" } });
	expect((await withTestHeader.json()).tenant_id).toBe(workspace.tenant_id);
	await page.reload();
	await expect(account).toContainText("Имя автора не переводится");
	await page.getByRole("button", { name: "ru", exact: true }).click();
	await expect(page.getByRole("region", { name: "Подключённый аккаунт", exact: true })).toContainText("Вход выполнен: Имя автора не переводится");
	await page.getByRole("button", { name: "en", exact: true }).click();
	const csrf = await context.request.post("/api/variantlab/uploads", { data: {}, headers: { origin: "https://untrusted.example.invalid" } });
	expect(csrf.status()).toBe(403);

	const secondContext = await browser.newContext({ baseURL });
	try {
		const other = await secondContext.request.post("/api/auth/sign-up/email", { data: { name: "Second fixture", email: `variantlab-${randomUUID()}@example.invalid`, password }, headers: { origin: baseURL! } });
		expect(other.status()).toBe(200);
		const second = await secondContext.request.get("/api/variantlab/workspace");
		expect(second.status()).toBe(200);
		expect((await second.json()).tenant_id).not.toBe(workspace.tenant_id);
		const batches=await secondContext.request.get("/api/variantlab/batches");
		expect(batches.status()).toBe(200);
		expect((await batches.json()).batches).toEqual([]);
	} finally { await secondContext.close(); }

	await account.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(account.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
	expect((await context.request.get("/api/variantlab/workspace")).status()).toBe(401);
	await account.getByLabel("Email", { exact: true }).fill(email);
	await account.getByLabel("Password", { exact: true }).fill(password);
	await account.getByRole("button", { name: "Sign in", exact: true }).press("Enter");
	await expect(account).toContainText("Signed in: Имя автора не переводится");
	expect((await (await context.request.get("/api/variantlab/workspace")).json()).tenant_id).toBe(workspace.tenant_id);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.evaluate(() => { document.body.style.zoom = "2"; });
	await account.getByRole("button", { name: "Sign out", exact: true }).focus();
	await expect(account.getByRole("button", { name: "Sign out", exact: true })).toBeFocused();
	expect((await new AxeBuilder({ page }).include('[aria-labelledby="connected-account-title"]').analyze()).violations).toEqual([]);
	await account.screenshot({ path: testInfo.outputPath("m8-account-keyboard-200pct.png") });
});
