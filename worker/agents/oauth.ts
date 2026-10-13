import {
	AuthorizationError,
	CimdFetchError,
	type ConsentDescription,
	OAuthAuthorizationServer,
	OAuthResourceServer,
} from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import type { User } from "../../shared/protocol";
import { currentUser } from "../auth";
import type { Env } from "../env";
import { serveMcp } from "./mcp";

export const READ = "comments:read";
export const WRITE = "comments:write";

/** What a grant carries to every MCP request. */
export interface AgentProps {
	userId: number;
	/** The client's name as it registered, shown on replies it writes. */
	client: string;
}

const DAY = 86_400;

interface Servers {
	auth: OAuthAuthorizationServer<Env>;
	mcp: OAuthResourceServer<Env, AgentProps>;
}

// The issuer and resource are absolute URLs, so each origin (production, localhost) gets its own.
const byOrigin = new Map<string, Servers>();

export function servers(origin: string): Servers {
	let found = byOrigin.get(origin);
	if (found) return found;
	const resource = `${origin}/mcp`;
	const auth = new OAuthAuthorizationServer<Env>({
		issuer: origin,
		resources: [resource],
		scopesSupported: [READ, WRITE, "offline_access"],
		clientIdMetadataDocumentEnabled: true,
		clientRegistrationEndpoint: "/oauth/register",
		// A connected agent stays connected while it is used, and lapses after a month idle.
		refreshTokenTTL: 30 * DAY,
		refreshTokenIdleTTL: 30 * DAY,
	});
	const mcp = new OAuthResourceServer<Env, AgentProps>({
		resourceMetadata: { resource, authorization_servers: [origin], resource_name: "annomate" },
		requiredScopes: [READ],
		validateToken: (env) => (res, token) => auth.validateToken(res, token, env),
		handler: { fetch: serveMcp },
	});
	found = { auth, mcp };
	byOrigin.set(origin, found);
	return found;
}

type Ctx = Context<{ Bindings: Env }>;

const origin = (c: Ctx) => new URL(c.req.url).origin;

export async function authorizePage(c: Ctx) {
	const user = await currentUser(c);
	if (!user) {
		const url = new URL(c.req.url);
		return c.redirect(`/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	}
	const oauth = servers(origin(c)).auth.getOAuthApi(c.env);
	try {
		const request = await oauth.parseAuthRequest(c.req.raw);
		const details = await oauth.describeConsent(request);
		const consent = await oauth.beginConsent(request);
		consent.headers.set("Content-Type", "text/html; charset=utf-8");
		return new Response(consentPage(details, consent.handle, user), { headers: consent.headers });
	} catch (error) {
		return authorizationFailure(error);
	}
}

export async function authorizeDecision(c: Ctx) {
	const user = await currentUser(c);
	if (!user) return c.text("Sign in to annomate and try connecting again.", 401);
	const oauth = servers(origin(c)).auth.getOAuthApi(c.env);
	try {
		const form = await c.req.formData();
		const handle = String(form.get("handle") ?? "");
		if (form.get("decision") !== "approve") {
			const denied = await oauth.denyConsent(c.req.raw, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		}
		// Reading is the point of connecting, so it is always granted.
		const scope = [READ, ...(form.getAll("scope").includes(WRITE) ? [WRITE] : [])];
		const approved = await oauth.approveConsent(c.req.raw, handle, { scope });
		const details = await oauth.describeConsent(approved.request);
		const { redirectTo } = await oauth.completeAuthorization({
			request: approved.request,
			userId: String(user.id),
			metadata: { client: details.clientName },
			scope: approved.request.scope,
			props: { userId: user.id, client: details.clientName } satisfies AgentProps,
		});
		approved.headers.set("Location", redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (error) {
		return authorizationFailure(error);
	}
}

function authorizationFailure(error: unknown): Response {
	if (error instanceof AuthorizationError && error.redirectTo) {
		return Response.redirect(error.redirectTo, 302);
	}
	if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
		const message =
			error instanceof AuthorizationError ? error.description : "This app could not be verified.";
		return new Response(page("Could not connect", `<p class="note">${html(message)}</p>`), {
			status: 400,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}
	throw error;
}

const html = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Everything in `details` comes from the client, so all of it is escaped.
function consentPage(details: ConsentDescription, handle: string, user: User): string {
	const name = html(details.clientName);
	const source = details.clientDomain
		? `Published by <strong>${html(details.clientDomain)}</strong>`
		: "Name not verified";
	const body = `
<h1>Connect ${name}</h1>
<div class="facts">
	<div><span>App</span><span>${name} · ${source}</span></div>
	<div><span>Sends access to</span><span class="mono">${html(details.redirectHost)}</span></div>
	<div><span>Account</span><span><img src="${html(user.avatar)}" alt=""> ${html(user.name)}</span></div>
</div>
${
	details.redirectIsLoopback
		? `<p class="warn">This gives access to an app on your computer. Continue only if you just started connecting from it.</p>`
		: ""
}
<form method="post">
	<input type="hidden" name="handle" value="${html(handle)}">
	<label class="scope"><input type="checkbox" checked disabled> Read comments on your projects</label>
	<label class="scope"><input type="checkbox" name="scope" value="${WRITE}" checked> Reply to and resolve comments</label>
	<div class="actions">
		<button class="btn" name="decision" value="deny">Cancel</button>
		<button class="btn primary" name="decision" value="approve" autofocus>Connect</button>
	</div>
</form>`;
	return page(`Connect ${name}`, body);
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · annomate</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root {
	--bg: #ffffff; --sunk: #f4f4f4; --line: #e7e7e6; --line-strong: #d9d9d8; --text: #181818;
	--muted: #737373; --accent: #3a6cf4; --accent-strong: #2c5be0; --btn: #ffffff;
	--warn: rgb(245 184 61 / 0.18);
	--float: 0 0 0 1px rgb(0 0 0 / 0.05), 0 6px 16px rgb(0 0 0 / 0.08), 0 20px 48px rgb(0 0 0 / 0.08);
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #141414; --sunk: #1f1f1f; --line: #272727; --line-strong: #333333; --text: #ededed;
		--muted: #9b9b9b; --accent: #5b86ff; --accent-strong: #4a76f2; --btn: #222222;
		--warn: rgb(245 184 61 / 0.14);
		--float: 0 0 0 1px rgb(255 255 255 / 0.07), 0 8px 24px rgb(0 0 0 / 0.5);
		color-scheme: dark;
	}
}
* { box-sizing: border-box; }
body {
	display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px;
	background: var(--sunk); color: var(--text);
	font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
	-webkit-font-smoothing: antialiased;
}
main { width: min(400px, 100%); padding: 28px; border-radius: 14px; background: var(--bg); box-shadow: var(--float); }
.mark { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; font-weight: 600; }
.mark img { width: 20px; height: 20px; }
h1 { margin: 0 0 16px; font-size: 18px; font-weight: 600; }
.facts { display: grid; gap: 8px; margin-bottom: 16px; }
.facts div { display: grid; grid-template-columns: 112px 1fr; gap: 8px; align-items: center; }
.facts span:first-child { color: var(--muted); }
.facts img { width: 16px; height: 16px; border-radius: 50%; vertical-align: -3px; margin-right: 2px; }
.mono { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 12px; }
.warn { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; background: var(--warn); }
.note { margin: 0; color: var(--muted); }
.scope { display: flex; align-items: center; gap: 8px; padding: 10px 0; border-top: 1px solid var(--line); }
.scope input { accent-color: var(--accent); width: 15px; height: 15px; margin: 0; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.btn {
	height: 32px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: 7px;
	background: var(--btn); color: inherit; font: inherit; font-weight: 500; cursor: pointer;
	transition: transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.btn:active { transform: scale(0.97); }
.btn.primary { border-color: var(--accent-strong); background: var(--accent); color: #fff; }
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
</style>
</head>
<body>
<main>
<div class="mark"><img src="/favicon.svg" alt="">annomate</div>
${body}
</main>
</body>
</html>`;
}
