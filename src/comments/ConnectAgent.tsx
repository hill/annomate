import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { type AgentConnection, ago, api } from "../api";
import { Drawer } from "../ui/Drawer";

const CLIENT_KEY = "annomate:agent-client";

interface Setup {
	id: string;
	label: string;
	/** Where the snippet goes, when it is not a shell command. */
	place?: string;
	snippet: (url: string) => string;
}

const SETUPS: Setup[] = [
	{
		id: "claude",
		label: "Claude Code",
		snippet: (url) => `claude mcp add --transport http annomate ${url}`,
	},
	{ id: "codex", label: "Codex", snippet: (url) => `codex mcp add annomate --url ${url}` },
	{
		id: "cursor",
		label: "Cursor",
		place: "~/.cursor/mcp.json",
		snippet: (url) => JSON.stringify({ mcpServers: { annomate: { url } } }, null, 2),
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		snippet: (url) => `gemini mcp add --transport http annomate ${url}`,
	},
	{ id: "other", label: "Other", place: "MCP server URL", snippet: (url) => url },
];

const PROMPT = "Work through the open annomate comments on this repo.";

export function ConnectAgent({ onClose }: { onClose(): void }) {
	const [client, setClient] = useState(() => {
		try {
			return localStorage.getItem(CLIENT_KEY) ?? "claude";
		} catch {
			return "claude";
		}
	});
	const [connections, setConnections] = useState<AgentConnection[] | null>(null);
	const setup = SETUPS.find((s) => s.id === client) ?? SETUPS[0];
	const url = `${location.origin}/mcp`;

	const load = useCallback(() => {
		api.agents().then(setConnections, () => setConnections([]));
	}, []);
	useEffect(load, [load]);
	// Pick up an agent connected in another window while this one is open.
	useEffect(() => {
		addEventListener("focus", load);
		return () => removeEventListener("focus", load);
	}, [load]);

	const choose = (id: string) => {
		setClient(id);
		try {
			localStorage.setItem(CLIENT_KEY, id);
		} catch {}
	};

	return createPortal(
		<Drawer title="Connect an agent" width={520} onClose={onClose}>
			<div className="connect">
				<div className="seg connect-tabs" role="tablist" aria-label="Agent">
					{SETUPS.map((s) => (
						<button
							key={s.id}
							type="button"
							role="tab"
							aria-selected={s.id === setup.id}
							onClick={() => choose(s.id)}
						>
							{s.label}
						</button>
					))}
				</div>
				<CopyBlock label={setup.place} text={setup.snippet(url)} />
				<p className="muted small">Your agent opens a browser window to approve access.</p>

				<h3>Then ask it</h3>
				<CopyBlock text={PROMPT} prose />

				{connections && connections.length > 0 && (
					<>
						<h3>Connected</h3>
						<ul className="connections">
							{connections.map((c) => (
								<li key={c.id}>
									<span className="grow">
										<span className="name">{c.client}</span>
										<span className="muted">
											{c.scope.includes("comments:write") ? "Read and reply" : "Read only"} ·{" "}
											{ago(c.createdAt)}
										</span>
									</span>
									<button
										type="button"
										className="btn small"
										onClick={() => api.disconnectAgent(c.id).then(load)}
									>
										Disconnect
									</button>
								</li>
							))}
						</ul>
					</>
				)}
			</div>
		</Drawer>,
		document.body,
	);
}

function CopyBlock({ text, label, prose }: { text: string; label?: string; prose?: boolean }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), 1400);
		return () => clearTimeout(t);
	}, [copied]);
	return (
		<div className={`copy-block${prose ? " prose" : ""}`}>
			{label && <div className="copy-label mono">{label}</div>}
			<pre>{text}</pre>
			<button
				type="button"
				className={`btn ghost icon small${copied ? " copied" : ""}`}
				aria-label="Copy"
				title="Copy"
				onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}
			>
				{copied ? <Check size={14} key="check" /> : <Copy size={14} key="copy" />}
			</button>
		</div>
	);
}
