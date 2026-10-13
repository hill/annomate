import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { clearProjects } from "./helpers";

// Writes to a throwaway repo through the gh CLI and the app. Never point it at real work.
const REPO = process.env.E2E_SANDBOX;

const ORIGINAL = `#set page(paper: "a5", margin: 2cm)
#set text(font: "New Computer Modern", size: 11pt)

= Introduction

Typst is a markup-based typesetting system. It is designed to be as powerful
as LaTeX while being much easier to learn and use.

= Method

We sampled 400 participants from three cities and asked each of them to
typeset the same two-page document in both systems.

= Results

Participants finished the Typst task 2.3 times faster on average.
`;

const COMMENTED = "We sampled 400 participants from three cities and asked each of them to";

function gh(...args: string[]) {
	return execFileSync("gh", args, { encoding: "utf8" });
}

function readRemote(): { text: string; sha: string } {
	const file = JSON.parse(gh("api", `repos/${REPO}/contents/main.typ`));
	return { text: Buffer.from(file.content, "base64").toString("utf8"), sha: file.sha };
}

/** Push a new main.typ straight to GitHub, as someone working outside annomate would. */
function pushRemote(text: string, message: string) {
	const { sha } = readRemote();
	gh(
		"api",
		"-X",
		"PUT",
		`repos/${REPO}/contents/main.typ`,
		"-f",
		`message=${message}`,
		"-f",
		`content=${Buffer.from(text).toString("base64")}`,
		"-f",
		`sha=${sha}`,
	);
}

async function selectLine(page: Page, contains: string) {
	await page.locator(".cm-line", { hasText: contains }).first().click();
	// Home and End stop at a soft wrap first. The second press reaches the line's real boundary.
	await page.keyboard.press("Home");
	await page.keyboard.press("Home");
	await page.keyboard.press("Shift+End");
	await page.keyboard.press("Shift+End");
}

async function markText(page: Page) {
	return (await page.locator(".cm-comment-mark").allInnerTexts()).join("");
}

test.skip(!REPO, "Set E2E_SANDBOX=owner/name to a scratch repo the dev token can push to");

test("commit, then pull an outside push without losing the comment's place", async ({ page }) => {
	if (readRemote().text !== ORIGINAL) pushRemote(ORIGINAL, "Reset sandbox");

	await page.goto("/auth/dev?login=e2e-git&id=9100&name=Tester");
	await clearProjects(page.request, REPO as string);
	const created = await page.request.post("/api/projects", { data: { repo: REPO } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const { id } = await created.json();
	await page.goto(`/p/${id}`);
	await expect(page.locator(".stage .doc svg")).toBeVisible({ timeout: 60_000 });

	// Comment on the method sentence.
	await selectLine(page, "We sampled 400");
	await page.locator(".comment-tip button").click();
	await page.locator(".thread.active textarea").fill("Say how they were recruited");
	await page.locator(".thread.active .btn.primary").click();
	await expect.poll(() => markText(page)).toBe(COMMENTED);

	// Edit the results and commit from annomate.
	await page.locator(".cm-line", { hasText: "2.3 times" }).click();
	await page.keyboard.press("End");
	await page.keyboard.press("End");
	await page.keyboard.type(" (n = 400)");
	await expect(page.locator(".btn.primary .count")).toHaveText("1");
	await page.getByRole("button", { name: /^Commit/ }).click();
	await page.locator("#commit-message").fill("Add sample size");
	await page.getByRole("button", { name: "Commit and push" }).click();
	await expect(page.locator(".toast")).toContainText("Committed", { timeout: 30_000 });
	await expect(page.locator(".btn.primary .count")).toHaveCount(0);
	expect(readRemote().text).toContain("2.3 times faster on average. (n = 400)");

	// Meanwhile an uncommitted local edit in the introduction.
	await page.locator(".cm-line", { hasText: "Typst is a markup-based" }).click();
	await page.keyboard.press("Home");
	await page.keyboard.type("In short, ");

	// Someone else pushes from their laptop: moves Results above Method and rewrites
	// the commented sentence.
	const remote = readRemote().text;
	const results = remote.slice(remote.indexOf("= Results"));
	const reordered = remote
		.replace(results, "")
		.replace("= Method", `${results}\n= Method`)
		.replace(
			"We sampled 400 participants from three cities",
			"We recruited 412 participants across three cities",
		);
	pushRemote(reordered, "Reorder and reword");

	await page.getByRole("button", { name: "Pull" }).click();
	await expect(page.locator(".toast").last()).toContainText("Pulled", { timeout: 30_000 });

	const source = await page.locator(".cm-content").innerText();
	expect(source).toContain("In short, Typst is a markup-based");
	expect(source.indexOf("= Results")).toBeLessThan(source.indexOf("= Method"));

	// The comment still points at the reworded sentence, flags the change and keeps the original.
	await expect
		.poll(() => markText(page))
		.toContain("We recruited 412 participants across three cities");
	await page.locator(".thread").first().click();
	await expect(page.locator(".thread.active .badge")).toHaveText("Text changed");
	await expect(page.locator(".thread.active .diff del").first()).toBeVisible();
	await expect(page.locator(".thread.active .diff")).toContainText("sampled");
	await expect(page.locator(".thread.active .diff")).toContainText("recruited");

	// Committing again folds the local introduction edit on top of the pulled commit.
	await page.getByRole("button", { name: /^Commit/ }).click();
	await page.getByRole("button", { name: "Commit and push" }).click();
	await expect(page.locator(".toast").last()).toContainText("Committed", { timeout: 30_000 });
	const final = readRemote().text;
	expect(final).toContain("In short, Typst");
	expect(final).toContain("We recruited 412");

	// An uploaded image commits as a blob, and deleting it commits the removal.
	const pixel =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
	await page.locator(".file-tree").evaluate((el, b64) => {
		const dt = new DataTransfer();
		dt.items.add(
			new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "e2e-dot.png", {
				type: "image/png",
			}),
		);
		el.dispatchEvent(
			new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }),
		);
		el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
	}, pixel);
	await expect(page.locator(".btn.primary .count")).toHaveText("1", { timeout: 20_000 });
	await page.getByRole("button", { name: /^Commit/ }).click();
	await page.getByRole("button", { name: "Commit and push" }).click();
	await expect(page.locator(".toast").last()).toContainText("Committed", { timeout: 30_000 });
	expect(Number(gh("api", `repos/${REPO}/contents/e2e-dot.png`, "--jq", ".size"))).toBeGreaterThan(
		0,
	);

	page.once("dialog", (d) => d.accept());
	await page.locator(".file-row", { hasText: "e2e-dot.png" }).hover();
	await page.getByRole("button", { name: "Delete e2e-dot.png" }).click();
	await expect(page.locator(".btn.primary .count")).toHaveText("1");
	await page.getByRole("button", { name: /^Commit/ }).click();
	await page.getByRole("button", { name: "Commit and push" }).click();
	await expect(page.locator(".btn.primary .count")).toHaveCount(0, { timeout: 30_000 });
	const gone = () => {
		try {
			gh("api", `repos/${REPO}/contents/e2e-dot.png`);
			return false;
		} catch {
			return true;
		}
	};
	await expect.poll(gone, { timeout: 20_000 }).toBe(true);

	expect((await page.request.delete(`/api/projects/${id}`)).ok()).toBeTruthy();
});
