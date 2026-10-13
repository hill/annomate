import { lineAt } from "./anchor";

export type Located = { from: number; to: number } | { error: string };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every match of `quote`, exact first. Failing that, allow any run of whitespace to differ. */
function matches(source: string, quote: string): { from: number; to: number }[] {
	const exact: { from: number; to: number }[] = [];
	for (let i = source.indexOf(quote); i !== -1; i = source.indexOf(quote, i + 1)) {
		exact.push({ from: i, to: i + quote.length });
	}
	if (exact.length) return exact;
	// An agent's checkout can wrap a sentence differently from the live text.
	const words = quote.trim().split(/\s+/).map(escapeRegExp);
	if (!words[0]) return [];
	const pattern = new RegExp(words.join("\\s+"), "g");
	return [...source.matchAll(pattern)].map((m) => ({ from: m.index, to: m.index + m[0].length }));
}

function lineRange(source: string, line: number): { from: number; to: number } | null {
	const lines = source.split("\n");
	if (line < 1 || line > lines.length) return null;
	const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
	const text = lines[line - 1];
	const lead = text.length - text.trimStart().length;
	const trimmed = text.trim();
	return { from: start + lead, to: start + lead + trimmed.length };
}

/**
 * Find the passage a coding agent wants to comment on. The quote is the
 * passage itself, which survives the agent's checkout being out of date. The
 * line picks between repeated quotes, or names a whole line on its own.
 */
export function locatePassage(source: string, opts: { quote?: string; line?: number }): Located {
	const quote = opts.quote?.trim() ? opts.quote : undefined;
	if (!quote) {
		if (opts.line === undefined)
			return { error: "Give the text to comment on as quote, or a line number." };
		const range = lineRange(source, opts.line);
		if (!range)
			return {
				error: `The file has ${source.split("\n").length} lines, so there is no line ${opts.line}.`,
			};
		if (range.to === range.from)
			return { error: `Line ${opts.line} is blank. Quote the text to comment on instead.` };
		return range;
	}

	const found = matches(source, quote);
	if (!found.length) {
		return {
			error:
				"That quote is not in the file. annomate's live text may differ from your checkout, so quote a shorter passage, or give just the line.",
		};
	}
	if (found.length === 1) return found[0];
	if (opts.line !== undefined) {
		const target = opts.line;
		return found.reduce((best, m) =>
			Math.abs(lineAt(source, m.from) - target) < Math.abs(lineAt(source, best.from) - target)
				? m
				: best,
		);
	}
	const lines = found.map((m) => lineAt(source, m.from));
	return {
		error: `That quote appears ${found.length} times, on lines ${lines.join(", ")}. Pass line to pick one, or quote more of the passage.`,
	};
}
