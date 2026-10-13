import type { ProjectRoom } from "./room";

export interface Env {
	DB: D1Database;
	ROOM: DurableObjectNamespace<ProjectRoom>;
	ASSETS: Fetcher;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	SESSION_SECRET: string;
	/** Base64 of 32 random bytes. Encrypts GitHub tokens at rest. */
	TOKEN_KEY: string;
	/** Grants, tokens and client registrations for coding agents connecting over MCP. */
	OAUTH_KV: KVNamespace;
	DEV_LOGIN?: string;
	DEV_GITHUB_TOKEN?: string;
}
