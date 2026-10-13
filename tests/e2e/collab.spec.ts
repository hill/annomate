import { type Browser, expect, type Page, test } from "@playwright/test";
import { clearProjects } from "./helpers";

// Needs DEV_LOGIN=1 and DEV_GITHUB_TOKEN in .dev.vars. The test reads the repo
// and edits the shared document, and never commits.
const REPO = process.env.E2E_REPO;

async function signIn(browser: Browser, login: string, id: number) {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(
		`/auth/dev?login=${login}&id=${id}&name=${login[0].toUpperCase()}${login.slice(1)}`,
	);
	return page;
}

/** A highlight can be split into several spans, by a remote caret for one. */
async function markText(page: Page) {
	return (await page.locator(".cm-comment-mark").allInnerTexts()).join("");
}

async function editorText(page: Page) {
	return page.locator(".cm-content").innerText();
}

test.skip(!REPO, "Set E2E_REPO=owner/name to a Typst repo the dev token can read");

test("two people co-edit, see each other, and comments keep their place", async ({ browser }) => {
	const alice = await signIn(browser, "alice", 9001);
	const bob = await signIn(browser, "bob", 9002);

	await clearProjects(alice.request, REPO as string);
	const created = await alice.request.post("/api/projects", { data: { repo: REPO } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const project = await created.json();
	expect(
		(
			await alice.request.post(`/api/projects/${project.id}/members`, { data: { login: "bob" } })
		).ok(),
	).toBeTruthy();

	await alice.goto(`/p/${project.id}`);
	await bob.goto(`/p/${project.id}`);
	for (const page of [alice, bob]) {
		await expect(page.locator(".stage .doc svg")).toBeVisible({ timeout: 60_000 });
	}

	// Edits sync both ways.
	await alice.locator(".cm-content").click();
	await alice.keyboard.press("ControlOrMeta+Home");
	await alice.keyboard.type("// alice was here\n");
	await expect.poll(() => editorText(bob)).toContain("// alice was here");

	await bob.locator(".cm-line").first().click();
	await bob.keyboard.press("End");
	await bob.keyboard.type(" and bob");
	await expect.poll(() => editorText(alice)).toContain("// alice was here and bob");

	// Each sees the other in the top bar, and Bob sees Alice's caret.
	await expect(alice.locator(".avatars button")).toHaveCount(1);
	await expect(bob.locator(".cm-ySelectionCaret")).toHaveCount(1);

	// Alice's mouse over the preview shows up for Bob.
	const stage = alice.locator(".stage");
	const box = await stage.boundingBox();
	if (!box) throw new Error("no stage");
	await alice.mouse.move(box.x + 200, box.y + 300);
	await alice.mouse.move(box.x + 220, box.y + 320);
	await expect(bob.locator(".pointer .tag")).toHaveText("Alice");

	// Alice comments on the first line.
	await alice.locator(".cm-line").first().click();
	await alice.keyboard.press("Home");
	await alice.keyboard.press("Shift+End");
	await alice.locator(".comment-tip button").click();
	await alice.locator(".thread.active textarea").fill("Is this line needed?");
	await alice.locator(".thread.active .btn.primary").click();
	await bob.getByRole("button", { name: "Show comments" }).click();
	await expect(bob.locator(".thread .comment-body")).toHaveText("Is this line needed?");
	await expect.poll(() => markText(bob)).toBe("// alice was here and bob");

	// Bob types above and inside the commented line. The comment follows the text
	// and reports the change, with the original quote kept.
	await bob.locator(".cm-line").first().click();
	await bob.keyboard.press("Home");
	await bob.keyboard.type("// bob's new first line\n");
	await bob.keyboard.press("Home");
	for (let i = 0; i < "// alice".length; i++) await bob.keyboard.press("ArrowRight");
	await bob.keyboard.type(" smith");
	await expect.poll(() => markText(alice)).toBe("// alice smith was here and bob");
	await alice.locator(".thread").first().click();
	await expect(alice.locator(".thread.active .badge")).toHaveText("Text changed");
	await expect(alice.locator(".thread.active .diff ins")).toHaveText(" smith");

	// Hovering a comment shows a tick that resolves it in one click. Bob sees it leave the open list.
	await alice
		.locator(".rail-list")
		.click({ position: { x: 5, y: 5 } })
		.catch(() => {});
	const card = alice.locator(".thread").first();
	await card.hover();
	await expect(card.locator(".thread-resolve")).toBeVisible();
	await card.locator(".thread-resolve").click();
	await expect(alice.locator(".thread")).toHaveCount(0);
	await expect(bob.locator(".thread")).toHaveCount(0);
	await alice.getByRole("tab", { name: "Resolved" }).click();
	await alice.locator(".thread").first().hover();
	await alice.getByRole("button", { name: "Reopen" }).click();
	await expect(alice.locator(".thread")).toHaveCount(0);
	await alice.getByRole("tab", { name: /^Open/ }).click();
	await expect(alice.locator(".thread")).toHaveCount(1);

	expect((await alice.request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
});
