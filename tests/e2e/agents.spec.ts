import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { clearProjects } from "./helpers";

// Needs DEV_LOGIN=1 in .dev.vars. The thread tests also need E2E_REPO, as collab.spec.ts does.
const BASE = "http://localhost:5181";
const REDIRECT = "http://127.0.0.1:9919/callback";
const REPO = process.env.E2E_REPO;

const b64url = (bytes: Buffer) => bytes.toString("base64url");

/**
 * Run the whole OAuth flow an MCP client runs: register, consent in a browser window of its own,
 * exchange the code. `signedIn` supplies the annomate session that window shares.
 */
async function connect(signedIn: Page, request: APIRequestContext, allowWrite = true) {
	const page = await signedIn.context().newPage();
	const registered = await request.post("/oauth/register", {
		data: {
			client_name: "Test agent",
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
		},
	});
	expect(registered.ok(), await registered.text()).toBeTruthy();
	const { client_id } = await registered.json();

	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	const authorize = new URL("/authorize", BASE);
	for (const [k, v] of Object.entries({
		response_type: "code",
		client_id,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "s1",
		scope: "comments:read",
		resource: `${BASE}/mcp`,
	}))
		authorize.searchParams.set(k, v);

	// The redirect lands on a port nothing listens on, as a CLI's callback would after it closes.
	// The request still fires, carrying the code.
	let callback = "";
	page.on("request", (r) => {
		if (new URL(r.url()).port === "9919") callback = r.url();
	});
	await page.goto(authorize.toString());
	await expect(page.getByRole("heading", { name: "Connect Test agent" })).toBeVisible();
	await expect(page.getByText("This gives access to an app on your computer")).toBeVisible();
	if (!allowWrite) await page.getByLabel("Reply to and resolve comments").uncheck();
	await page.getByRole("button", { name: "Connect" }).click();
	await expect.poll(() => callback).toContain("code=");

	await page.close();
	const params = new URL(callback).searchParams;
	expect(params.get("state")).toBe("s1");
	expect(params.get("iss")).toBe(BASE);
	const token = await request.post("/oauth/token", {
		form: {
			grant_type: "authorization_code",
			code: params.get("code") as string,
			redirect_uri: REDIRECT,
			client_id,
			code_verifier: verifier,
			resource: `${BASE}/mcp`,
		},
	});
	expect(token.ok(), await token.text()).toBeTruthy();
	const body = await token.json();
	expect(body.refresh_token).toBeTruthy();
	return body as { access_token: string; scope: string };
}

async function mcp(accessToken: string, mode: "legacy" | "auto" = "legacy") {
	const client = new Client(
		{ name: "annomate-e2e", version: "1.0.0" },
		mode === "auto" ? { versionNegotiation: { mode: "auto" } } : undefined,
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
		}),
	);
	return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
	(result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

test("an agent connects through OAuth and lists its tools", async ({ page }) => {
	await page.goto("/auth/dev?login=dana&id=9010&name=Dana");
	const unauthenticated = await page.request.post("/mcp", { data: {} });
	expect(unauthenticated.status()).toBe(401);
	expect(unauthenticated.headers()["www-authenticate"]).toContain("resource_metadata=");

	const { access_token, scope } = await connect(page, page.request);
	expect(scope.split(" ").sort()).toEqual(["comments:read", "comments:write"]);

	for (const mode of ["legacy", "auto"] as const) {
		const client = await mcp(access_token, mode);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"create_thread",
			"get_comments",
			"get_thread",
			"list_projects",
			"reply_to_thread",
			"resolve_thread",
		]);
		expect(client.getInstructions()).toContain("get_comments");
		expect(client.getInstructions()).toContain("create_thread");
		const missing = await client.callTool({
			name: "get_comments",
			arguments: { project: "nobody/nothing" },
		});
		expect(missing.isError).toBe(true);
		await client.close();
	}

	// Disconnecting from annomate revokes the agent's access at once.
	const connections = await (await page.request.get("/api/agents")).json();
	const mine = connections.find((c: { client: string }) => c.client === "Test agent");
	expect(mine.scope).toContain("comments:write");
	expect((await page.request.delete(`/api/agents/${mine.id}`)).ok()).toBeTruthy();
	const revoked = await page.request.post("/mcp", {
		headers: { Authorization: `Bearer ${access_token}` },
		data: {},
	});
	expect(revoked.status()).toBe(401);
});

test("a read-only connection cannot reply", async ({ page }) => {
	await page.goto("/auth/dev?login=dana&id=9010&name=Dana");
	const { access_token, scope } = await connect(page, page.request, false);
	expect(scope).toBe("comments:read");
	const client = await mcp(access_token);
	const result = await client.callTool({
		name: "reply_to_thread",
		arguments: { project: "x/y", thread_id: "t", body: "hi" },
	});
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("can read comments but not write them");
	await client.close();
});

test.describe("with a project", () => {
	test.skip(!REPO, "Set E2E_REPO=owner/name to a Typst repo the dev token can read");

	test("an agent reads a comment in context, replies and resolves it, live", async ({ page }) => {
		await page.goto("/auth/dev?login=dana&id=9010&name=Dana");
		await clearProjects(page.request, REPO as string);
		const created = await page.request.post("/api/projects", { data: { repo: REPO } });
		expect(created.ok(), await created.text()).toBeTruthy();
		const project = await created.json();

		// Comment on a line of the main file through the UI.
		await page.goto(`/p/${project.id}`);
		const line = page
			.locator(".cm-line")
			.filter({ hasText: /\w{4,}/ })
			.first();
		await expect(line).toBeVisible({ timeout: 60_000 });
		const quote = await line.innerText();
		await line.click();
		await page.keyboard.press("Home");
		await page.keyboard.press("Shift+End");
		await page.locator(".comment-tip button").click();
		await page.locator(".thread.active textarea").fill("Please expand this.");
		await page.locator(".thread.active .btn.primary").click();
		await expect(page.locator(".thread .comment-body")).toHaveText("Please expand this.");

		// The export button copies the same report the agent reads.
		await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.getByRole("button", { name: "Export comments" }).click();
		await page.getByRole("menuitem", { name: "Copy open comments" }).click();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(copied).toContain("Please expand this.");
		expect(copied).toContain(`> ${quote}`);

		// Escape closes the connect panel and nothing under it.
		await expect(page.getByRole("menu")).toBeHidden();
		await page.getByRole("button", { name: "Export comments" }).click();
		await page.getByRole("menuitem", { name: "Connect an agent" }).click();
		await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeHidden();
		await expect(page.getByRole("button", { name: "Export comments" })).toBeVisible();

		const { access_token } = await connect(page, page.request);
		const client = await mcp(access_token);
		const report = textOf(
			await client.callTool({ name: "get_comments", arguments: { project: REPO as string } }),
		);
		expect(report).toContain("Please expand this.");
		expect(report).toContain(`> ${quote}`);
		const thread = (report.match(/Thread `([^`]+)`/) as RegExpMatchArray)[1];

		await page.goto(`/p/${project.id}`);
		// The rail remembers whether it was open.
		await expect(page.locator(".cm-line").first()).toBeVisible({ timeout: 60_000 });
		const show = page.getByRole("button", { name: "Show comments" });
		if (await show.isVisible()) await show.click();
		await expect(page.locator(".thread")).toHaveCount(1);
		const resolved = await client.callTool({
			name: "resolve_thread",
			arguments: { project: `git@github.com:${REPO}.git`, thread_id: thread, reply: "Expanded." },
		});
		expect(resolved.isError).toBeFalsy();
		// The open page hears about it without a reload.
		await expect(page.locator(".thread")).toHaveCount(0);
		await page.getByRole("tab", { name: "Resolved" }).click();
		await expect(page.getByText("Expanded.")).toBeVisible();
		await expect(page.getByText("via Test agent")).toBeVisible();
		await client.close();
		expect((await page.request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
	});

	test("an agent starts a thread on a quoted passage, and it appears live", async ({ page }) => {
		await page.goto("/auth/dev?login=erin&id=9011&name=Erin");
		await clearProjects(page.request, REPO as string);
		const created = await page.request.post("/api/projects", { data: { repo: REPO } });
		expect(created.ok(), await created.text()).toBeTruthy();
		const project = await created.json();

		await page.goto(`/p/${project.id}`);
		const line = page
			.locator(".cm-line")
			.filter({ hasText: /\w{4,}.*\w{4,}/ })
			.first();
		await expect(line).toBeVisible({ timeout: 60_000 });
		const words = ((await line.innerText()).match(/\S+/g) ?? []).slice(0, 3).join(" ");
		const show = page.getByRole("button", { name: "Show comments" });
		if (await show.isVisible()) await show.click();

		const { access_token } = await connect(page, page.request);
		const client = await mcp(access_token);

		const missing = await client.callTool({
			name: "create_thread",
			arguments: {
				project: REPO as string,
				quote: "words that are nowhere in this file",
				body: "x",
			},
		});
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("not in the file");

		const result = await client.callTool({
			name: "create_thread",
			arguments: { project: REPO as string, quote: words, body: "Could this be clearer?" },
		});
		expect(result.isError, textOf(result)).toBeFalsy();
		expect(textOf(result)).toMatch(/Created thread `[^`]+` on .+:\d+/);

		// The open page shows it without a reload, highlighted in the source and tagged with the agent.
		await expect(page.locator(".thread .comment-body")).toHaveText("Could this be clearer?");
		await expect(page.getByText("via Test agent")).toBeVisible();
		await expect
			.poll(async () => (await page.locator(".cm-comment-mark").allInnerTexts()).join(""))
			.toContain(words);

		// It reads back like any other thread.
		const report = textOf(
			await client.callTool({ name: "get_comments", arguments: { project: REPO as string } }),
		);
		expect(report).toContain("Could this be clearer?");
		await client.close();
		expect((await page.request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
	});
});
