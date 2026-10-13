import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type ReportOptions, reportMarkdown } from "../../shared/commentReport";
import { parseProject } from "../../shared/projectName";
import type { User } from "../../shared/protocol";
import type { Env } from "../env";
import { type MemberProject, memberProjects, room, roomConfig } from "../projects";
import { type AgentProps, WRITE } from "./oauth";

const INSTRUCTIONS = `annomate is where people review Typst documents kept in GitHub repos. They leave comments on passages, and this server lets you read and answer them.

To work through a project's comments:
1. Find the project from the repo you are in: pass its GitHub owner/name (from \`git remote get-url origin\`) as \`project\`, or call list_projects.
2. Call get_comments. Each thread gives the file, line, the commented text, the lines around it and the conversation.
3. Make the changes in your checkout. annomate's live text can be ahead of your checkout, so when a line number does not match, search for the quoted text.
4. Answer each thread you handled with reply_to_thread, or resolve_thread with a short note of what changed.

annomate does not see your local edits. Push your commits to the project's branch, then someone pulls them in annomate.`;

const project = z
	.string()
	.describe(
		"The project: its GitHub repo as owner/name, or its annomate project id. Add @branch when the repo has projects on several branches, e.g. owner/name@draft.",
	);
const threadId = z.string().describe("The thread id, as get_comments shows it.");
const context = z
	.number()
	.int()
	.min(0)
	.max(40)
	.optional()
	.describe("Lines of text to show either side of each commented passage.");

interface Agent {
	env: Env;
	user: User;
	client: string;
	scopes: string[];
	origin: string;
}

export async function serveMcp(
	request: Request,
	env: Env,
	ctx: OAuthResourceContext<AgentProps>,
): Promise<Response> {
	const user = await env.DB.prepare("SELECT id, login, name, avatar FROM users WHERE id = ?")
		.bind(ctx.props.userId)
		.first<User>();
	if (!user) return new Response("Unknown user", { status: 401 });
	const agent: Agent = {
		env,
		user,
		client: ctx.props.client,
		scopes: ctx.auth.scope,
		origin: new URL(request.url).origin,
	};
	return createMcpHandler(() => server(agent)).fetch(request);
}

function server(agent: Agent): McpServer {
	const mcp = new McpServer({ name: "annomate", version: "1.0.0" }, { instructions: INSTRUCTIONS });

	mcp.registerTool(
		"list_projects",
		{
			title: "List projects",
			description:
				"The annomate projects you can see, with the GitHub repo and branch each one tracks.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () => {
			const projects = await memberProjects(agent.env, agent.user.login);
			if (!projects.length) return text("You have no annomate projects.");
			return text(
				projects
					.map(
						(p) =>
							`- ${p.repo} on branch \`${p.branch}\`, project id \`${p.id}\`, you are ${p.role === "owner" ? "the owner" : "an editor"}. ${agent.origin}/p/${p.id}`,
					)
					.join("\n"),
			);
		},
	);

	mcp.registerTool(
		"get_comments",
		{
			title: "Get comments",
			description:
				"Comment threads on a project, as Markdown. Each thread has its file and line, the commented text, the surrounding lines with the commented ones marked, and every reply.",
			inputSchema: z.object({
				project,
				status: z
					.enum(["open", "resolved", "all"])
					.optional()
					.describe("Which threads to include. Defaults to open."),
				file: z.string().optional().describe("Only threads on this file path."),
				context_lines: context,
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ project, status, file, context_lines }) =>
			withProject(agent, project, (p) =>
				report(agent, p, { status: status ?? "open", file, context: context_lines ?? 3 }),
			),
	);

	mcp.registerTool(
		"get_thread",
		{
			title: "Get thread",
			description: "One comment thread, open or resolved, with more of the surrounding text.",
			inputSchema: z.object({ project, thread_id: threadId, context_lines: context }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ project, thread_id, context_lines }) =>
			withProject(agent, project, async (p) => {
				const options = { status: "all", thread: thread_id, context: context_lines ?? 12 } as const;
				const r = await room(agent.env, p.id).report(agent.user, roomConfig(p), options);
				if (!r.threads.length) return failure(`No thread \`${thread_id}\` in ${p.repo}.`);
				return text(reportMarkdown(r, options));
			}),
	);

	mcp.registerTool(
		"reply_to_thread",
		{
			title: "Reply to thread",
			description: `Add a reply to a comment thread. It appears under your name, marked as written through ${agent.client}. Use it to say what you changed or to ask a question back.`,
			inputSchema: z.object({
				project,
				thread_id: threadId,
				body: z.string().min(1).describe("The reply, in plain text."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async ({ project, thread_id, body }) =>
			writable(agent) ??
			withProject(agent, project, async (p) => {
				const thread = await room(agent.env, p.id).agentReply(
					agent.user,
					roomConfig(p),
					thread_id,
					body,
					agent.client,
				);
				if (!thread) return failure(`No thread \`${thread_id}\` in ${p.repo}.`);
				return text(`Replied to thread \`${thread_id}\`.`);
			}),
	);

	mcp.registerTool(
		"resolve_thread",
		{
			title: "Resolve thread",
			description:
				"Mark a comment thread resolved, optionally replying first with what changed. Pass resolved: false to reopen it.",
			inputSchema: z.object({
				project,
				thread_id: threadId,
				reply: z.string().optional().describe("A note to post before resolving."),
				resolved: z.boolean().optional().describe("Defaults to true."),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async ({ project, thread_id, reply, resolved }) =>
			writable(agent) ??
			withProject(agent, project, async (p) => {
				const stub = room(agent.env, p.id);
				const config = roomConfig(p);
				if (reply?.trim()) {
					const replied = await stub.agentReply(agent.user, config, thread_id, reply, agent.client);
					if (!replied) return failure(`No thread \`${thread_id}\` in ${p.repo}.`);
				}
				const state = resolved ?? true;
				const thread = await stub.agentResolve(agent.user, config, thread_id, state);
				if (!thread) return failure(`No thread \`${thread_id}\` in ${p.repo}.`);
				return text(`${state ? "Resolved" : "Reopened"} thread \`${thread_id}\`.`);
			}),
	);

	return mcp;
}

async function report(agent: Agent, p: MemberProject, options: ReportOptions) {
	const r = await room(agent.env, p.id).report(agent.user, roomConfig(p), options);
	return text(reportMarkdown(r, options));
}

/** Find the project a tool call names, or explain which ones exist. */
async function withProject(
	agent: Agent,
	name: string,
	run: (p: MemberProject) => Promise<CallToolResult>,
): Promise<CallToolResult> {
	const projects = await memberProjects(agent.env, agent.user.login);
	const { slug, branch } = parseProject(name);
	const byId = projects.find((p) => p.id === name.trim());
	const matches = byId
		? [byId]
		: projects.filter((p) => p.repo.toLowerCase() === slug && (!branch || p.branch === branch));
	if (matches.length === 1) {
		try {
			return await run(matches[0]);
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}
	}
	const known = projects.map((p) => `- ${p.repo}@${p.branch} (id \`${p.id}\`)`).join("\n");
	if (matches.length > 1) {
		return failure(
			`${slug} has projects on several branches. Name one as ${slug}@branch:\n${matches.map((p) => `- ${p.repo}@${p.branch}`).join("\n")}`,
		);
	}
	return failure(
		projects.length
			? `No project matches "${name}". Your projects:\n${known}`
			: "You have no annomate projects.",
	);
}

function writable(agent: Agent): CallToolResult | undefined {
	if (agent.scopes.includes(WRITE)) return undefined;
	return failure(
		"This connection can read comments but not reply or resolve. Reconnect annomate and allow replying to change that.",
	);
}

const text = (body: string): CallToolResult => ({ content: [{ type: "text", text: body }] });

const failure = (body: string): CallToolResult => ({
	content: [{ type: "text", text: body }],
	isError: true,
});
