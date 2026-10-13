import DiffMatchPatch from "diff-match-patch";
import { inlineDiff } from "../../shared/anchor";

export type Range = [from: number, to: number];

export interface DiffLine {
	kind: "context" | "add" | "del";
	old: number | null;
	new: number | null;
	text: string;
	/** Changed words, set when the line pairs with a similar line on the other side. */
	changes: Range[] | null;
	noNewline: boolean;
}

export interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** The enclosing heading or function git names in the hunk header. */
	section: string;
	lines: DiffLine[];
}

export interface SplitRow {
	left: DiffLine | null;
	right: DiffLine | null;
}

export interface Span {
	from: number;
	to: number;
	cls: string;
}

export interface Segment {
	text: string;
	cls: string | null;
	changed: boolean;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

// Below this share of unchanged text, word highlights would cover most of the line and say less
// than the line tint already does.
const MIN_SIMILARITY = 0.4;

/** Parse the hunks of a unified diff, as GitHub returns per file. */
export function parsePatch(patch: string): Hunk[] {
	const hunks: Hunk[] = [];
	let hunk: Hunk | null = null;
	let oldNo = 0;
	let newNo = 0;
	for (const raw of patch.split("\n")) {
		const header = HEADER.exec(raw);
		if (header) {
			hunk = {
				oldStart: Number(header[1]),
				oldLines: header[2] === undefined ? 1 : Number(header[2]),
				newStart: Number(header[3]),
				newLines: header[4] === undefined ? 1 : Number(header[4]),
				section: header[5].trim(),
				lines: [],
			};
			hunks.push(hunk);
			oldNo = hunk.oldStart;
			newNo = hunk.newStart;
			continue;
		}
		if (!hunk) continue;
		const text = raw.slice(1);
		const line = (kind: DiffLine["kind"], old: number | null, now: number | null) =>
			hunk?.lines.push({ kind, old, new: now, text, changes: null, noNewline: false });
		switch (raw[0]) {
			case " ":
				line("context", oldNo++, newNo++);
				break;
			case "-":
				line("del", oldNo++, null);
				break;
			case "+":
				line("add", null, newNo++);
				break;
			case "\\": {
				const last = hunk.lines.at(-1);
				if (last) last.noNewline = true;
				break;
			}
		}
	}
	for (const h of hunks) markChanges(h.lines);
	return hunks;
}

/** Pair each run of removed lines with the added lines after it, and mark the words that differ. */
function markChanges(lines: DiffLine[]) {
	let i = 0;
	while (i < lines.length) {
		if (lines[i].kind !== "del") {
			i++;
			continue;
		}
		const dels: DiffLine[] = [];
		while (lines[i]?.kind === "del") dels.push(lines[i++]);
		const adds: DiffLine[] = [];
		while (lines[i]?.kind === "add") adds.push(lines[i++]);
		for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
			const pair = wordChanges(dels[k].text, adds[k].text);
			if (!pair) continue;
			dels[k].changes = pair.before;
			adds[k].changes = pair.after;
		}
	}
}

export function wordChanges(
	before: string,
	after: string,
): { before: Range[]; after: Range[] } | null {
	let a = 0;
	let b = 0;
	let same = 0;
	const out = { before: [] as Range[], after: [] as Range[] };
	for (const [op, chunk] of inlineDiff(before, after)) {
		if (op === DiffMatchPatch.DIFF_EQUAL) {
			a += chunk.length;
			b += chunk.length;
			same += chunk.length;
		} else if (op === DiffMatchPatch.DIFF_DELETE) {
			push(out.before, a, a + chunk.length);
			a += chunk.length;
		} else {
			push(out.after, b, b + chunk.length);
			b += chunk.length;
		}
	}
	const longest = Math.max(before.length, after.length);
	return longest > 0 && same / longest >= MIN_SIMILARITY ? out : null;
}

function push(ranges: Range[], from: number, to: number) {
	const last = ranges.at(-1);
	if (last && last[1] === from) last[1] = to;
	else ranges.push([from, to]);
}

/** Side-by-side rows. Removed and added lines in the same run share rows, top-aligned. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let dels: DiffLine[] = [];
	let adds: DiffLine[] = [];
	const flush = () => {
		for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
			rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
		}
		dels = [];
		adds = [];
	};
	for (const line of lines) {
		if (line.kind === "del") {
			if (adds.length) flush();
			dels.push(line);
		} else if (line.kind === "add") {
			adds.push(line);
		} else {
			flush();
			rows.push({ left: line, right: line });
		}
	}
	flush();
	return rows;
}

/** Cut a line into runs that share one syntax class and one changed state. */
export function segments(
	text: string,
	spans: readonly Span[],
	changes: readonly Range[] | null,
): Segment[] {
	const cuts = new Set([0, text.length]);
	for (const s of spans) cuts.add(s.from).add(s.to);
	for (const [from, to] of changes ?? []) cuts.add(from).add(to);
	const points = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((x, y) => x - y);

	const out: Segment[] = [];
	for (let k = 0; k < points.length - 1; k++) {
		const [from, to] = [points[k], points[k + 1]];
		const cls = spans.find((s) => s.from <= from && s.to >= to)?.cls ?? null;
		const changed = changes?.some(([a, b]) => a <= from && b >= to) ?? false;
		const last = out.at(-1);
		if (last && last.cls === cls && last.changed === changed) last.text += text.slice(from, to);
		else out.push({ text: text.slice(from, to), cls, changed });
	}
	return out;
}
