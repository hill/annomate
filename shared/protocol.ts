import type { Anchor } from "./anchor";
import type { ProjectFormat } from "./formats";

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
	format: ProjectFormat;
	mainFile: string;
	baseSha: string;
	busy: "pull" | "commit" | null;
	lastSyncAt: number;
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
	| { t: "git.pull" }
	| { t: "git.commit"; message: string };

export type ServerMessage =
	| { t: "hello"; me: User; threads: Thread[]; git: GitState }
	| { t: "thread.upsert"; thread: Thread }
	| { t: "thread.remove"; id: string }
	| { t: "git.state"; git: GitState }
	| { t: "git.result"; op: "pull" | "commit"; ok: boolean; message: string; by: User; sha?: string }
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
	".markdown",
	".tex",
	".xml",
	".svg",
	".csl",
	// LaTeX classes, packages, bibliography styles and their configuration.
	".sty",
	".cls",
	".bst",
	".bbx",
	".cbx",
	".def",
	".cfg",
	".ltx",
];

/** Text files known by name rather than extension. */
const TEXT_NAMES = ["latexmkrc", ".latexmkrc"];

export const isTextPath = (path: string) => {
	const lower = path.toLowerCase();
	return (
		TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
		TEXT_NAMES.includes(lower.split("/").pop() ?? "")
	);
};
