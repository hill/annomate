import { expect, test } from "@playwright/test";

// Needs DEV_LOGIN=1 in .dev.vars.
test("the chosen theme applies, survives a reload, and system follows the OS", async ({
	browser,
}) => {
	const context = await browser.newContext({ colorScheme: "light" });
	const page = await context.newPage();
	await page.goto("/auth/dev?login=carol&id=9003&name=Carol");
	const root = page.locator("html");
	await expect(root).toHaveAttribute("data-theme", "light");

	await page.getByRole("button", { name: "Theme" }).click();
	await page.getByRole("menuitemradio", { name: "Dark" }).click();
	await expect(root).toHaveAttribute("data-theme", "dark");
	await expect(page.locator("body")).toHaveCSS("background-color", "rgb(20, 20, 20)");

	await page.reload();
	await expect(root).toHaveAttribute("data-theme", "dark");

	await page.getByRole("button", { name: "Theme" }).click();
	await expect(page.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await page.getByRole("menuitemradio", { name: "System" }).click();
	await expect(root).toHaveAttribute("data-theme", "light");
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(root).toHaveAttribute("data-theme", "dark");

	await page.screenshot({ path: "test-results/theme-dark.png" });
	await context.close();
});
