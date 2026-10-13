import type { APIRequestContext } from "@playwright/test";

/** Delete this test user's projects for a repo, so a failed earlier run cannot leak state in. */
export async function clearProjects(request: APIRequestContext, repo: string) {
	const projects: { id: string; repo: string; role: string }[] = await (
		await request.get("/api/projects")
	).json();
	for (const p of projects) {
		if (p.repo.toLowerCase() === repo.toLowerCase() && p.role === "owner")
			await request.delete(`/api/projects/${p.id}`);
	}
}
