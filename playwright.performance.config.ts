import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	outputDir: ".test-results-performance",
	fullyParallel: false,
	retries: 0,
	reporter: [["list"]],
	use: {
		baseURL: process.env.VARIANTLAB_BASE_URL ?? "http://127.0.0.1:32270",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: process.env.VARIANTLAB_BASE_URL ? undefined : {
		command: "node script/bun.mjs run start:web:e2e",
		url: "http://127.0.0.1:32270/variantlab/m2-performance",
		reuseExistingServer: false,
		timeout: 120_000,
	},
	projects: [
		{
			name: "chromium-production",
			use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
		},
	],
});
