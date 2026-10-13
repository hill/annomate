import { Check, Copy, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ago, type HistoryCommit } from "../api";
import { useEscape } from "../ui/escape";
import { cachedCommit, loadCommit } from "./commits";
import { Counts, type DiffMode, FileDiff, fileAnchor, StatusBadge } from "./FileDiff";

const MODE_KEY = "annomate:diff-mode";

interface Props {
	projectId: string;
	repo: string;
	commit: HistoryCommit;
	/** Width of the history drawer, which the panel sits beside. */
	besideWidth: number;
	onClose(): void;
}

export function CommitDiff({ projectId, repo, commit, besideWidth, onClose }: Props) {
	const [detail, setDetail] = useState(() => cachedCommit(projectId, commit.sha));
	const [error, setError] = useState("");
	const [mode, setMode] = useDiffMode();
	const scroller = useRef<HTMLDivElement>(null);
	const [subject, ...rest] = commit.message.split("\n");
	const body = rest.join("\n").trim();
	const githubUrl = `https://github.com/${repo}/commit/${commit.sha}`;

	useEffect(() => {
		let live = true;
		setDetail(cachedCommit(projectId, commit.sha));
		setError("");
		scroller.current?.scrollTo({ top: 0 });
		loadCommit(projectId, commit.sha).then(
			(d) => live && setDetail(d),
			(e) => live && setError(e instanceof Error ? e.message : String(e)),
		);
		return () => {
			live = false;
		};
	}, [projectId, commit.sha]);

	// Opens after the history drawer, so Escape closes this first.
	useEscape(onClose);

	const additions = detail?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
	const deletions = detail?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;

	return createPortal(
		<section
			className="diff-panel"
			aria-label="Commit changes"
			style={{ "--beside-w": `${besideWidth}px` } as React.CSSProperties}
		>
			<header className="diff-head">
				<div className="diff-title">
					<h2>{subject}</h2>
					<button type="button" className="btn ghost icon" aria-label="Close" onClick={onClose}>
						<X size={16} />
					</button>
				</div>
				{body && <p className="diff-message">{body}</p>}
				<div className="diff-meta">
					{commit.author.avatar && <img className="avatar" src={commit.author.avatar} alt="" />}
					<span className="who">{commit.author.login ?? commit.author.name}</span>
					<time dateTime={commit.date} title={new Date(commit.date).toLocaleString()}>
						{ago(Date.parse(commit.date))}
					</time>
					<ShaChip sha={commit.sha} />
					<a
						className="btn ghost icon small"
						href={githubUrl}
						target="_blank"
						rel="noreferrer"
						aria-label="View on GitHub"
						title="View on GitHub"
					>
						<ExternalLink size={13} />
					</a>
					<span className="spacer" />
					{detail && (
						<span className="diff-total">
							{detail.files.length} file{detail.files.length === 1 ? "" : "s"}
							<Counts additions={additions} deletions={deletions} />
						</span>
					)}
					<div className="seg" role="tablist" aria-label="Layout">
						{(["unified", "split"] as const).map((m) => (
							<button
								key={m}
								type="button"
								role="tab"
								aria-selected={mode === m}
								onClick={() => setMode(m)}
							>
								{m === "unified" ? "Unified" : "Split"}
							</button>
						))}
					</div>
				</div>
			</header>
			<div className="diff-scroll" ref={scroller}>
				{error ? (
					<div className="empty">{error}</div>
				) : !detail ? (
					<div className="empty">
						<div className="loader" />
					</div>
				) : detail.files.length === 0 ? (
					<div className="empty">No file changes</div>
				) : (
					<>
						{detail.files.length > 1 && (
							<nav className="diff-index">
								{detail.files.map((f) => (
									<button
										key={f.path}
										type="button"
										className="nav"
										onClick={() =>
											document
												.getElementById(fileAnchor(f.path))
												?.scrollIntoView({ behavior: "smooth", block: "start" })
										}
									>
										<StatusBadge status={f.status} />
										<span className="grow mono">{f.path}</span>
										<Counts additions={f.additions} deletions={f.deletions} />
									</button>
								))}
							</nav>
						)}
						{detail.files.map((f) => (
							<FileDiff
								key={f.path}
								file={f}
								mode={mode}
								projectId={projectId}
								githubUrl={githubUrl}
							/>
						))}
					</>
				)}
			</div>
		</section>,
		document.body,
	);
}

function ShaChip({ sha }: { sha: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), 1400);
		return () => clearTimeout(t);
	}, [copied]);
	return (
		<button
			type="button"
			className={`sha mono${copied ? " copied" : ""}`}
			title="Copy full SHA"
			onClick={() => navigator.clipboard.writeText(sha).then(() => setCopied(true))}
		>
			{sha.slice(0, 7)}
			{copied ? <Check size={11} key="check" /> : <Copy size={11} key="copy" />}
		</button>
	);
}

export function useDiffMode() {
	const [mode, setMode] = useState<DiffMode>(() => {
		try {
			return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified";
		} catch {
			return "unified";
		}
	});
	const set = (next: DiffMode) => {
		setMode(next);
		try {
			localStorage.setItem(MODE_KEY, next);
		} catch {}
	};
	return [mode, set] as const;
}
