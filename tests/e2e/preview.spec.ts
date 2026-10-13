import { expect, test } from "@playwright/test";
import { clearProjects } from "./helpers";

// Reads a Typst repo through the dev token. Never commits.
const REPO = process.env.E2E_REPO;

test.skip(!REPO, "Set E2E_REPO=owner/name to a Typst repo the dev token can read");

test("pinch zooms, wheel scrolls, and source and preview follow each other", async ({ page }) => {
	await page.goto("/auth/dev?login=carol&id=9003&name=Carol");
	await clearProjects(page.request, REPO as string);
	const created = await page.request.post("/api/projects", { data: { repo: REPO } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const { id } = await created.json();
	await page.goto(`/p/${id}`);
	await expect(page.locator(".stage .doc svg")).toBeVisible({ timeout: 60_000 });

	const scroller = page.locator(".preview-scroll");
	const box = await scroller.boundingBox();
	if (!box) throw new Error("no preview");
	await page.mouse.move(box.x + box.width / 2, box.y + 200);

	// Pinch arrives as ctrl+wheel. The label settles once the gesture ends.
	const before = await page.locator(".zoom .pct").innerText();
	await page.keyboard.down("Control");
	for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -20);
	await page.keyboard.up("Control");
	await expect(page.locator(".zoom .pct")).not.toHaveText(before);

	// A plain wheel still scrolls the pages.
	const top = await scroller.evaluate((el) => el.scrollTop);
	await page.mouse.wheel(0, 500);
	await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(top);

	// Clicking rendered text moves the editor cursor to that text.
	await page.locator(".zoom .pct").click();
	const run = page.locator(".tsel").nth(40);
	const words = ((await run.textContent()) ?? "").match(/[\p{L}]{5,}/gu) ?? [];
	await run.evaluate((el) => el.parentElement?.scrollIntoView({ block: "center" }));
	const r = await run.evaluate((el) => {
		const b = (el.parentElement as Element).getBoundingClientRect();
		return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	});
	await page.mouse.click(r.x, r.y);
	await expect
		.poll(() => page.locator(".cm-activeLine").first().innerText())
		.toContain(words[Math.floor(words.length / 2)] ?? "");

	// Clicking in the source flashes the matching line in the preview.
	await page.locator(".cm-activeLine").first().click();
	await expect(page.locator(".sync-flash")).toHaveCount(1);

	expect((await page.request.delete(`/api/projects/${id}`)).ok()).toBeTruthy();
});
