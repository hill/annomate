import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { User } from "../shared/protocol";
import type { Env } from "./env";

const SESSION_COOKIE = "am_session";
const STATE_COOKIE = "am_oauth_state";
const SESSION_DAYS = 30;

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

const fromB64url = (s: string) =>
	Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hmacKey(secret: string) {
	return crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

async function aesKey(secret: string) {
	return crypto.subtle.importKey("raw", fromB64(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(env: Env, token: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await aesKey(env.TOKEN_KEY),
		enc.encode(token),
	);
	return `${b64url(iv)}.${b64url(sealed)}`;
}

export async function decryptToken(env: Env, stored: string): Promise<string> {
	const [iv, sealed] = stored.split(".");
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromB64url(iv) },
		await aesKey(env.TOKEN_KEY),
		fromB64url(sealed),
	);
	return dec.decode(plain);
}

/** Session cookie is `userId.expiry.signature`. Nothing secret is in it. */
async function signSession(env: Env, userId: number) {
	const expires = Date.now() + SESSION_DAYS * 86_400_000;
	const payload = `${userId}.${expires}`;
	const sig = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(env.SESSION_SECRET),
		enc.encode(payload),
	);
	return `${payload}.${b64url(sig)}`;
}

async function verifySession(env: Env, value: string | undefined): Promise<number | null> {
	if (!value) return null;
	const [id, expires, sig] = value.split(".");
	if (!id || !expires || !sig || Number(expires) < Date.now()) return null;
	const ok = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(env.SESSION_SECRET),
		fromB64url(sig),
		enc.encode(`${id}.${expires}`),
	);
	return ok ? Number(id) : null;
}

interface UserRow {
	id: number;
	login: string;
	name: string;
	avatar: string;
	token: string;
}

export async function currentUser<E extends { Bindings: Env }>(
	c: Context<E>,
): Promise<User | null> {
	const id = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
	if (id === null) return null;
	const row = await c.env.DB.prepare("SELECT id, login, name, avatar FROM users WHERE id = ?")
		.bind(id)
		.first<User>();
	return row ?? null;
}

export async function userToken(env: Env, userId: number): Promise<string | null> {
	const row = await env.DB.prepare("SELECT token FROM users WHERE id = ?")
		.bind(userId)
		.first<Pick<UserRow, "token">>();
	return row ? decryptToken(env, row.token) : null;
}

const secure = (c: Context) => new URL(c.req.url).protocol === "https:";

export function login(c: Context<{ Bindings: Env }>) {
	const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
	const next = c.req.query("next") ?? "/";
	setCookie(c, STATE_COOKIE, `${state}|${next}`, {
		httpOnly: true,
		secure: secure(c),
		sameSite: "Lax",
		path: "/auth",
		maxAge: 600,
	});
	const url = new URL("https://github.com/login/oauth/authorize");
	url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/auth/callback", c.req.url).toString());
	url.searchParams.set("scope", "repo read:user");
	url.searchParams.set("state", state);
	return c.redirect(url.toString());
}

export async function callback(c: Context<{ Bindings: Env }>) {
	const [expected, next = "/"] = (getCookie(c, STATE_COOKIE) ?? "").split("|");
	deleteCookie(c, STATE_COOKIE, { path: "/auth" });
	const code = c.req.query("code");
	if (!code || !expected || c.req.query("state") !== expected) {
		return c.text("Sign-in expired. Try again.", 400);
	}

	const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: c.env.GITHUB_CLIENT_ID,
			client_secret: c.env.GITHUB_CLIENT_SECRET,
			code,
		}),
	});
	const { access_token } = await tokenRes.json<{ access_token?: string }>();
	if (!access_token) return c.text("GitHub refused the sign-in.", 400);

	const gh = await fetch("https://api.github.com/user", {
		headers: { Authorization: `Bearer ${access_token}`, "User-Agent": "annomate" },
	});
	const profile = await gh.json<{
		id: number;
		login: string;
		name: string | null;
		avatar_url: string;
	}>();

	await c.env.DB.prepare(
		`INSERT INTO users (id, login, name, avatar, token, created_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name,
		   avatar = excluded.avatar, token = excluded.token`,
	)
		.bind(
			profile.id,
			profile.login,
			profile.name ?? profile.login,
			profile.avatar_url,
			await encryptToken(c.env, access_token),
			Date.now(),
		)
		.run();

	setCookie(c, SESSION_COOKIE, await signSession(c.env, profile.id), {
		httpOnly: true,
		secure: secure(c),
		sameSite: "Lax",
		path: "/",
		maxAge: SESSION_DAYS * 86_400,
	});
	return c.redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

/**
 * Local development and end-to-end tests only. Signs in as any GitHub login,
 * using the developer's own token for GitHub calls. Refuses unless DEV_LOGIN
 * is set and the request is to localhost.
 */
export async function devLogin(c: Context<{ Bindings: Env }>) {
	const host = new URL(c.req.url).hostname;
	if (
		c.env.DEV_LOGIN !== "1" ||
		!c.env.DEV_GITHUB_TOKEN ||
		(host !== "localhost" && host !== "127.0.0.1")
	) {
		return c.text("Not found", 404);
	}
	const login = c.req.query("login") ?? "dev";
	const id = Number(c.req.query("id") ?? 1);
	await c.env.DB.prepare(
		`INSERT INTO users (id, login, name, avatar, token, created_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name, token = excluded.token`,
	)
		.bind(
			id,
			login,
			c.req.query("name") ?? login,
			`https://github.com/${login}.png?size=80`,
			await encryptToken(c.env, c.env.DEV_GITHUB_TOKEN),
			Date.now(),
		)
		.run();
	setCookie(c, SESSION_COOKIE, await signSession(c.env, id), {
		httpOnly: true,
		sameSite: "Lax",
		path: "/",
	});
	return c.redirect(c.req.query("next") ?? "/");
}

export function logout(c: Context) {
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	return c.redirect("/");
}
