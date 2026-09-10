import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	outputDir: ".test-results",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		baseURL: process.env.VARIANTLAB_BASE_URL ?? (process.env.CI ? "http://127.0.0.1:32270" : "http://127.0.0.1:32240"),
		actionTimeout: 10_000,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: process.env.VARIANTLAB_BASE_URL ? undefined : {
		command: process.env.CI ? "node script/bun.mjs run start:web:e2e" : "node script/bun.mjs run dev:web:e2e",
		env: {
			NEXT_PUBLIC_VARIANTLAB_M5_TEST_ADAPTER: "1",
			NEXT_PUBLIC_VARIANTLAB_M6_TEST_ADAPTER: "1",
			NEXT_PUBLIC_VARIANTLAB_M7_TEST_ADAPTER: "1",
			VARIANTLAB_WEB_VERIFY_PORT: process.env.CI ? "32270" : "32240",
		},
		url: process.env.CI ? "http://127.0.0.1:32270/variantlab" : "http://127.0.0.1:32240/variantlab",
		reuseExistingServer: false,
		timeout: 120_000,
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
			},
		},
		{
			name: "firefox-smoke",
			testMatch: /smoke\.spec\.ts/,
			use: { ...devices["Desktop Firefox"] },
		},
		{
			name: "webkit-smoke",
			testMatch: /smoke\.spec\.ts/,
			use: { ...devices["Desktop Safari"] },
		},
	],
});
