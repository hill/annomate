import { expect, test } from "@playwright/test";
import { clearProjects } from "./helpers";

// A Markdown repo the dev token can read. The test only reads it.
const REPO = process.env.E2E_MD_REPO;

test.skip(!REPO, "Set E2E_MD_REPO=owner/name to a Markdown repo the dev token can read");

test("a Markdown repo is detected, typeset, synced to source and exported", async ({ page }) => {
	await page.goto("/auth/dev?login=fern&id=9012&name=Fern");
	await clearProjects(page.request, REPO as string);
	const created = await page.request.post("/api/projects", { data: { repo: REPO } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const project = await created.json();
	expect(project.format).toBe("markdown");
	expect(project.mainFile).toMatch(/\.md$/);

	await page.goto(`/p/${project.id}`);
	const run = page
		.locator(".stage .tsel")
		.filter({ hasText: /\p{L}{6,}/u })
		.nth(3);
	await expect(run).toBeVisible({ timeout: 90_000 });

	// Clicking rendered text puts the cursor on that word in the Markdown source.
	const words = ((await run.textContent()) ?? "").match(/\p{L}{6,}/gu) ?? [];
	await run.evaluate((el) => el.parentElement?.scrollIntoView({ block: "center" }));
	const r = await run.evaluate((el) => {
		const b = (el.parentElement as Element).getBoundingClientRect();
		return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	});
	await page.mouse.click(r.x, r.y);
	await expect
		.poll(() => page.locator(".cm-activeLine").first().innerText())
		.toContain(words[Math.floor(words.length / 2)] ?? "");

	// And clicking in the source flashes the matching text in the preview.
	await page.locator(".cm-activeLine").first().click();
	await expect(page.locator(".sync-flash")).toHaveCount(1);

	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "PDF" }).click();
	expect((await download).suggestedFilename()).toMatch(/\.pdf$/);

	expect((await page.request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
});
