import { isTextPath } from "../shared/protocol";

const API = "https://api.github.com";

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface TreeEntry {
	path: string;
	sha: string;
	size: number;
}

export interface Snapshot {
	commit: string;
	tree: string;
	text: TreeEntry[];
	binary: TreeEntry[];
}

interface GhCommit {
	sha: string;
	parents: { sha: string }[];
	commit: {
		message: string;
		author?: { name: string; date: string };
		committer?: { date: string };
	};
	author: { login: string; avatar_url: string } | null;
}

export interface HistoryCommit {
	sha: string;
	parents: string[];
	message: string;
	date: string;
	author: { name: string; login: string | null; avatar: string | null };
}

export interface History {
	branches: { name: string; sha: string }[];
	commits: HistoryCommit[];
}

export interface CommitFile {
	path: string;
	/** Set when the file was renamed. */
	previousPath: string | null;
	status: "added" | "removed" | "modified" | "renamed";
	additions: number;
	deletions: number;
	/** Unified diff hunks. GitHub leaves this out for binary files and very large diffs. */
	patch: string | null;
	/** The file's blob after the commit, or before it for a removed file. */
	sha: string | null;
	binary: boolean;
}

export interface CommitDetail extends HistoryCommit {
	files: CommitFile[];
}

interface GhFile {
	filename: string;
	previous_filename?: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
	sha: string | null;
}

interface GhCommitDetail extends GhCommit {
	files?: GhFile[];
}

/** Commits on `head` that `base` lacks, and the combined change to each file. */
export interface Comparison {
	/** "ahead" when `head` builds on `base`. "diverged" when history was rewritten. */
	status: "ahead" | "behind" | "identical" | "diverged";
	ahead: number;
	commits: HistoryCommit[];
	files: CommitFile[];
}

const toCommitFile = (f: GhFile): CommitFile => ({
	path: f.filename,
	previousPath: f.previous_filename ?? null,
	status: fileStatus(f.status),
	additions: f.additions,
	deletions: f.deletions,
	patch: f.patch ?? null,
	sha: f.sha,
	binary: !f.patch && !isTextPath(f.filename),
});

function toHistoryCommit(c: GhCommit): HistoryCommit {
	return {
		sha: c.sha,
		parents: c.parents.map((p) => p.sha),
		message: c.commit.message,
		date: c.commit.committer?.date ?? c.commit.author?.date ?? "",
		author: {
			name: c.commit.author?.name ?? c.author?.login ?? "unknown",
			login: c.author?.login ?? null,
			avatar: c.author?.avatar_url ?? null,
		},
	};
}

function fileStatus(status: string): CommitFile["status"] {
	return status === "added" || status === "removed" || status === "renamed" ? status : "modified";
}

export class GitHub {
	constructor(
		private token: string,
		private repo: string,
	) {}

	private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
		const res = await fetch(`${API}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "annomate",
				"X-GitHub-Api-Version": "2022-11-28",
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
		});
		if (!res.ok) {
			const body = await res.json<{ message?: string }>().catch(() => ({ message: undefined }));
			throw new GitHubError(res.status, body.message ?? `GitHub returned ${res.status}`);
		}
		return res.json<T>();
	}

	async head(branch: string): Promise<string> {
		const ref = await this.call<{ object: { sha: string } }>(
			`/repos/${this.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
		);
		return ref.object.sha;
	}

	async snapshot(commit: string): Promise<Snapshot> {
		const c = await this.call<{ tree: { sha: string } }>(
			`/repos/${this.repo}/git/commits/${commit}`,
		);
		const tree = await this.call<{
			truncated: boolean;
			tree: { path: string; type: string; sha: string; size?: number }[];
		}>(`/repos/${this.repo}/git/trees/${c.tree.sha}?recursive=1`);
		if (tree.truncated) throw new GitHubError(413, "Repository is too large to load");
		const blobs = tree.tree
			.filter((e) => e.type === "blob")
			.map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
		return {
			commit,
			tree: c.tree.sha,
			text: blobs.filter((b) => isTextPath(b.path)),
			binary: blobs.filter((b) => !isTextPath(b.path)),
		};
	}

	async text(sha: string): Promise<string> {
		const blob = await this.call<{ content: string; encoding: string }>(
			`/repos/${this.repo}/git/blobs/${sha}`,
		);
		const bytes = Uint8Array.from(atob(blob.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	}

	async raw(sha: string): Promise<Response> {
		return fetch(`${API}/repos/${this.repo}/git/blobs/${sha}`, {
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github.raw",
				"User-Agent": "annomate",
			},
		});
	}

	/**
	 * Store bytes as a blob. Nothing references it until a commit does, so
	 * this changes no branch.
	 */
	async createBlob(bytes: Uint8Array): Promise<string> {
		let binary = "";
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
		}
		const blob = await this.call<{ sha: string }>(`/repos/${this.repo}/git/blobs`, {
			method: "POST",
			body: JSON.stringify({ content: btoa(binary), encoding: "base64" }),
		});
		return blob.sha;
	}

	async canPush(): Promise<{ ok: boolean; defaultBranch: string }> {
		const repo = await this.call<{ permissions?: { push: boolean }; default_branch: string }>(
			`/repos/${this.repo}`,
		);
		return { ok: repo.permissions?.push ?? false, defaultBranch: repo.default_branch };
	}

	/**
	 * Write a commit on top of `parent`. `changes` maps paths to new text, or
	 * null for a deletion. Fails with 422 if the branch moved past `parent`.
	 */
	async commit(opts: {
		branch: string;
		parent: string;
		parentTree: string;
		message: string;
		/** Path to new text, an existing blob sha (uploaded binaries), or null to delete. */
		changes: Map<string, string | { sha: string } | null>;
	}): Promise<{ sha: string; tree: string }> {
		const tree = await this.call<{ sha: string }>(`/repos/${this.repo}/git/trees`, {
			method: "POST",
			body: JSON.stringify({
				base_tree: opts.parentTree,
				tree: [...opts.changes].map(([path, content]) =>
					content === null
						? { path, mode: "100644", type: "blob", sha: null }
						: typeof content === "string"
							? { path, mode: "100644", type: "blob", content }
							: { path, mode: "100644", type: "blob", sha: content.sha },
				),
			}),
		});
		const commit = await this.call<{ sha: string }>(`/repos/${this.repo}/git/commits`, {
			method: "POST",
			body: JSON.stringify({ message: opts.message, tree: tree.sha, parents: [opts.parent] }),
		});
		await this.call(`/repos/${this.repo}/git/refs/heads/${encodeURIComponent(opts.branch)}`, {
			method: "PATCH",
			body: JSON.stringify({ sha: commit.sha, force: false }),
		});
		return { sha: commit.sha, tree: tree.sha };
	}

	/** Recent commits across the repo's branches, deduplicated, for drawing a graph. */
	async history(perBranch = 40): Promise<History> {
		const branches = await this.call<{ name: string; commit: { sha: string } }[]>(
			`/repos/${this.repo}/branches?per_page=30`,
		);
		const lists = await Promise.all(
			branches.map((b) =>
				this.call<GhCommit[]>(
					`/repos/${this.repo}/commits?sha=${encodeURIComponent(b.name)}&per_page=${perBranch}`,
				),
			),
		);
		const commits = new Map<string, HistoryCommit>();
		for (const c of lists.flat()) {
			if (!commits.has(c.sha)) commits.set(c.sha, toHistoryCommit(c));
		}
		return {
			branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha })),
			commits: [...commits.values()].sort((a, b) => b.date.localeCompare(a.date)),
		};
	}

	/** One commit with its changed files, diffed against its first parent. */
	async commitDetail(sha: string): Promise<CommitDetail> {
		const c = await this.call<GhCommitDetail>(`/repos/${this.repo}/commits/${sha}`);
		return { ...toHistoryCommit(c), files: (c.files ?? []).map(toCommitFile) };
	}

	/**
	 * What `head` adds to `base`. GitHub lists up to 250 commits, newest last here as there, and
	 * diffs up to 300 files. `brief` skips the commit list for a cheap count.
	 */
	async compare(base: string, head: string, brief = false): Promise<Comparison> {
		const c = await this.call<{
			status: Comparison["status"];
			ahead_by: number;
			commits: GhCommit[];
			files?: GhFile[];
		}>(`/repos/${this.repo}/compare/${base}...${head}${brief ? "?per_page=1" : ""}`);
		return {
			status: c.status,
			ahead: c.ahead_by,
			commits: brief ? [] : c.commits.map(toHistoryCommit).reverse(),
			files: brief ? [] : (c.files ?? []).map(toCommitFile),
		};
	}

	static async repos(token: string) {
		const res = await fetch(
			`${API}/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"User-Agent": "annomate",
					Accept: "application/vnd.github+json",
				},
			},
		);
		if (!res.ok) throw new GitHubError(res.status, "Could not list repositories");
		const repos =
			await res.json<
				{
					full_name: string;
					default_branch: string;
					private: boolean;
					pushed_at: string;
					permissions?: { push: boolean };
				}[]
			>();
		return repos
			.filter((r) => r.permissions?.push)
			.map((r) => ({
				repo: r.full_name,
				branch: r.default_branch,
				private: r.private,
				pushedAt: r.pushed_at,
			}));
	}
}
