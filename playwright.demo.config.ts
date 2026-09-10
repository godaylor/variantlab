import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	testMatch: /variantlab-public-demo\.spec\.ts/,
	outputDir: ".test-results/public-demo",
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	webServer: {
		command: "node script/serve-demo-site.mjs",
		url: "http://127.0.0.1:32280/variantlab/",
		reuseExistingServer: false,
		timeout: 30_000,
	},
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:32280",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
});
