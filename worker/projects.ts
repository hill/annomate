import type { ProjectFormat } from "../shared/formats";
import type { Env } from "./env";
import type { ProjectConfig } from "./room";

export interface ProjectRow {
	id: string;
	owner_id: number;
	repo: string;
	branch: string;
	format: ProjectFormat;
	main_file: string;
	icon: string | null;
	created_at: number;
	thumb_at: number | null;
}

export type MemberProject = ProjectRow & { role: "owner" | "editor" };

// Every column but the thumbnail bytes, which only the thumbnail route reads.
export const PROJECT_COLUMNS =
	"p.id, p.owner_id, p.repo, p.branch, p.format, p.main_file, p.icon, p.created_at, p.thumb_at";

export async function membership(env: Env, projectId: string, login: string) {
	return env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS}, m.role FROM projects p JOIN members m ON m.project_id = p.id
		 WHERE p.id = ? AND m.login = ?`,
	)
		.bind(projectId, login)
		.first<MemberProject>();
}

export async function memberProjects(env: Env, login: string) {
	const { results } = await env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS}, m.role FROM projects p JOIN members m ON m.project_id = p.id
		 WHERE m.login = ? ORDER BY p.created_at DESC`,
	)
		.bind(login)
		.all<MemberProject>();
	return results;
}

export const roomConfig = (project: ProjectRow): ProjectConfig => ({
	id: project.id,
	repo: project.repo,
	branch: project.branch,
	format: project.format,
	mainFile: project.main_file,
});

export const room = (env: Env, projectId: string) => env.ROOM.get(env.ROOM.idFromName(projectId));
