import { DurableObject } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
	applyMinimalDiff,
	createAnchor,
	livePositions,
	merge3,
	reattach,
	resolveAnchor,
} from "../shared/anchor";
import { buildReport, type Report, type ReportOptions } from "../shared/commentReport";
import { locatePassage } from "../shared/locate";
import {
	type ClientMessage,
	type Comment,
	type GitState,
	MSG_AWARENESS,
	MSG_SYNC,
	type ServerMessage,
	type Thread,
	type User,
} from "../shared/protocol";
import { userToken } from "./auth";
import type { Env } from "./env";
import { GitHub, GitHubError, type Snapshot } from "./github";

export interface ProjectConfig {
	id: string;
	repo: string;
	branch: string;
	mainFile: string;
}

interface Attachment {
	user: User;
	/** Awareness client ids this socket controls, with their last clock. */
	clients: Record<number, number>;
}

/** Compact the update log into one snapshot once it grows past this. */
const COMPACT_AFTER = 400;
const MAX_TEXT_BYTES = 2_000_000;

/**
 * One room per project. Holds the shared Yjs document, relays presence, owns
 * the comment threads and is the only thing that talks to GitHub for the
 * project, so pulls and commits never race each other.
 */
export class ProjectRoom extends DurableObject<Env> {
	private sql: SqlStorage;
	private doc = new Y.Doc();
	private awareness = new awarenessProtocol.Awareness(this.doc);
	private files = this.doc.getMap<Y.Text>("files");
	/** Text of each file at the base commit, so clients can show what changed. */
	private base = this.doc.getMap<string>("base");
	private assets = this.doc.getMap<{ sha: string; size: number }>("assets");
	/** Binary files at the base commit, so uploads and deletions show as changes. */
	private baseAssets = this.doc.getMap<{ sha: string; size: number }>("baseAssets");
	private busy: GitState["busy"] = null;
	private seeding: Promise<void> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS base_blobs (path TEXT PRIMARY KEY, sha TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS threads (
				id TEXT PRIMARY KEY, anchor TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
				resolved_by TEXT, author TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS comments (
				id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, author TEXT NOT NULL,
				body TEXT NOT NULL, created_at INTEGER NOT NULL, edited_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS comments_by_thread ON comments(thread_id);
		`);
		const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(comments)").toArray();
		if (!columns.some((c) => c.name === "via"))
			this.sql.exec("ALTER TABLE comments ADD COLUMN via TEXT");

		for (const row of this.sql.exec<{ data: ArrayBuffer }>(
			"SELECT data FROM updates ORDER BY id",
		)) {
			Y.applyUpdate(this.doc, new Uint8Array(row.data), "load");
		}
		this.awareness.setLocalState(null);
		// Rooms seeded before binaries were tracked: their assets are the base.
		if (this.meta("base_sha") && this.baseAssets.size === 0 && this.assets.size > 0) {
			queueMicrotask(() =>
				this.doc.transact(() => {
					for (const [path, a] of this.assets) this.baseAssets.set(path, a);
				}, "git"),
			);
		}

		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === "load") return;
			this.sql.exec("INSERT INTO updates (data) VALUES (?)", toBuffer(update));
			this.compact();
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, MSG_SYNC);
			syncProtocol.writeUpdate(encoder, update);
			this.broadcastBinary(encoding.toUint8Array(encoder), origin);
		});
	}

	private compact() {
		const { n } = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM updates").one();
		if (n < COMPACT_AFTER) return;
		const snapshot = Y.encodeStateAsUpdate(this.doc);
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM updates");
			this.sql.exec("INSERT INTO updates (data) VALUES (?)", toBuffer(snapshot));
		});
	}

	private meta(key: string): string | null {
		const row = this.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
			.toArray()[0];
		return row?.value ?? null;
	}

	private setMeta(key: string, value: string) {
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
	}

	private get config(): ProjectConfig {
		return JSON.parse(this.meta("config") ?? "null");
	}

	private gitState(): GitState {
		const { repo, branch, mainFile } = this.config;
		return {
			repo,
			branch,
			mainFile,
			baseSha: this.meta("base_sha") ?? "",
			busy: this.busy,
			lastSyncAt: Number(this.meta("last_sync") ?? 0),
		};
	}

	/** Drop everything this room holds: document, comments and git state. */
	// Coding agents, through the MCP server. Each call names the project, because the room may
	// not have been opened by a browser since it last woke.

	async report(user: User, config: ProjectConfig, options: ReportOptions): Promise<Report> {
		await this.prepare(user, config);
		const { repo, branch, baseSha } = this.gitState();
		return buildReport(this.doc, this.threads(), { repo, branch, commit: baseSha }, options);
	}

	async agentReply(
		user: User,
		config: ProjectConfig,
		threadId: string,
		body: string,
		via: string,
	): Promise<Thread | null> {
		await this.prepare(user, config);
		if (!body.trim() || !this.thread(threadId)) return null;
		this.sql.exec(
			"INSERT INTO comments (id, thread_id, author, body, created_at, via) VALUES (?, ?, ?, ?, ?, ?)",
			crypto.randomUUID(),
			threadId,
			JSON.stringify(user),
			body.trim(),
			Date.now(),
			via,
		);
		this.publish(threadId);
		return this.thread(threadId);
	}

	/**
	 * Start a thread on a passage, named by its text and/or line as the agent sees it. The anchor
	 * is built from the live text, the same as a comment made in the browser.
	 */
	async agentCreateThread(
		user: User,
		config: ProjectConfig,
		target: { file?: string; quote?: string; line?: number },
		body: string,
		via: string,
	): Promise<{ thread: Thread; line: number } | { error: string }> {
		await this.prepare(user, config);
		if (!body.trim()) return { error: "The comment is empty." };
		const file = target.file?.replace(/^\/+/, "") || this.config.mainFile;
		const text = this.files.get(file);
		if (!text) {
			const known = [...this.files.keys()].filter((p) => !p.endsWith(".gitkeep")).sort();
			return { error: `No file ${file} in this project. Files: ${known.join(", ")}` };
		}
		const place = locatePassage(text.toString(), target);
		if ("error" in place) return place;

		const id = crypto.randomUUID();
		const now = Date.now();
		const anchor = createAnchor(text, file, place.from, place.to, this.meta("base_sha") ?? "");
		this.sql.exec(
			"INSERT INTO threads (id, anchor, author, created_at) VALUES (?, ?, ?, ?)",
			id,
			JSON.stringify(anchor),
			JSON.stringify(user),
			now,
		);
		this.sql.exec(
			"INSERT INTO comments (id, thread_id, author, body, created_at, via) VALUES (?, ?, ?, ?, ?, ?)",
			`${id}-0`,
			id,
			JSON.stringify(user),
			body.trim(),
			now,
			via,
		);
		this.publish(id);
		const thread = this.thread(id);
		return thread ? { thread, line: anchor.line } : { error: "The thread could not be saved." };
	}

	/** Replace the text of a comment. Agents write as their person, so only that person's comments. */
	async agentEditComment(
		user: User,
		config: ProjectConfig,
		commentId: string,
		body: string,
	): Promise<{ thread: Thread } | { error: string }> {
		await this.prepare(user, config);
		if (!body.trim()) return { error: "The new text is empty." };
		const row = this.sql
			.exec<CommentRow>("SELECT * FROM comments WHERE id = ?", commentId)
			.toArray()[0];
		if (!row) return { error: `No message \`${commentId}\` in this project.` };
		if (JSON.parse(row.author).id !== user.id)
			return {
				error: `Message \`${commentId}\` was written by someone else, so it cannot be edited.`,
			};
		this.sql.exec(
			"UPDATE comments SET body = ?, edited_at = ? WHERE id = ?",
			body.trim(),
			Date.now(),
			commentId,
		);
		this.publish(row.thread_id);
		const thread = this.thread(row.thread_id);
		return thread ? { thread } : { error: "The thread could not be read back." };
	}

	async agentResolve(
		user: User,
		config: ProjectConfig,
		threadId: string,
		resolved: boolean,
	): Promise<Thread | null> {
		await this.prepare(user, config);
		if (!this.thread(threadId)) return null;
		this.sql.exec(
			"UPDATE threads SET resolved = ?, resolved_by = ? WHERE id = ?",
			resolved ? 1 : 0,
			resolved ? JSON.stringify(user) : null,
			threadId,
		);
		this.publish(threadId);
		return this.thread(threadId);
	}

	private async prepare(user: User, config: ProjectConfig) {
		this.setMeta("config", JSON.stringify(config));
		await this.ensureSeeded(user);
	}

	async destroy() {
		for (const ws of this.ctx.getWebSockets()) ws.close(1000, "Project deleted");
		await this.ctx.storage.deleteAll();
	}

	// Connections

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket")
			return new Response("Expected WebSocket", { status: 426 });
		const user: User = JSON.parse(request.headers.get("X-User") ?? "null");
		const config: ProjectConfig = JSON.parse(request.headers.get("X-Project") ?? "null");
		this.setMeta("config", JSON.stringify(config));

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ user, clients: {} } satisfies Attachment);

		try {
			await this.ensureSeeded(user);
		} catch (err) {
			this.send(server, { t: "error", message: describe(err) });
		}

		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MSG_SYNC);
		syncProtocol.writeSyncStep1(encoder, this.doc);
		server.send(encoding.toUint8Array(encoder));

		const states = [...this.awareness.getStates().keys()];
		if (states.length) {
			const aw = encoding.createEncoder();
			encoding.writeVarUint(aw, MSG_AWARENESS);
			encoding.writeVarUint8Array(
				aw,
				awarenessProtocol.encodeAwarenessUpdate(this.awareness, states),
			);
			server.send(encoding.toUint8Array(aw));
		}

		this.send(server, { t: "hello", me: user, threads: this.threads(), git: this.gitState() });
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (typeof message === "string") {
			await this.handle(ws, JSON.parse(message) as ClientMessage);
			return;
		}
		const bytes = new Uint8Array(message);
		const decoder = decoding.createDecoder(bytes);
		const type = decoding.readVarUint(decoder);
		if (type === MSG_SYNC) {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, MSG_SYNC);
			syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
			if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
		} else if (type === MSG_AWARENESS) {
			const update = decoding.readVarUint8Array(decoder);
			this.track(ws, update);
			awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);
			this.broadcastBinary(bytes, ws);
		}
	}

	async webSocketClose(ws: WebSocket) {
		this.drop(ws);
	}

	async webSocketError(ws: WebSocket) {
		this.drop(ws);
	}

	/** Remember which awareness clients a socket owns, so we can clear them when it goes. */
	private track(ws: WebSocket, update: Uint8Array) {
		const att = ws.deserializeAttachment() as Attachment;
		const decoder = decoding.createDecoder(update);
		const count = decoding.readVarUint(decoder);
		for (let i = 0; i < count; i++) {
			const id = decoding.readVarUint(decoder);
			const clock = decoding.readVarUint(decoder);
			const state = decoding.readVarString(decoder);
			if (state === "null") delete att.clients[id];
			else att.clients[id] = clock;
		}
		ws.serializeAttachment(att);
	}

	/**
	 * After hibernation the in-memory awareness is empty, so the removal is
	 * written by hand from the clocks kept on the socket.
	 */
	private drop(ws: WebSocket) {
		const att = ws.deserializeAttachment() as Attachment | null;
		const ids = Object.entries(att?.clients ?? {});
		if (!ids.length) return;
		const update = encoding.createEncoder();
		encoding.writeVarUint(update, ids.length);
		for (const [id, clock] of ids) {
			encoding.writeVarUint(update, Number(id));
			encoding.writeVarUint(update, clock + 1);
			encoding.writeVarString(update, "null");
		}
		const bytes = encoding.toUint8Array(update);
		awarenessProtocol.applyAwarenessUpdate(this.awareness, bytes, ws);
		const msg = encoding.createEncoder();
		encoding.writeVarUint(msg, MSG_AWARENESS);
		encoding.writeVarUint8Array(msg, bytes);
		this.broadcastBinary(encoding.toUint8Array(msg), ws);
	}

	private broadcastBinary(data: Uint8Array, except?: unknown) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws !== except) ws.send(data);
		}
	}

	private send(ws: WebSocket, msg: ServerMessage) {
		ws.send(JSON.stringify(msg));
	}

	private broadcast(msg: ServerMessage) {
		const data = JSON.stringify(msg);
		for (const ws of this.ctx.getWebSockets()) ws.send(data);
	}

	// Comments

	private threads(): Thread[] {
		const comments = new Map<string, Comment[]>();
		for (const c of this.sql.exec<CommentRow>("SELECT * FROM comments ORDER BY created_at")) {
			const list = comments.get(c.thread_id) ?? [];
			list.push(toComment(c));
			comments.set(c.thread_id, list);
		}
		return this.sql
			.exec<ThreadRow>("SELECT * FROM threads ORDER BY created_at")
			.toArray()
			.map((t) => toThread(t, comments.get(t.id) ?? []));
	}

	private thread(id: string): Thread | null {
		const row = this.sql.exec<ThreadRow>("SELECT * FROM threads WHERE id = ?", id).toArray()[0];
		if (!row) return null;
		const comments = this.sql
			.exec<CommentRow>("SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at", id)
			.toArray()
			.map(toComment);
		return toThread(row, comments);
	}

	private publish(threadId: string) {
		const thread = this.thread(threadId);
		if (thread) this.broadcast({ t: "thread.upsert", thread });
		else this.broadcast({ t: "thread.remove", id: threadId });
	}

	private async handle(ws: WebSocket, msg: ClientMessage) {
		const { user } = ws.deserializeAttachment() as Attachment;
		const now = Date.now();
		switch (msg.t) {
			case "thread.create": {
				if (!msg.body.trim()) return;
				this.sql.exec(
					"INSERT INTO threads (id, anchor, author, created_at) VALUES (?, ?, ?, ?)",
					msg.id,
					JSON.stringify(msg.anchor),
					JSON.stringify(user),
					now,
				);
				this.sql.exec(
					"INSERT INTO comments (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)",
					`${msg.id}-0`,
					msg.id,
					JSON.stringify(user),
					msg.body,
					now,
				);
				return this.publish(msg.id);
			}
			case "comment.add": {
				if (!msg.body.trim() || !this.thread(msg.threadId)) return;
				this.sql.exec(
					"INSERT INTO comments (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)",
					msg.id,
					msg.threadId,
					JSON.stringify(user),
					msg.body,
					now,
				);
				return this.publish(msg.threadId);
			}
			case "comment.edit": {
				const row = this.ownComment(msg.id, user);
				if (!row || !msg.body.trim()) return;
				this.sql.exec(
					"UPDATE comments SET body = ?, edited_at = ? WHERE id = ?",
					msg.body,
					now,
					msg.id,
				);
				return this.publish(row.thread_id);
			}
			case "comment.delete": {
				const row = this.ownComment(msg.id, user);
				if (!row) return;
				this.sql.exec("DELETE FROM comments WHERE id = ?", msg.id);
				const left = this.sql
					.exec<{ n: number }>(
						"SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?",
						row.thread_id,
					)
					.one().n;
				if (left === 0) this.sql.exec("DELETE FROM threads WHERE id = ?", row.thread_id);
				return this.publish(row.thread_id);
			}
			case "thread.resolve": {
				this.sql.exec(
					"UPDATE threads SET resolved = ?, resolved_by = ? WHERE id = ?",
					msg.resolved ? 1 : 0,
					msg.resolved ? JSON.stringify(user) : null,
					msg.id,
				);
				return this.publish(msg.id);
			}
			case "thread.delete": {
				const thread = this.thread(msg.id);
				if (!thread || thread.author.id !== user.id) return;
				this.sql.exec("DELETE FROM comments WHERE thread_id = ?", msg.id);
				this.sql.exec("DELETE FROM threads WHERE id = ?", msg.id);
				return this.publish(msg.id);
			}
			case "file.move":
				return this.move(ws, msg.from, msg.to);
			case "git.pull":
				return this.runGit("pull", user, () => this.pull(user));
			case "git.commit":
				return this.runGit("commit", user, () => this.commit(user, msg.message));
		}
	}

	/**
	 * Move or rename a file or folder. Text is copied into a new shared type,
	 * so each comment is re-pinned to the same offsets in the new one.
	 */
	private move(ws: WebSocket, rawFrom: string, rawTo: string) {
		const clean = (p: string) =>
			p
				.split("/")
				.filter((s) => s && s !== "." && s !== "..")
				.join("/");
		const from = clean(rawFrom);
		const to = clean(rawTo);
		if (!from || !to || from === to || to.startsWith(`${from}/`)) return;

		const target = (path: string) =>
			path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
		const textMoves = [...this.files.keys()].flatMap((p) => {
			const t = target(p);
			return t ? [[p, t] as const] : [];
		});
		const assetMoves = [...this.assets.keys()].flatMap((p) => {
			const t = target(p);
			return t ? [[p, t] as const] : [];
		});
		const clash = [...textMoves, ...assetMoves].find(
			([, t]) => this.files.has(t) || this.assets.has(t),
		);
		if (clash) return this.send(ws, { t: "error", message: `${clash[1]} already exists` });
		if (!textMoves.length && !assetMoves.length) return;

		// Where each open comment sits now, by file.
		const pins = new Map<string, { thread: Thread; from: number; to: number; live: boolean }[]>();
		for (const thread of this.threads()) {
			const text = this.files.get(thread.anchor.file);
			if (!text || !target(thread.anchor.file)) continue;
			const r = resolveAnchor(this.doc, text, thread.anchor);
			const list = pins.get(thread.anchor.file) ?? [];
			list.push({ thread, from: r.from, to: r.to, live: r.status !== "detached" });
			pins.set(thread.anchor.file, list);
		}

		this.doc.transact(() => {
			for (const [a, b] of textMoves) {
				const content = this.files.get(a)?.toString() ?? "";
				this.files.delete(a);
				this.files.set(b, new Y.Text(content));
			}
			for (const [a, b] of assetMoves) {
				const asset = this.assets.get(a);
				this.assets.delete(a);
				if (asset) this.assets.set(b, asset);
			}
			// A folder emptied by the move stays, held by a placeholder, so things do not vanish.
			const source = from.split("/").slice(0, -1).join("/");
			const remaining = [...this.files.keys(), ...this.assets.keys()].some((p) =>
				p.startsWith(`${source}/`),
			);
			if (source && !remaining && !to.startsWith(`${source}/`))
				this.files.set(`${source}/.gitkeep`, new Y.Text(""));
			// The destination folder's placeholder goes once a real file lands in it.
			const folder = to.split("/").slice(0, -1).join("/");
			const keep = `${folder}/.gitkeep`;
			if (folder && this.files.has(keep) && keep !== to && !keep.startsWith(`${to}/`))
				this.files.delete(keep);
		}, "move");

		for (const [a, b] of textMoves) {
			const text = this.files.get(b);
			for (const pin of pins.get(a) ?? []) {
				let anchor = { ...pin.thread.anchor, file: b };
				if (text && pin.live) anchor = { ...anchor, ...livePositions(text, pin.from, pin.to) };
				this.sql.exec(
					"UPDATE threads SET anchor = ? WHERE id = ?",
					JSON.stringify(anchor),
					pin.thread.id,
				);
				this.publish(pin.thread.id);
			}
		}
	}

	private ownComment(id: string, user: User): CommentRow | null {
		const row = this.sql.exec<CommentRow>("SELECT * FROM comments WHERE id = ?", id).toArray()[0];
		return row && JSON.parse(row.author).id === user.id ? row : null;
	}

	// Git

	private async github(user: User): Promise<GitHub> {
		const token = await userToken(this.env, user.id);
		if (!token) throw new Error("Sign in again to use GitHub");
		return new GitHub(token, this.config.repo);
	}

	private async ensureSeeded(user: User) {
		if (this.meta("base_sha")) return;
		this.seeding ??= (async () => {
			const gh = await this.github(user);
			const head = await gh.head(this.config.branch);
			const snap = await gh.snapshot(head);
			const texts = await fetchTexts(gh, snap.text);
			this.doc.transact(() => {
				for (const [path, content] of texts) {
					this.files.set(path, new Y.Text(content));
					this.base.set(path, content);
				}
				for (const b of snap.binary) {
					this.assets.set(b.path, { sha: b.sha, size: b.size });
					this.baseAssets.set(b.path, { sha: b.sha, size: b.size });
				}
			}, "git");
			this.setBase(snap);
		})().finally(() => {
			this.seeding = null;
		});
		await this.seeding;
	}

	/**
	 * Take upstream binaries, except where someone here uploaded, replaced or
	 * removed a file since the base commit. Those local changes win until committed.
	 */
	private setAssets(snap: Snapshot) {
		const remote = new Map(snap.binary.map((b) => [b.path, { sha: b.sha, size: b.size }]));
		const untouched = (path: string) =>
			this.assets.get(path)?.sha === this.baseAssets.get(path)?.sha;
		for (const path of [...this.assets.keys()]) {
			if (!remote.has(path) && this.baseAssets.has(path) && untouched(path))
				this.assets.delete(path);
		}
		for (const [path, b] of remote) {
			const deletedHere = this.baseAssets.has(path) && !this.assets.has(path);
			if (deletedHere) continue;
			if (!this.assets.has(path) || untouched(path)) {
				if (this.assets.get(path)?.sha !== b.sha) this.assets.set(path, b);
			}
		}
		for (const path of [...this.baseAssets.keys()])
			if (!remote.has(path)) this.baseAssets.delete(path);
		for (const [path, b] of remote)
			if (this.baseAssets.get(path)?.sha !== b.sha) this.baseAssets.set(path, b);
	}

	private setBase(snap: Snapshot) {
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM base_blobs");
			for (const e of snap.text)
				this.sql.exec("INSERT INTO base_blobs (path, sha) VALUES (?, ?)", e.path, e.sha);
			this.setMeta("base_sha", snap.commit);
			this.setMeta("base_tree", snap.tree);
			this.setMeta("last_sync", String(Date.now()));
		});
	}

	private async runGit(
		op: "pull" | "commit",
		user: User,
		fn: () => Promise<{ message: string; sha?: string }>,
	) {
		if (this.busy) {
			this.broadcast({
				t: "git.result",
				op,
				ok: false,
				message: `A ${this.busy} is already running`,
				by: user,
			});
			return;
		}
		this.busy = op;
		this.broadcast({ t: "git.state", git: this.gitState() });
		try {
			const { message, sha } = await fn();
			this.broadcast({ t: "git.result", op, ok: true, message, sha, by: user });
		} catch (err) {
			this.broadcast({ t: "git.result", op, ok: false, message: describe(err), by: user });
		} finally {
			this.busy = null;
			this.broadcast({ t: "git.state", git: this.gitState() });
		}
	}

	/**
	 * Bring upstream changes into the shared document. Each file is merged
	 * three ways and written back as a minimal diff, so text nobody touched
	 * keeps its identity and the comments anchored in it stay put.
	 */
	private async pull(user: User): Promise<{ message: string; sha?: string }> {
		const gh = await this.github(user);
		const head = await gh.head(this.config.branch);
		if (head === this.meta("base_sha")) {
			this.setMeta("last_sync", String(Date.now()));
			return { message: "Already up to date" };
		}
		const snap = await gh.snapshot(head);
		const known = new Map(
			this.sql
				.exec<{ path: string; sha: string }>("SELECT path, sha FROM base_blobs")
				.toArray()
				.map((r) => [r.path, r.sha]),
		);
		const changed = snap.text.filter((e) => known.get(e.path) !== e.sha);
		const removed = [...known.keys()].filter((p) => !snap.text.some((e) => e.path === p));
		const remote = await fetchTexts(gh, changed);
		const conflicts: string[] = [];

		this.doc.transact(() => {
			for (const [path, theirs] of remote) {
				const text = this.files.get(path);
				if (!text) {
					this.files.set(path, new Y.Text(theirs));
				} else {
					const merged = merge3(this.base.get(path) ?? "", text.toString(), theirs);
					if (!merged.clean) conflicts.push(path);
					applyMinimalDiff(text, merged.text);
				}
				this.base.set(path, theirs);
			}
			for (const path of removed) {
				const text = this.files.get(path);
				if (text && text.toString() === this.base.get(path)) this.files.delete(path);
				this.base.delete(path);
			}
			this.setAssets(snap);
		}, "git");
		this.setBase(snap);
		this.reanchor();

		const count = remote.size + removed.length;
		const summary = `Pulled ${head.slice(0, 7)}, ${count} file${count === 1 ? "" : "s"} changed`;
		return {
			message: conflicts.length
				? `${summary}. Overlapping edits in ${conflicts.join(", ")}, check them`
				: summary,
			sha: head,
		};
	}

	private async commit(user: User, message: string): Promise<{ message: string; sha?: string }> {
		const gh = await this.github(user);
		let pulled = "";
		if ((await gh.head(this.config.branch)) !== this.meta("base_sha")) {
			pulled = `${(await this.pull(user)).message}. `;
		}

		const changes = new Map<string, string | { sha: string } | null>();
		for (const [path, text] of this.files) {
			const content = text.toString();
			if (content !== this.base.get(path)) changes.set(path, content);
		}
		for (const path of this.base.keys()) if (!this.files.has(path)) changes.set(path, null);
		for (const [path, a] of this.assets) {
			if (this.baseAssets.get(path)?.sha !== a.sha) changes.set(path, { sha: a.sha });
		}
		for (const path of this.baseAssets.keys()) if (!this.assets.has(path)) changes.set(path, null);
		if (!changes.size) return { message: `${pulled}Nothing to commit` };

		const write = () =>
			gh.commit({
				branch: this.config.branch,
				parent: this.meta("base_sha") ?? "",
				parentTree: this.meta("base_tree") ?? "",
				message: message.trim() || "Edit in annomate",
				changes,
			});

		let result: { sha: string };
		try {
			result = await write();
		} catch (err) {
			if (!(err instanceof GitHubError && err.status === 422)) throw err;
			// The branch moved while we were writing. Merge and try once more.
			pulled = `${(await this.pull(user)).message}. `;
			result = await write();
		}

		this.doc.transact(() => {
			for (const [path, content] of changes) {
				if (content === null) {
					this.base.delete(path);
					this.baseAssets.delete(path);
				} else if (typeof content === "string") {
					this.base.set(path, content);
				} else {
					const a = this.assets.get(path);
					if (a) this.baseAssets.set(path, a);
				}
			}
		}, "git");
		this.setBase(await gh.snapshot(result.sha));
		const n = changes.size;
		return {
			message: `${pulled}Committed ${result.sha.slice(0, 7)}, ${n} file${n === 1 ? "" : "s"}`,
			sha: result.sha,
		};
	}

	/** Re-attach live positions for any thread that had to be found by search. */
	private reanchor() {
		for (const thread of this.threads()) {
			if (thread.resolved) continue;
			const text = this.files.get(thread.anchor.file);
			if (!text) continue;
			const r = resolveAnchor(this.doc, text, thread.anchor);
			if (!r.searched || r.status === "detached") continue;
			const anchor = reattach(text, thread.anchor, r);
			this.sql.exec(
				"UPDATE threads SET anchor = ? WHERE id = ?",
				JSON.stringify(anchor),
				thread.id,
			);
			this.publish(thread.id);
		}
	}
}

const toBuffer = (bytes: Uint8Array) =>
	bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function fetchTexts(gh: GitHub, entries: { path: string; sha: string; size: number }[]) {
	const out = new Map<string, string>();
	const queue = entries.filter((e) => e.size <= MAX_TEXT_BYTES);
	const workers = Array.from({ length: 6 }, async () => {
		for (let e = queue.shift(); e; e = queue.shift()) out.set(e.path, await gh.text(e.sha));
	});
	await Promise.all(workers);
	return out;
}

function describe(err: unknown): string {
	if (err instanceof GitHubError && err.status === 404)
		return "GitHub could not find that repo or branch";
	if (err instanceof GitHubError && err.status === 401)
		return "GitHub sign-in expired. Sign in again";
	return err instanceof Error ? err.message : String(err);
}

type ThreadRow = {
	id: string;
	anchor: string;
	resolved: number;
	resolved_by: string | null;
	author: string;
	created_at: number;
};

type CommentRow = {
	id: string;
	thread_id: string;
	author: string;
	body: string;
	created_at: number;
	edited_at: number | null;
	via: string | null;
};

const toComment = (c: CommentRow): Comment => ({
	id: c.id,
	threadId: c.thread_id,
	author: JSON.parse(c.author),
	body: c.body,
	createdAt: c.created_at,
	editedAt: c.edited_at ?? undefined,
	via: c.via ?? undefined,
});

const toThread = (t: ThreadRow, comments: Comment[]): Thread => ({
	id: t.id,
	anchor: JSON.parse(t.anchor),
	resolved: t.resolved === 1,
	resolvedBy: t.resolved_by ? JSON.parse(t.resolved_by) : undefined,
	author: JSON.parse(t.author),
	createdAt: t.created_at,
	comments,
});
