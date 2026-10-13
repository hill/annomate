import { Check, Copy, Download, Plug, Share } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { buildReport, type ReportOptions, reportMarkdown } from "../../shared/commentReport";
import type { GitState, Thread } from "../../shared/protocol";
import { useEscape } from "../ui/escape";

interface Props {
	doc: Y.Doc;
	threads: Thread[];
	git: GitState;
	onConnect(): void;
}

type Action = "open" | "all" | "download";

export function ExportMenu({ doc, threads, git, onConnect }: Props) {
	const [open, setOpen] = useState(false);
	const [done, setDone] = useState<Action | null>(null);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
		addEventListener("pointerdown", onDown);
		return () => removeEventListener("pointerdown", onDown);
	}, [open]);
	useEscape(() => setOpen(false), open);

	// Leave the confirmation up long enough to read, then get out of the way.
	useEffect(() => {
		if (!done) return;
		const t = setTimeout(() => {
			setOpen(false);
			setDone(null);
		}, 700);
		return () => clearTimeout(t);
	}, [done]);

	const markdown = (status: ReportOptions["status"]) =>
		reportMarkdown(
			buildReport(
				doc,
				threads,
				{ repo: git.repo, branch: git.branch, commit: git.baseSha },
				{ status },
			),
			{ status },
		);

	const run = async (action: Action) => {
		if (action === "download") {
			const url = URL.createObjectURL(new Blob([markdown("all")], { type: "text/markdown" }));
			const a = document.createElement("a");
			a.href = url;
			a.download = `${git.repo.split("/")[1]}-comments.md`;
			a.click();
			URL.revokeObjectURL(url);
		} else {
			await navigator.clipboard.writeText(markdown(action));
		}
		setDone(action);
	};

	const item = (action: Action, label: string, Icon: typeof Copy) => (
		<button type="button" role="menuitem" className="nav" onClick={() => run(action)}>
			{done === action ? <Check size={14} className="done" /> : <Icon size={14} />}
			<span className="grow">
				{done === action ? (action === "download" ? "Downloaded" : "Copied") : label}
			</span>
		</button>
	);

	return (
		<div ref={ref} className="export-menu">
			<button
				type="button"
				className="btn ghost icon small"
				aria-label="Export comments"
				title="Export comments"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<Share size={14} />
			</button>
			{open && (
				<div className="menu" role="menu">
					{item("open", "Copy open comments", Copy)}
					{item("all", "Copy all comments", Copy)}
					{item("download", "Download as Markdown", Download)}
					<hr />
					<button
						type="button"
						role="menuitem"
						className="nav"
						onClick={() => {
							setOpen(false);
							onConnect();
						}}
					>
						<Plug size={14} />
						<span className="grow">Connect an agent</span>
					</button>
				</div>
			)}
		</div>
	);
}
