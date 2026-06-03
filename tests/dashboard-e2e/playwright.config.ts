import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.DASHBOARD_BASE_URL ?? "http://10.0.0.77:6420";

export default defineConfig({
	testDir: ".",
	testMatch: /\.spec\.ts$/,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: [
		["list"],
		["html", { outputFolder: ".playwright-report", open: "never" }],
	],
	outputDir: "test-results",
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
		actionTimeout: 10_000,
		navigationTimeout: 30_000,
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
	],
});
