import { ChevronRight, CircleSlash, ExternalLink } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { CommitFile } from "../api";
import { type DiffLine, type Hunk, parsePatch, type Span, segments, splitRows } from "./diff";
import { highlightHunk } from "./highlight";

export type DiffMode = "unified" | "split";

const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

// Large diffs start folded so one generated file cannot bury the rest of the commit.
const FOLD_OVER = 400;

const STATUS: Record<CommitFile["status"], { letter: string; label: string }> = {
	added: { letter: "A", label: "Added" },
	removed: { letter: "D", label: "Deleted" },
	modified: { letter: "M", label: "Modified" },
	renamed: { letter: "R", label: "Renamed" },
};

interface Props {
	file: CommitFile;
	mode: DiffMode;
	projectId: string;
	githubUrl: string;
	/** Start expanded or collapsed. By default, large diffs and deletions start collapsed. */
	defaultOpen?: boolean;
}

export const FileDiff = memo(function FileDiff({
	file,
	mode,
	projectId,
	githubUrl,
	defaultOpen,
}: Props) {
	const [open, setOpen] = useState(
		defaultOpen ?? (file.additions + file.deletions <= FOLD_OVER && file.status !== "removed"),
	);
	const hunks = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
	const slash = file.path.lastIndexOf("/") + 1;

	return (
		<section className="diff-file" id={fileAnchor(file.path)}>
			<button
				type="button"
				className="diff-file-head"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<ChevronRight size={14} className="chev" />
				<StatusBadge status={file.status} />
				<span className="path">
					{file.previousPath && (
						<>
							<span className="dir">{file.previousPath}</span>
							<span className="dir"> → </span>
						</>
					)}
					<span className="dir">{file.path.slice(0, slash)}</span>
					{file.path.slice(slash)}
				</span>
				<Counts additions={file.additions} deletions={file.deletions} />
			</button>
			{open && (
				<div className="diff-file-body">
					{file.binary ? (
						IMAGE.test(file.path) && file.sha ? (
							<div className="diff-image">
								<img src={`/api/projects/${projectId}/blob/${file.sha}`} alt={file.path} />
							</div>
						) : (
							<div className="diff-note">Binary file</div>
						)
					) : !file.patch ? (
						<div className="diff-note">
							Too large to show here.
							<a className="btn small" href={githubUrl} target="_blank" rel="noreferrer">
								View on GitHub
								<ExternalLink size={12} />
							</a>
						</div>
					) : (
						<Hunks hunks={hunks} path={file.path} mode={mode} />
					)}
				</div>
			)}
		</section>
	);
});

export function StatusBadge({ status }: { status: CommitFile["status"] }) {
	return (
		<span className={`file-status ${status}`} title={STATUS[status].label}>
			{STATUS[status].letter}
		</span>
	);
}

export function fileAnchor(path: string) {
	return `diff-${path}`;
}

export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
	return (
		<span className="counts mono">
			{additions > 0 && <span className="plus">+{additions}</span>}
			{deletions > 0 && <span className="minus">−{deletions}</span>}
		</span>
	);
}

function Hunks({ hunks, path, mode }: { hunks: Hunk[]; path: string; mode: DiffMode }) {
	const syntax = useMemo(() => {
		const all = new Map<DiffLine, Span[]>();
		for (const h of hunks) for (const [line, spans] of highlightHunk(h, path)) all.set(line, spans);
		return all;
	}, [hunks, path]);

	const last = hunks.at(-1);
	const widest = last ? Math.max(last.oldStart + last.oldLines, last.newStart + last.newLines) : 1;

	return (
		<div
			className={`hunks ${mode}`}
			style={{ "--ln-w": `${String(widest).length + 2}ch` } as React.CSSProperties}
		>
			{hunks.map((hunk) => (
				<div key={`${hunk.oldStart}:${hunk.newStart}`} className="hunk">
					<div className="hunk-head">
						<span>Line {hunk.newStart}</span>
						{hunk.section && <span className="section mono">{hunk.section}</span>}
					</div>
					{mode === "unified"
						? hunk.lines.map((line, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional within a hunk
								<div key={i} className={`dl ${line.kind}`}>
									<span className="ln">{line.old}</span>
									<span className="ln">{line.new}</span>
									<span className="sign">{SIGN[line.kind]}</span>
									<Code line={line} spans={syntax.get(line)} />
								</div>
							))
						: splitRows(hunk.lines).map((row, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional within a hunk
								<div key={i} className="dl">
									<Side
										line={row.left}
										number={row.left?.old}
										spans={row.left ? syntax.get(row.left) : undefined}
									/>
									<Side
										line={row.right}
										number={row.right?.new}
										spans={row.right ? syntax.get(row.right) : undefined}
									/>
								</div>
							))}
				</div>
			))}
		</div>
	);
}

const SIGN: Record<DiffLine["kind"], string> = { context: "", add: "+", del: "−" };

const SNIPPET_LINES = 6;

/** The first few changed lines of a file, for a glance rather than a read. */
export function Snippet({ file }: { file: CommitFile }) {
	const excerpt = useMemo(() => {
		for (const hunk of file.patch ? parsePatch(file.patch) : []) {
			const start = hunk.lines.findIndex((l) => l.kind !== "context");
			if (start < 0) continue;
			const lines = hunk.lines.slice(start, start + SNIPPET_LINES);
			return { lines, syntax: highlightHunk(hunk, file.path) };
		}
		return null;
	}, [file.patch, file.path]);
	if (!excerpt) return null;
	return (
		<div className="hunks snippet">
			{excerpt.lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional within the excerpt
				<div key={i} className={`dl ${line.kind}`}>
					<span className="sign">{SIGN[line.kind]}</span>
					<Code line={line} spans={excerpt.syntax.get(line)} />
				</div>
			))}
		</div>
	);
}

function Side({
	line,
	number,
	spans,
}: {
	line: DiffLine | null;
	number: number | null | undefined;
	spans: Span[] | undefined;
}) {
	if (!line) return <span className="side blank" />;
	return (
		<span className={`side ${line.kind}`}>
			<span className="ln">{number}</span>
			<Code line={line} spans={spans} />
		</span>
	);
}

function Code({ line, spans }: { line: DiffLine; spans: Span[] | undefined }) {
	return (
		<code className="tx">
			{segments(line.text, spans ?? [], line.changes).map((s, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional within a line
					key={i}
					className={[s.cls, s.changed && "chg"].filter(Boolean).join(" ") || undefined}
				>
					{s.text}
				</span>
			))}
			{line.noNewline && (
				<span className="eof" title="No newline at end of file">
					<CircleSlash size={11} />
				</span>
			)}
		</code>
	);
}
