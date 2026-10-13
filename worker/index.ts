import { Hono } from "hono";
import type { User } from "../shared/protocol";
import { agents } from "./agents";
import { callback, currentUser, devLogin, login, logout, userToken } from "./auth";
import type { Env } from "./env";
import { GitHub, GitHubError } from "./github";
import {
	memberProjects,
	membership,
	PROJECT_COLUMNS,
	type ProjectRow,
	room,
	roomConfig,
} from "./projects";

export { ProjectRoom } from "./room";

type App = { Bindings: Env; Variables: { user: User } };

const app = new Hono<App>();

app.get("/auth/login", login);
app.get("/auth/callback", callback);
app.get("/auth/logout", logout);
app.get("/auth/dev", devLogin);
app.route("/", agents);

app.use("/api/*", async (c, next) => {
	const user = await currentUser(c);
	if (!user) return c.json({ error: "Not signed in" }, 401);
	c.set("user", user);
	await next();
});

app.use("/ws/*", async (c, next) => {
	const user = await currentUser(c);
	if (!user) return c.text("Not signed in", 401);
	c.set("user", user);
	await next();
});

const toProject = (p: ProjectRow & { role?: string }) => ({
	id: p.id,
	repo: p.repo,
	branch: p.branch,
	mainFile: p.main_file,
	icon: p.icon,
	thumbAt: p.thumb_at,
	role: p.role,
	createdAt: p.created_at,
});

app.get("/api/me", (c) => c.json(c.get("user")));

app.get("/api/repos", async (c) => {
	const token = await userToken(c.env, c.get("user").id);
	if (!token) return c.json({ error: "Sign in again" }, 401);
	return c.json(await GitHub.repos(token));
});

app.get("/api/projects", async (c) => {
	return c.json((await memberProjects(c.env, c.get("user").login)).map(toProject));
});

app.post("/api/projects", async (c) => {
	const user = c.get("user");
	const body = await c.req.json<{ repo: string; branch?: string; mainFile?: string }>();
	if (!/^[\w.-]+\/[\w.-]+$/.test(body.repo ?? "")) return c.json({ error: "Use owner/name" }, 400);

	const token = await userToken(c.env, user.id);
	if (!token) return c.json({ error: "Sign in again" }, 401);
	const gh = new GitHub(token, body.repo);
	try {
		const { ok, defaultBranch } = await gh.canPush();
		if (!ok) return c.json({ error: "You need push access to that repo" }, 403);
		const branch = body.branch?.trim() || defaultBranch;
		const existing = await c.env.DB.prepare(
			`SELECT ${PROJECT_COLUMNS}, m.role FROM projects p JOIN members m ON m.project_id = p.id
			 WHERE p.repo = ? COLLATE NOCASE AND p.branch = ? AND m.login = ?`,
		)
			.bind(body.repo, branch, user.login)
			.first<ProjectRow & { role: string }>();
		if (existing) return c.json(toProject(existing));
		const snap = await gh.snapshot(await gh.head(branch));
		const typ = snap.text.filter((e) => e.path.endsWith(".typ")).map((e) => e.path);
		const mainFile =
			body.mainFile?.trim() ||
			typ.find((p) => p === "main.typ") ||
			typ.find((p) => !p.includes("/")) ||
			typ[0];
		if (!mainFile) return c.json({ error: "No .typ files on that branch" }, 400);

		const id = crypto.randomUUID().slice(0, 8);
		const now = Date.now();
		await c.env.DB.batch([
			c.env.DB.prepare(
				"INSERT INTO projects (id, owner_id, repo, branch, main_file, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).bind(id, user.id, body.repo, branch, mainFile, now),
			c.env.DB.prepare(
				"INSERT INTO members (project_id, login, role, added_at) VALUES (?, ?, 'owner', ?)",
			).bind(id, user.login, now),
		]);
		return c.json({
			id,
			repo: body.repo,
			branch,
			mainFile,
			icon: null,
			thumbAt: null,
			role: "owner",
			createdAt: now,
		});
	} catch (err) {
		if (err instanceof GitHubError)
			return c.json({ error: err.message }, err.status === 404 ? 404 : 400);
		throw err;
	}
});

app.get("/api/projects/:id", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (!project) return c.json({ error: "Not found" }, 404);
	const { results } = await c.env.DB.prepare(
		`SELECT m.login, m.role, u.name, u.avatar FROM members m LEFT JOIN users u ON u.login = m.login
		 WHERE m.project_id = ? ORDER BY m.added_at`,
	)
		.bind(project.id)
		.all();
	return c.json({ ...toProject(project), members: results });
});

// A data URL for a small square image. The client resizes before upload.
const ICON = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const ICON_MAX = 80_000;

app.patch("/api/projects/:id", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (project?.role !== "owner") return c.json({ error: "Only the owner can change this" }, 403);
	const body = await c.req.json<{ mainFile?: string; icon?: string | null }>();
	if (body.mainFile !== undefined) {
		if (!body.mainFile.endsWith(".typ"))
			return c.json({ error: "Main file must be a .typ file" }, 400);
		await c.env.DB.prepare("UPDATE projects SET main_file = ? WHERE id = ?")
			.bind(body.mainFile, project.id)
			.run();
	}
	if (body.icon !== undefined) {
		if (body.icon !== null && (body.icon.length > ICON_MAX || !ICON.test(body.icon))) {
			return c.json({ error: "Icon must be a small PNG, JPEG or WebP image" }, 400);
		}
		await c.env.DB.prepare("UPDATE projects SET icon = ? WHERE id = ?")
			.bind(body.icon, project.id)
			.run();
	}
	return c.json({ ok: true });
});

app.delete("/api/projects/:id", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (project?.role !== "owner") return c.json({ error: "Only the owner can delete this" }, 403);
	await room(c.env, project.id).destroy();
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM members WHERE project_id = ?").bind(project.id),
		c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(project.id),
	]);
	return c.json({ ok: true });
});

app.post("/api/projects/:id/members", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (project?.role !== "owner") return c.json({ error: "Only the owner can invite" }, 403);
	const { login } = await c.req.json<{ login: string }>();
	const clean = login?.trim().replace(/^@/, "");
	if (!/^[a-zA-Z\d](?:[a-zA-Z\d-]{0,38})$/.test(clean ?? ""))
		return c.json({ error: "Not a GitHub username" }, 400);
	await c.env.DB.prepare(
		"INSERT OR IGNORE INTO members (project_id, login, role, added_at) VALUES (?, ?, 'editor', ?)",
	)
		.bind(project.id, clean, Date.now())
		.run();
	return c.json({ ok: true });
});

app.delete("/api/projects/:id/members/:login", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (project?.role !== "owner") return c.json({ error: "Only the owner can remove people" }, 403);
	await c.env.DB.prepare(
		"DELETE FROM members WHERE project_id = ? AND login = ? AND role != 'owner'",
	)
		.bind(project.id, c.req.param("login"))
		.run();
	return c.json({ ok: true });
});

app.get("/api/projects/:id/history", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (!project) return c.json({ error: "Not found" }, 404);
	const token = await userToken(c.env, c.get("user").id);
	if (!token) return c.json({ error: "Sign in again" }, 401);
	try {
		return c.json(await new GitHub(token, project.repo).history());
	} catch (err) {
		if (err instanceof GitHubError) return c.json({ error: err.message }, 502);
		throw err;
	}
});

app.get("/api/projects/:id/commits/:sha{[0-9a-f]{40}}", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (!project) return c.json({ error: "Not found" }, 404);
	const token = await userToken(c.env, c.get("user").id);
	if (!token) return c.json({ error: "Sign in again" }, 401);
	try {
		const commit = await new GitHub(token, project.repo).commitDetail(c.req.param("sha"));
		// A full sha names one immutable commit.
		c.header("Cache-Control", "private, max-age=31536000, immutable");
		return c.json(commit);
	} catch (err) {
		if (err instanceof GitHubError) return c.json({ error: err.message }, 502);
		throw err;
	}
});

/** Binary files (images, fonts) by blob sha. Blobs are immutable, so cache hard. */
app.get("/api/projects/:id/blob/:sha", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (!project) return c.json({ error: "Not found" }, 404);
	const sha = c.req.param("sha");
	if (!/^[0-9a-f]{40}$/.test(sha)) return c.json({ error: "Bad sha" }, 400);

	const cache = caches.default;
	const key = new Request(`https://blob.annomate/${project.repo}/${sha}`);
	const hit = await cache.match(key);
	if (hit) return hit;

	const token = await userToken(c.env, c.get("user").id);
	if (!token) return c.json({ error: "Sign in again" }, 401);
	const upstream = await new GitHub(token, project.repo).raw(sha);
	if (!upstream.ok) return c.json({ error: "Could not fetch file" }, 502);
	const res = new Response(upstream.body, {
		headers: {
			"Content-Type": "application/octet-stream",
			"Cache-Control": "private, max-age=31536000, immutable",
		},
	});
	c.executionCtx.waitUntil(cache.put(key, res.clone()));
	return res;
});

const THUMB_MAX = 400_000;
const THUMB_TYPES = ["image/webp", "image/png", "image/jpeg"];

/** Any member may refresh the first-page thumbnail. The client renders it. */
app.put("/api/projects/:id/thumb", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (!project) return c.json({ error: "Not found" }, 404);
	const type = c.req.header("Content-Type") ?? "";
	if (!THUMB_TYPES.includes(type))
		return c.json({ error: "Thumbnail must be WebP, PNG or JPEG" }, 400);
	const bytes = await c.req.arrayBuffer();
	if (!bytes.byteLength || bytes.byteLength > THUMB_MAX)
		return c.json({ error: "Thumbnail too large" }, 413);
	const at = Date.now();
	await c.env.DB.prepare("UPDATE projects SET thumb = ?, thumb_type = ?, thumb_at = ? WHERE id = ?")
		.bind(bytes, type, at, project.id)
		.run();
	return c.json({ thumbAt: at });
});

/** Served with a version in the URL (?v=thumbAt), so it can be cached hard. */
app.get("/api/projects/:id/thumb", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (!project) return c.json({ error: "Not found" }, 404);
	const row = await c.env.DB.prepare("SELECT thumb, thumb_type FROM projects WHERE id = ?")
		.bind(project.id)
		.first<{ thumb: ArrayBuffer | number[] | null; thumb_type: string | null }>();
	if (!row?.thumb) return c.body(null, 404);
	const bytes = row.thumb instanceof ArrayBuffer ? row.thumb : new Uint8Array(row.thumb).buffer;
	return c.body(bytes, 200, {
		"Content-Type": row.thumb_type ?? "image/webp",
		"Cache-Control": "private, max-age=31536000, immutable",
	});
});

const UPLOAD_MAX = 25 * 1024 * 1024;

/** Upload a binary file as a git blob. The client then lists it in the shared document. */
app.post("/api/projects/:id/upload", async (c) => {
	const project = await membership(c.env, c.req.param("id"), c.get("user").login);
	if (!project) return c.json({ error: "Not found" }, 404);
	const bytes = new Uint8Array(await c.req.arrayBuffer());
	if (!bytes.length) return c.json({ error: "Empty file" }, 400);
	if (bytes.length > UPLOAD_MAX) return c.json({ error: "Files are limited to 25 MB" }, 413);
	const token = await userToken(c.env, c.get("user").id);
	if (!token) return c.json({ error: "Sign in again" }, 401);
	try {
		const sha = await new GitHub(token, project.repo).createBlob(bytes);
		// Prime the blob cache so collaborators' previews load it without a GitHub round trip.
		const key = new Request(`https://blob.annomate/${project.repo}/${sha}`);
		c.executionCtx.waitUntil(
			caches.default.put(
				key,
				new Response(bytes, {
					headers: {
						"Content-Type": "application/octet-stream",
						"Cache-Control": "private, max-age=31536000, immutable",
					},
				}),
			),
		);
		return c.json({ sha, size: bytes.length });
	} catch (err) {
		if (err instanceof GitHubError) return c.json({ error: err.message }, 502);
		throw err;
	}
});

app.get("/ws/:id", async (c) => {
	const user = c.get("user");
	const project = await membership(c.env, c.req.param("id"), user.login);
	if (!project) return c.text("Not found", 404);
	if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);

	const headers = new Headers(c.req.raw.headers);
	headers.set("X-User", JSON.stringify(user));
	headers.set("X-Project", JSON.stringify(roomConfig(project)));
	return room(c.env, project.id).fetch(new Request(c.req.raw, { headers }));
});

export default app;
