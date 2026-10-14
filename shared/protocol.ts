import type { Anchor } from "./anchor";

export interface User {
	id: number;
	login: string;
	name: string;
	avatar: string;
}

export interface Comment {
	id: string;
	threadId: string;
	author: User;
	body: string;
	createdAt: number;
	editedAt?: number;
	/** The coding agent that wrote this on the author's behalf, by its client name. */
	via?: string;
}

export interface Thread {
	id: string;
	anchor: Anchor;
	resolved: boolean;
	resolvedBy?: User;
	createdAt: number;
	author: User;
	comments: Comment[];
}

export interface GitState {
	repo: string;
	branch: string;
	mainFile: string;
	baseSha: string;
	busy: "pull" | "commit" | null;
	lastSyncAt: number;
	/** New commits on the branch that annomate has not pulled, as of the last check. */
	upstream: Upstream | null;
}

export interface Upstream {
	sha: string;
	/** Commits on the branch since `baseSha`. */
	ahead: number;
	/** The branch's history was rewritten, so `baseSha` is no longer part of it. */
	diverged: boolean;
}

/** A file a pull would change, as GitHub reports it, plus what happens to annomate's edits. */
export interface PullFile {
	path: string;
	previousPath: string | null;
	status: "added" | "removed" | "modified" | "renamed";
	additions: number;
	deletions: number;
	patch: string | null;
	sha: string | null;
	binary: boolean;
	/**
	 * none: annomate has no edits to it. merges: the edits and the incoming change combine.
	 * overlaps: they touch the same text, so some incoming changes will not apply.
	 * kept: it was deleted upstream, but annomate keeps it because it was edited here.
	 */
	local: "none" | "merges" | "overlaps" | "kept";
}

export interface PullCommit {
	sha: string;
	message: string;
	date: string;
	author: { name: string; login: string | null; avatar: string | null };
}

/** Everything a pull would do, shown before anyone confirms it. */
export interface PullPreview {
	base: string;
	head: string;
	diverged: boolean;
	commits: PullCommit[];
	/** GitHub lists at most 250 commits. */
	more: number;
	files: PullFile[];
	/** Open comments on files the pull changes, and what becomes of each. */
	comments: { id: string; file: string; quote: string; effect: "kept" | "changed" | "lost" }[];
}

/** Binary frames carry Yjs sync and awareness, tagged by their first varuint. */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

export type ClientMessage =
	| { t: "thread.create"; id: string; anchor: Anchor; body: string }
	| { t: "thread.resolve"; id: string; resolved: boolean }
	| { t: "thread.delete"; id: string }
	| { t: "comment.add"; threadId: string; id: string; body: string }
	| { t: "comment.edit"; id: string; body: string }
	| { t: "comment.delete"; id: string }
	| { t: "file.move"; from: string; to: string }
	| { t: "git.check" }
	| { t: "git.preview" }
	/** Pull exactly `head`, the commit a preview showed, even if the branch has moved on since. */
	| { t: "git.pull"; head: string }
	| { t: "git.commit"; message: string };

export type ServerMessage =
	| { t: "hello"; me: User; threads: Thread[]; git: GitState }
	| { t: "thread.upsert"; thread: Thread }
	| { t: "thread.remove"; id: string }
	| { t: "git.state"; git: GitState }
	| { t: "git.result"; op: "pull" | "commit"; ok: boolean; message: string; by: User; sha?: string }
	| { t: "git.preview"; preview: PullPreview | null; error?: string }
	| { t: "error"; message: string };

/** What each client publishes through Yjs awareness. */
export interface Presence {
	user: User & { color: string; colorLight: string };
	file: string | null;
	/** Mouse position over the preview, in Typst points from the document's top left. */
	pointer: { x: number; y: number } | null;
	/** Vertical centre of the preview viewport, in points, for follow mode. */
	view: { y: number } | null;
	/** Set by y-codemirror.next. */
	cursor?: unknown;
}

export const TEXT_EXTENSIONS = [
	".typ",
	".bib",
	".yml",
	".yaml",
	".toml",
	".csv",
	".json",
	".txt",
	".md",
	".tex",
	".xml",
	".svg",
	".csl",
];

export const isTextPath = (path: string) =>
	TEXT_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
