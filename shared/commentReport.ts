import type * as Y from "yjs";
import { type AnchorStatus, findQuote, isPoint, lineAt, resolveAnchor } from "./anchor";
import type { Thread } from "./protocol";

/**
 * Comments packaged for a coding agent. The agent edits a git checkout, not annomate's live
 * text, so every thread carries enough to find its passage either way: the quoted text, the
 * lines around it, its line in annomate now and its line in the last synced commit.
 */
export interface Report {
	repo: string;
	branch: string;
	/** The commit annomate last pulled or pushed. */
	commit: string;
	generatedAt: number;
	/** Files whose text in annomate differs from that commit. */
	uncommitted: string[];
	counts: { open: number; resolved: number };
	threads: ReportThread[];
}

export interface LineRange {
	first: number;
	last: number;
}

export interface ReportThread {
	id: string;
	file: string;
	resolved: boolean;
	resolvedBy: string | null;
	status: AnchorStatus;
	/** A comment on a position between characters rather than on a passage. */
	point: boolean;
	/** First and last line in annomate's current text. Null once the passage is gone. */
	lines: LineRange | null;
	/** First and last line in the file as of `Report.commit`. Null when not found there. */
	committedLines: LineRange | null;
	/** The text as it was when the comment was made. */
	quote: string;
	/** The text there now. */
	current: string;
	/** Lines around the passage in annomate's current text. */
	excerpt: { start: number; lines: string[] } | null;
	createdAt: number;
	comments: ReportComment[];
}

export interface ReportComment {
	id: string;
	name: string;
	login: string;
	at: number;
	body: string;
	edited: boolean;
	via: string | null;
}

export interface ReportOptions {
	status?: "open" | "resolved" | "all";
	file?: string;
	thread?: string;
	/** Lines of context either side of each passage. */
	context?: number;
}

export interface ReportSource {
	repo: string;
	branch: string;
	commit: string;
}

const MAX_CONTEXT = 40;

export function buildReport(
	doc: Y.Doc,
	threads: Thread[],
	source: ReportSource,
	options: ReportOptions = {},
): Report {
	const files = doc.getMap<Y.Text>("files");
	const base = doc.getMap<string>("base");
	const { status = "open", file, thread, context = 3 } = options;
	const around = Math.max(0, Math.min(MAX_CONTEXT, context));

	const uncommitted = [
		...[...files.entries()].filter(([path, text]) => base.get(path) !== text.toString()),
		...[...base.keys()].filter((path) => !files.has(path)).map((path) => [path] as const),
	]
		.map(([path]) => path)
		.sort();

	const picked = threads.filter(
		(t) =>
			(status === "all" || t.resolved === (status === "resolved")) &&
			(!file || t.anchor.file === file) &&
			(!thread || t.id === thread),
	);

	const out = picked.map((t): ReportThread => {
		const text = files.get(t.anchor.file);
		const source = text?.toString() ?? "";
		const r = resolveAnchor(doc, text, t.anchor);
		const found = r.status !== "detached";
		const lines = found ? span(source, r.from, r.to) : null;
		const committed = base.get(t.anchor.file);
		return {
			id: t.id,
			file: t.anchor.file,
			resolved: t.resolved,
			resolvedBy: t.resolvedBy?.name ?? null,
			status: r.status,
			point: isPoint(t.anchor),
			lines,
			committedLines:
				committed === undefined ? null : committed === source ? lines : committedSpan(committed, t),
			quote: t.anchor.quote,
			current: found ? r.current : "",
			excerpt: lines ? excerpt(source, lines, around) : null,
			createdAt: t.createdAt,
			comments: t.comments.map((c) => ({
				id: c.id,
				name: c.author.name,
				login: c.author.login,
				at: c.createdAt,
				body: c.body,
				edited: c.editedAt !== undefined,
				via: c.via ?? null,
			})),
		};
	});

	out.sort(
		(a, b) =>
			a.file.localeCompare(b.file) ||
			(a.lines?.first ?? Number.MAX_SAFE_INTEGER) - (b.lines?.first ?? Number.MAX_SAFE_INTEGER) ||
			a.createdAt - b.createdAt,
	);

	return {
		...source,
		generatedAt: Date.now(),
		uncommitted,
		counts: {
			open: threads.filter((t) => !t.resolved).length,
			resolved: threads.filter((t) => t.resolved).length,
		},
		threads: out,
	};
}

function span(source: string, from: number, to: number): LineRange {
	return { first: lineAt(source, from), last: lineAt(source, Math.max(from, to - 1)) };
}

function committedSpan(committed: string, t: Thread): LineRange | null {
	if (isPoint(t.anchor)) {
		const at = committed.indexOf(t.anchor.prefix + t.anchor.suffix);
		if (at === -1) return null;
		const line = lineAt(committed, at + t.anchor.prefix.length);
		return { first: line, last: line };
	}
	const found = findQuote(committed, t.anchor);
	return found ? span(committed, found.from, found.to) : null;
}

function excerpt(source: string, { first, last }: LineRange, around: number) {
	const all = source.split("\n");
	const start = Math.max(1, first - around);
	const end = Math.min(all.length, last + around);
	return { start, lines: all.slice(start - 1, end) };
}

const LANGUAGE: Record<string, string> = {
	typ: "typst",
	bib: "bibtex",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	csv: "csv",
	json: "json",
	md: "markdown",
	tex: "latex",
	xml: "xml",
	svg: "xml",
	csl: "xml",
};

const STATUS_NOTE: Record<AnchorStatus, string> = {
	ok: "",
	edited: "The text has been edited since this comment was made.",
	moved: "The commented text moved and was found again by searching for it.",
	detached:
		"The commented text is no longer in the file. The original text is shown, and the thread has no current location.",
};

/** The report as Markdown, written to be read by an agent rather than a person. */
export function reportMarkdown(report: Report, options: ReportOptions = {}): string {
	const { status = "open" } = options;
	const short = report.commit.slice(0, 7);
	const out: string[] = [];
	const scope = status === "all" ? "" : `${status} `;

	out.push(`# Comments on ${report.repo}`, "");
	out.push(
		`- ${report.threads.length} ${scope}thread${report.threads.length === 1 ? "" : "s"} shown. The project has ${report.counts.open} open and ${report.counts.resolved} resolved.`,
	);
	out.push(`- Branch \`${report.branch}\`, synced with commit \`${short}\`.`);
	if (report.uncommitted.length) {
		out.push(
			`- annomate has uncommitted edits to ${report.uncommitted.map((f) => `\`${f}\``).join(", ")}. Line numbers are for annomate's current text. Where a file differs from \`${short}\`, the line in \`${short}\` is given too.`,
		);
	} else {
		out.push(
			`- annomate's text matches \`${short}\`, so line numbers match a checkout of that commit.`,
		);
	}
	out.push(
		"- Lines can drift if your checkout differs. Search for the quoted text to find a passage.",
	);

	for (const t of report.threads) out.push("", ...threadMarkdown(t, short));
	if (!report.threads.length) out.push("", `No ${scope}comments.`);
	return `${out.join("\n")}\n`;
}

function threadMarkdown(t: ReportThread, commit: string): string[] {
	const out: string[] = [];
	const where = t.lines ? `${t.file}:${range(t.lines)}` : `${t.file} (no current location)`;
	out.push(`## ${where} · ${t.resolved ? "resolved" : "open"}`, "");

	const facts = [`Thread \`${t.id}\`.`];
	if (t.committedLines && (!t.lines || range(t.committedLines) !== range(t.lines))) {
		facts.push(`Line ${range(t.committedLines)} in \`${commit}\`.`);
	} else if (!t.committedLines && t.lines) {
		facts.push(`Not in \`${commit}\`, so only in annomate.`);
	}
	if (STATUS_NOTE[t.status]) facts.push(STATUS_NOTE[t.status]);
	out.push(facts.join(" "), "");

	if (t.point) {
		out.push(`A comment on a point in line ${t.lines?.first ?? "?"}, not on a passage.`, "");
	} else if (t.status === "edited" && t.current !== t.quote) {
		out.push(
			"Originally commented text:",
			"",
			...quoteBlock(t.quote),
			"",
			"Text there now:",
			"",
			...quoteBlock(t.current),
			"",
		);
	} else {
		out.push("Commented text:", "", ...quoteBlock(t.quote), "");
	}

	if (t.excerpt && t.lines) {
		const { first, last } = t.lines;
		const width = String(t.excerpt.start + t.excerpt.lines.length - 1).length;
		const rows = t.excerpt.lines.map((line, i) => {
			const n = t.excerpt ? t.excerpt.start + i : 0;
			const mark = n >= first && n <= last ? ">" : " ";
			return `${mark} ${String(n).padStart(width)} | ${line}`;
		});
		const fence = fenceFor(rows.join("\n"));
		const lang = LANGUAGE[t.file.split(".").pop()?.toLowerCase() ?? ""] ?? "text";
		out.push(
			`Context, with the commented lines marked \`>\`:`,
			"",
			`${fence}${lang}`,
			...rows,
			fence,
			"",
		);
	}

	for (const c of t.comments) {
		const who = `**${c.name}** (@${c.login})${c.via ? ` via ${c.via}` : ""}`;
		out.push(
			`${who}, ${timestamp(c.at)}${c.edited ? ", edited" : ""}:`,
			"",
			...quoteBlock(c.body),
			"",
		);
	}
	if (t.resolved) out.push(`Resolved${t.resolvedBy ? ` by ${t.resolvedBy}` : ""}.`, "");
	while (out.at(-1) === "") out.pop();
	return out;
}

const range = ({ first, last }: LineRange) => (first === last ? `${first}` : `${first}-${last}`);

function quoteBlock(text: string): string[] {
	return (text || "(empty)").split("\n").map((line) => (line ? `> ${line}` : ">"));
}

/** A code fence longer than any run of backticks inside it, so the content cannot close it. */
function fenceFor(content: string): string {
	const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(3, longest + 1));
}

/** UTC and locale-free, so the browser and the server write the same text. */
function timestamp(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
