import { api, type CommitDetail } from "../api";

// Commits never change, so a fetched one is good for the life of the page.
const pending = new Map<string, Promise<CommitDetail>>();
const loaded = new Map<string, CommitDetail>();

export function loadCommit(projectId: string, sha: string): Promise<CommitDetail> {
	const key = `${projectId}/${sha}`;
	let request = pending.get(key);
	if (!request) {
		request = api.commit(projectId, sha);
		request.then(
			(detail) => loaded.set(key, detail),
			() => pending.delete(key),
		);
		pending.set(key, request);
	}
	return request;
}

/** A commit already fetched, so it can render on the first frame without a loader. */
export function cachedCommit(projectId: string, sha: string): CommitDetail | null {
	return loaded.get(`${projectId}/${sha}`) ?? null;
}
