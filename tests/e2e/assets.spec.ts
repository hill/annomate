import { expect, type Page, test } from "@playwright/test";
import { clearProjects } from "./helpers";

// Uploads two files to the repo as blobs, which no branch references, and never commits.
const REPO = process.env.E2E_SANDBOX;

// The smallest PDF viewers accept: one empty A6 page.
const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 298 420] >> endobj
trailer << /Root 1 0 R >>
%%EOF`;

async function drop(page: Page, files: { name: string; type: string; text: string }[]) {
	await page.locator(".file-tree").evaluate((el, files) => {
		const dt = new DataTransfer();
		for (const f of files) dt.items.add(new File([f.text], f.name, { type: f.type }));
		el.dispatchEvent(
			new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }),
		);
		el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
	}, files);
}

test.skip(!REPO, "Set E2E_SANDBOX=owner/name to a scratch repo the dev token can push to");

test("images and PDFs open in place, with their size", async ({ page }) => {
	await page.goto("/auth/dev?login=e2e-assets&id=9101&name=Tester");
	await clearProjects(page.request, REPO as string);
	const created = await page.request.post("/api/projects", { data: { repo: REPO } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const { id } = await created.json();
	await page.goto(`/p/${id}`);
	await expect(page.locator(".cm-line").first()).toBeVisible({ timeout: 60_000 });

	// An upload opens the uploaded file. A PDF shows in the browser's own viewer, as a PDF.
	await drop(page, [{ name: "e2e-page.pdf", type: "application/pdf", text: PDF }]);
	const frame = page.locator(".asset-view.pdf iframe");
	await expect(frame).toBeVisible({ timeout: 20_000 });
	const type = await frame.evaluate(async (el: HTMLIFrameElement) =>
		(await fetch(el.src)).headers.get("content-type"),
	);
	expect(type).toBe("application/pdf");

	// One of the sandbox's own screenshots. Folders of images start collapsed.
	await page.locator(".file-row", { hasText: "assets" }).first().click();
	await page.locator(".file-row", { hasText: "2.16.20" }).click();
	await expect(page.locator(".asset-meta")).toContainText(/^\d+ × \d+ · [\d.]+ KB/);

	// Clicking toggles between fitting the pane and full size.
	await page.getByRole("button", { name: "Show at full size" }).click();
	await expect(page.locator(".asset-stage.actual")).toHaveCount(1);
	await page.getByRole("button", { name: "Fit to pane" }).click();
	await expect(page.locator(".asset-stage.actual")).toHaveCount(0);

	expect((await page.request.delete(`/api/projects/${id}`)).ok()).toBeTruthy();
});
