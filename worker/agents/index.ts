import { type Context, Hono } from "hono";
import { currentUser } from "../auth";
import type { Env } from "../env";
import { authorizeDecision, authorizePage, servers } from "./oauth";

/**
 * Coding agents connect over MCP at /mcp. annomate is its own OAuth authorization server: an
 * agent registers itself, the person signs in with their annomate session and approves it.
 */
export const agents = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

// Hono types its execution context separately from the Workers runtime, which the OAuth
// library expects. They are the same object.
const to = (role: "auth" | "mcp") => (c: Ctx) =>
	servers(new URL(c.req.url).origin)[role].fetch(
		c.req.raw,
		c.env,
		c.executionCtx as unknown as ExecutionContext,
	);

agents.get("/authorize", authorizePage);
agents.post("/authorize", authorizeDecision);
agents.all("/mcp", to("mcp"));
agents.all("/.well-known/oauth-protected-resource/*", to("mcp"));
agents.all("/.well-known/oauth-authorization-server", to("auth"));
agents.all("/oauth/*", to("auth"));

/** The agents a person has connected, so they can see and disconnect them. */
export interface AgentConnection {
	id: string;
	client: string;
	scope: string[];
	createdAt: number;
}

agents.get("/api/agents", async (c) => {
	const user = await currentUser(c);
	if (!user) return c.json({ error: "Not signed in" }, 401);
	const oauth = servers(new URL(c.req.url).origin).auth.getOAuthApi(c.env);
	const { items } = await oauth.listUserGrants(String(user.id));
	const connections: AgentConnection[] = items
		.map((g) => ({
			id: g.id,
			client: typeof g.metadata?.client === "string" ? g.metadata.client : g.clientId,
			scope: g.scope,
			createdAt: g.createdAt * 1000,
		}))
		.sort((a, b) => b.createdAt - a.createdAt);
	return c.json(connections);
});

agents.delete("/api/agents/:id", async (c) => {
	const user = await currentUser(c);
	if (!user) return c.json({ error: "Not signed in" }, 401);
	const oauth = servers(new URL(c.req.url).origin).auth.getOAuthApi(c.env);
	await oauth.revokeGrant(c.req.param("id"), String(user.id));
	return c.json({ ok: true });
});
