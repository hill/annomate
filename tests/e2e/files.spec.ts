import { expect, type Page, test } from "@playwright/test";
import { clearProjects } from "./helpers";

// Edits the shared document of a scratch repo and uploads one tiny blob. Never commits.
const REPO = process.env.E2E_SANDBOX;

test.skip(!REPO, "Set E2E_SANDBOX=owner/name to a scratch repo the dev token can push to");

const tree = (page: Page) => page.locator(".file-tree");
const row = (page: Page, name: string) =>
	tree(page).locator(".file-row", {
		has: page.locator(".grow", { hasText: new RegExp(`^${name}$`) }),
	});
const keys = (page: Page) =>
	page.evaluate(() =>
		[...(window as unknown as { room: { files: Map<string, unknown> } }).room.files.keys()].sort(),
	);

async function typeName(page: Page, name: string) {
	const input = page.locator(".name-input input");
	await input.fill(name);
	await input.press("Enter");
}

test("folders, moves, renames and uploads in the file tree", async ({ page }) => {
	await page.goto("/auth/dev?login=e2e-files&id=9101&name=Filer");
	await clearProjects(page.request, REPO as string);
	const created = await page.request.post("/api/projects", { data: { repo: REPO } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const { id } = await created.json();
	await page.goto(`/p/${id}`);
	await expect(page.locator(".stage .sheet svg").first()).toBeVisible({ timeout: 60_000 });

	// New folder at the root holds a hidden placeholder until it has files.
	await tree(page).hover();
	await page.getByRole("button", { name: "New folder" }).first().click();
	await typeName(page, "chapters");
	await expect(row(page, "chapters")).toBeVisible();
	expect(await keys(page)).toContain("chapters/.gitkeep");

	// A file created inside it replaces the placeholder and opens.
	await row(page, "chapters").hover();
	await page.getByRole("button", { name: "New file in chapters" }).click();
	await typeName(page, "intro.typ");
	await expect(page.locator(".source .pane-head .title")).toHaveText("chapters/intro.typ");
	expect(await keys(page)).not.toContain("chapters/.gitkeep");

	// Type and comment on a line.
	await page.locator(".cm-content").click();
	await page.keyboard.type("Reviewers asked for a clearer opening paragraph here.");
	await page.keyboard.press("Home");
	await page.keyboard.press("Shift+End");
	await page.locator(".comment-tip button").click();
	await page.locator(".thread.active textarea").fill("Agree, tighten it");
	await page.locator(".thread.active .btn.primary").click();
	await expect(page.locator(".cm-comment-mark")).toHaveCount(1);

	// Drag the file out to the root. The comment follows it.
	await row(page, "intro.typ").dragTo(tree(page).locator(".side-label"));
	await expect.poll(() => keys(page)).toContain("intro.typ");
	await expect(page.locator(".source .pane-head .title")).toHaveText("intro.typ");
	await expect
		.poll(async () => (await page.locator(".cm-comment-mark").allInnerTexts()).join(""))
		.toBe("Reviewers asked for a clearer opening paragraph here.");

	// Drag it back into the folder.
	await row(page, "intro.typ").dragTo(row(page, "chapters"));
	await expect.poll(() => keys(page)).toContain("chapters/intro.typ");

	// Double-click renames.
	await row(page, "intro.typ").dblclick();
	await typeName(page, "opening.typ");
	await expect.poll(() => keys(page)).toContain("chapters/opening.typ");
	await expect(page.locator(".rail .thread .quote")).toContainText("Reviewers asked");

	// Dropping a file from the desktop onto the folder uploads it there.
	const pixel =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
	const target = row(page, "chapters");
	await target.evaluate((el, b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], "dot.png", { type: "image/png" }));
		const li = el.closest("li") as Element;
		li.dispatchEvent(
			new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }),
		);
		li.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
	}, pixel);
	await expect(row(page, "dot.png")).toBeVisible({ timeout: 20_000 });
	// Hovering a row swaps its markers for actions, so move away before checking the changed dot.
	await page.mouse.move(800, 500);
	await expect(row(page, "dot.png").locator(".dot")).toBeVisible();

	// Deleting the folder takes everything in it.
	page.on("dialog", (d) => d.accept());
	await row(page, "chapters").hover();
	await page.getByRole("button", { name: "Delete chapters" }).click();
	await expect(row(page, "chapters")).toHaveCount(0);

	expect((await page.request.delete(`/api/projects/${id}`)).ok()).toBeTruthy();
});
