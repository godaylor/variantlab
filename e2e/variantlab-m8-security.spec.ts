import { expect, test } from "@playwright/test";

test("release HTML and all BFF responses enforce policy without breaking hydration", async ({
	page,
	request,
}, testInfo) => {
	const violations: string[] = [];
	await page.exposeFunction("recordPolicyViolation", (directive: string) =>
		violations.push(directive),
	);
	await page.addInitScript(() =>
		document.addEventListener("securitypolicyviolation", (event) => {
			void (
				window as unknown as {
					recordPolicyViolation: (directive: string) => Promise<void>;
				}
			).recordPolicyViolation(event.violatedDirective);
		}),
	);
	const response = await page.goto("/variantlab");
	const policy = response!.headers()["content-security-policy"];
	expect(policy).toContain("frame-ancestors 'none'");
	expect(policy).toContain("object-src 'none'");
	expect(policy).toContain("'wasm-unsafe-eval'");
	expect(policy).not.toContain("'unsafe-eval'");
	const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
	expect(nonce).toBeTruthy();
	expect(
		await page
			.locator("script[src]")
			.first()
			.evaluate((el) => (el as HTMLScriptElement).nonce),
	).toBe(nonce);
	await page
		.getByRole("button", { name: "+ Новая кампания", exact: true })
		.click();
	await expect(page.getByTestId("save-status")).toContainText("Сохранено");
	await page.getByRole("button", { name: "en", exact: true }).click();
	await expect(page.getByTestId("save-status")).toContainText("Saved locally");
	for (const result of [
		response!,
		await request.get("/api/variantlab/workspace"),
		await request.post("/api/variantlab/uploads", { data: {} }),
	]) {
		const headers = result.headers();
		expect(headers["cache-control"]).toContain("no-store");
		expect(headers["x-content-type-options"]).toBe("nosniff");
		expect(headers["permissions-policy"]).toContain("camera=()");
		expect(headers["content-security-policy"]).toContain(
			"frame-ancestors 'none'",
		);
	}
	const second = await request.get("/variantlab");
	expect(second.headers()["content-security-policy"]).not.toBe(policy);
	await testInfo.attach("security-policy.json", {
		body: JSON.stringify({
			policy,
			violations,
			nonceRotates: true,
			origin: new URL(page.url()).origin,
		}),
		contentType: "application/json",
	});
	expect(violations).toEqual([]);
});
