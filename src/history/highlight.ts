import type { Parser } from "@lezer/common";
import { highlightTree } from "@lezer/highlight";
import { parserFor } from "../editor/languages";
import { highlighter } from "../editor/theme";
import type { DiffLine, Hunk, Span } from "./diff";

/** Syntax spans for every line of a hunk, keyed by line. Empty for files we cannot parse. */
export function highlightHunk(hunk: Hunk, path: string): Map<DiffLine, Span[]> {
	const out = new Map<DiffLine, Span[]>();
	const parser = parserFor(path);
	if (!parser) return out;
	// Each side of a hunk is a contiguous stretch of its file, so parse the sides whole. Lines
	// parsed one at a time would lose anything that spans lines, such as a block comment.
	const before = hunk.lines.filter((l) => l.kind !== "add");
	const after = hunk.lines.filter((l) => l.kind !== "del");
	highlightLines(
		parser,
		before.map((l) => l.text),
	).forEach((spans, i) => {
		if (before[i].kind === "del") out.set(before[i], spans);
	});
	// Context lines sit on both sides. They take their spans from the new one.
	highlightLines(
		parser,
		after.map((l) => l.text),
	).forEach((spans, i) => {
		out.set(after[i], spans);
	});
	return out;
}

function highlightLines(parser: Parser, lines: string[]): Span[][] {
	const text = lines.join("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	const out: Span[][] = lines.map(() => []);
	highlightTree(parser.parse(text), highlighter, (from, to, cls) => {
		for (let i = lineAt(starts, from); i < lines.length && starts[i] < to; i++) {
			const start = starts[i];
			const end = start + lines[i].length;
			if (Math.min(to, end) > Math.max(from, start)) {
				out[i].push({ from: Math.max(from, start) - start, to: Math.min(to, end) - start, cls });
			}
		}
	});
	return out;
}

function lineAt(starts: number[], pos: number) {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= pos) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}
