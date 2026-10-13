import type { User } from "../shared/protocol";

export interface Project {
	id: string;
	repo: string;
	branch: string;
	mainFile: string;
	/** Custom icon as a data URL, or null for the generated one. */
	icon: string | null;
	/** When the first-page thumbnail was last saved, or null if never. */
	thumbAt: number | null;
	role: "owner" | "editor";
	createdAt: number;
}

export interface Member {
	login: string;
	role: "owner" | "editor";
	name: string | null;
	avatar: string | null;
}

export interface Repo {
	repo: string;
	branch: string;
	private: boolean;
	pushedAt: string;
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
	previousPath: string | null;
	status: "added" | "removed" | "modified" | "renamed";
	additions: number;
	deletions: number;
	/** Null for binary files and diffs too large for GitHub to return. */
	patch: string | null;
	sha: string | null;
	binary: boolean;
}

export interface CommitDetail extends HistoryCommit {
	files: CommitFile[];
}

export interface AgentConnection {
	id: string;
	client: string;
	scope: string[];
	createdAt: number;
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		...init,
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
	return body as T;
}

export const api = {
	me: () => call<User>("/api/me"),
	repos: () => call<Repo[]>("/api/repos"),
	projects: () => call<Project[]>("/api/projects"),
	project: (id: string) => call<Project & { members: Member[] }>(`/api/projects/${id}`),
	createProject: (body: { repo: string; branch?: string; mainFile?: string }) =>
		call<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
	history: (id: string) => call<History>(`/api/projects/${id}/history`),
	agents: () => call<AgentConnection[]>("/api/agents"),
	disconnectAgent: (id: string) =>
		call(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
	commit: (id: string, sha: string) => call<CommitDetail>(`/api/projects/${id}/commits/${sha}`),
	updateProject: (id: string, patch: { mainFile?: string; icon?: string | null }) =>
		call(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
	upload: async (id: string, file: Blob): Promise<{ sha: string; size: number }> => {
		const res = await fetch(`/api/projects/${id}/upload`, { method: "POST", body: file });
		const body = await res.json().catch(() => ({}));
		if (!res.ok) throw new ApiError(res.status, body.error ?? `Upload failed (${res.status})`);
		return body;
	},
	saveThumb: async (id: string, image: Blob): Promise<void> => {
		await fetch(`/api/projects/${id}/thumb`, {
			method: "PUT",
			body: image,
			headers: { "Content-Type": image.type },
		});
	},
	deleteProject: (id: string) => call(`/api/projects/${id}`, { method: "DELETE" }),
	invite: (id: string, login: string) =>
		call(`/api/projects/${id}/members`, { method: "POST", body: JSON.stringify({ login }) }),
	removeMember: (id: string, login: string) =>
		call(`/api/projects/${id}/members/${encodeURIComponent(login)}`, { method: "DELETE" }),
};

export const signIn = () => {
	location.href = `/auth/login?next=${encodeURIComponent(location.pathname)}`;
};

export function ago(ts: number): string {
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.round(h / 24);
	if (d < 30) return `${d}d`;
	return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
