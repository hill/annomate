import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests/e2e",
	timeout: 120_000,
	use: { baseURL: "http://localhost:5181", viewport: { width: 1500, height: 950 } },
	webServer: {
		command: "bunx vite --strictPort",
		url: "http://localhost:5181",
		reuseExistingServer: true,
		timeout: 60_000,
	},
});
