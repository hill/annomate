import DiffMatchPatch from "diff-match-patch";
import * as Y from "yjs";

const CONTEXT = 32;
const MIN_SIMILARITY = 0.6;

/**
 * Where a comment points. The relative positions follow the text through every
 * edit made inside annomate. The quote, its context and the commit survive
 * anything else, so the comment can always be re-found or at least shown with
 * what it originally said.
 */
export interface Anchor {
	file: string;
	start: string;
	end: string;
	quote: string;
	prefix: string;
	suffix: string;
	commit: string;
	line: number;
}

export type AnchorStatus =
	/** Live positions resolve and still cover the original quote. */
	| "ok"
	/** The commented text has changed since the comment was made. */
	| "edited"
	/** Live positions were lost, the quote was found again elsewhere. */
	| "moved"
	/** Nothing in the file matches any more. */
	| "detached";

export interface Resolved {
	status: AnchorStatus;
	from: number;
	to: number;
	current: string;
	/** True when the range came from searching rather than the live positions. */
	searched: boolean;
}

const dmp = new DiffMatchPatch();
// diff-match-patch bounds its work with a clock, and a Worker's clock stands still while code
// runs, so the bound never fires there. `diff` bounds the work by size instead.
dmp.Diff_Timeout = 0;

/** Blocks of changed lines up to this many characters a side are refined to characters. */
const REFINE_MAX = 4000;

/**
 * A character diff from `a` to `b` whose cost grows with the changed lines, not the file. Lines
 * are diffed first. Each replaced block is then diffed by character when it is small enough to
 * be quick; a larger one stays a whole-block replacement.
 */
export function diff(a: string, b: string): DiffMatchPatch.Diff[] {
	if (a === b) return a ? [[DiffMatchPatch.DIFF_EQUAL, a]] : [];
	const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
	const lines = dmp.diff_main(chars1, chars2, false);
	dmp.diff_charsToLines_(lines, lineArray);

	const out: DiffMatchPatch.Diff[] = [];
	let removed = "";
	let added = "";
	const flush = () => {
		if (removed && added && removed.length <= REFINE_MAX && added.length <= REFINE_MAX) {
			const refined = dmp.diff_main(removed, added, false);
			dmp.diff_cleanupSemantic(refined);
			out.push(...refined);
		} else {
			if (removed) out.push([DiffMatchPatch.DIFF_DELETE, removed]);
			if (added) out.push([DiffMatchPatch.DIFF_INSERT, added]);
		}
		removed = "";
		added = "";
	};
	for (const [op, text] of lines) {
		if (op === DiffMatchPatch.DIFF_DELETE) removed += text;
		else if (op === DiffMatchPatch.DIFF_INSERT) added += text;
		else {
			flush();
			out.push([op, text]);
		}
	}
	flush();
	return out;
}

const encode = (bytes: Uint8Array) => {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
};

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function relPos(text: Y.Text, index: number, assoc: number): string {
	return encode(
		Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc)),
	);
}

function absPos(doc: Y.Doc, text: Y.Text, encoded: string): number | null {
	const abs = Y.createAbsolutePositionFromRelativePosition(
		Y.decodeRelativePosition(decode(encoded)),
		doc,
	);
	return abs && abs.type === text ? abs.index : null;
}

export function lineAt(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
	return line;
}

/** A comment on a position between characters rather than on a passage. */
export const isPoint = (anchor: Anchor) => anchor.quote === "";

/**
 * A range's start associates right and its end left, so text typed just
 * outside the range stays outside it. A point associates right at both ends,
 * so it moves ahead of text typed at it, like a cursor.
 */
export function livePositions(text: Y.Text, from: number, to: number) {
	if (from === to) {
		const at = relPos(text, from, 0);
		return { start: at, end: at };
	}
	return { start: relPos(text, from, 0), end: relPos(text, to, -1) };
}

export function createAnchor(
	text: Y.Text,
	file: string,
	from: number,
	to: number,
	commit: string,
): Anchor {
	const source = text.toString();
	return {
		file,
		...livePositions(text, from, to),
		quote: source.slice(from, to),
		prefix: source.slice(Math.max(0, from - CONTEXT), from),
		suffix: source.slice(to, to + CONTEXT),
		commit,
		line: lineAt(source, from),
	};
}

export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const longest = Math.max(a.length, b.length);
	if (longest === 0) return 1;
	return 1 - dmp.diff_levenshtein(diff(a, b)) / longest;
}

function commonSuffix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

function commonPrefix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

function contextScore(source: string, from: number, to: number, anchor: Anchor): number {
	return (
		commonSuffix(source.slice(Math.max(0, from - CONTEXT), from), anchor.prefix) +
		commonPrefix(source.slice(to, to + CONTEXT), anchor.suffix)
	);
}

function exactMatches(source: string, quote: string): number[] {
	const hits: number[] = [];
	if (!quote) return hits;
	for (let i = source.indexOf(quote); i !== -1; i = source.indexOf(quote, i + 1)) hits.push(i);
	return hits;
}

/**
 * Text between an intact prefix and suffix is the commented passage, however
 * much it was rewritten.
 */
function sandwich(source: string, anchor: Anchor): [number, number] | null {
	if (anchor.prefix.length < 8 || anchor.suffix.length < 8) return null;
	const limit = anchor.quote.length * 3 + 64;
	let best: [number, number] | null = null;
	for (const p of exactMatches(source, anchor.prefix)) {
		const from = p + anchor.prefix.length;
		const s = source.indexOf(anchor.suffix, from);
		if (s === -1 || s - from > limit) continue;
		if (!best || s - from < best[1] - best[0]) best = [from, s];
	}
	return best;
}

function fuzzy(source: string, quote: string, hint: number): [number, number] | null {
	if (quote.length < 4) return null;
	// Proximity only breaks ties. A passage can move anywhere in the file.
	dmp.Match_Distance = Math.max(1000, source.length * 10);
	dmp.Match_Threshold = 0.4;
	const bits = dmp.Match_MaxBits;
	const head = dmp.match_main(source, quote.slice(0, bits), hint);
	const tailPattern = quote.slice(-bits);
	const tail =
		quote.length > bits
			? dmp.match_main(source, tailPattern, Math.max(0, hint + quote.length - bits))
			: -1;

	const candidates: [number, number][] = [];
	if (head !== -1 && tail !== -1) {
		const end = tail + tailPattern.length;
		const span = end - head;
		if (span > quote.length * 0.5 && span < quote.length * 1.5) candidates.push([head, end]);
	}
	if (head !== -1) candidates.push([head, Math.min(source.length, head + quote.length)]);
	if (tail !== -1) {
		const end = tail + tailPattern.length;
		candidates.push([Math.max(0, end - quote.length), end]);
	}

	let best: [number, number] | null = null;
	let bestScore = MIN_SIMILARITY;
	for (const [from, to] of candidates) {
		const score = similarity(quote, source.slice(from, to));
		if (score >= bestScore) {
			best = [from, to];
			bestScore = score;
		}
	}
	return best;
}

/**
 * Find the passage an anchor refers to in text whose live positions are gone.
 * Tries the exact quote (ranked by surrounding context), then an intact
 * prefix and suffix around rewritten text, then a fuzzy match.
 */
export function findQuote(source: string, anchor: Anchor): Resolved | null {
	const hits = exactMatches(source, anchor.quote);
	if (hits.length) {
		let best = hits[0];
		let bestScore = -1;
		for (const h of hits) {
			const score = contextScore(source, h, h + anchor.quote.length, anchor);
			if (score > bestScore) {
				best = h;
				bestScore = score;
			}
		}
		const to = best + anchor.quote.length;
		return { status: "moved", from: best, to, current: anchor.quote, searched: true };
	}

	const between = sandwich(source, anchor);
	if (between) {
		const [from, to] = between;
		return { status: "edited", from, to, current: source.slice(from, to), searched: true };
	}

	const hint = Math.max(0, source.split("\n", anchor.line - 1).join("\n").length);
	const near = fuzzy(source, anchor.quote, hint);
	if (near) {
		const [from, to] = near;
		return { status: "edited", from, to, current: source.slice(from, to), searched: true };
	}
	return null;
}

/** Find a point by the text either side of it, then by either side alone. */
function findPoint(source: string, anchor: Anchor): Resolved | null {
	const hint = Math.max(0, source.split("\n", anchor.line - 1).join("\n").length);
	const nearest = (hits: number[]) =>
		hits.reduce((a, b) => (Math.abs(b - hint) < Math.abs(a - hint) ? b : a));
	const at = (index: number): Resolved => ({
		status: "moved",
		from: index,
		to: index,
		current: "",
		searched: true,
	});

	const both = exactMatches(source, anchor.prefix + anchor.suffix);
	if (both.length) return at(nearest(both) + anchor.prefix.length);
	const before = anchor.prefix.length >= 8 ? exactMatches(source, anchor.prefix) : [];
	if (before.length) return at(nearest(before) + anchor.prefix.length);
	const after = anchor.suffix.length >= 8 ? exactMatches(source, anchor.suffix) : [];
	if (after.length) return at(nearest(after));
	return null;
}

export function resolveAnchor(doc: Y.Doc, text: Y.Text | undefined, anchor: Anchor): Resolved {
	const detached: Resolved = { status: "detached", from: 0, to: 0, current: "", searched: true };
	if (!text) return detached;
	const source = text.toString();
	if (isPoint(anchor)) {
		const at = absPos(doc, text, anchor.start);
		if (at !== null) return { status: "ok", from: at, to: at, current: "", searched: false };
		return findPoint(source, anchor) ?? detached;
	}
	const from = absPos(doc, text, anchor.start);
	const to = absPos(doc, text, anchor.end);

	if (from !== null && to !== null && to > from) {
		const current = source.slice(from, to);
		if (current === anchor.quote) return { status: "ok", from, to, current, searched: false };
		// A range that grew to swallow far more than it started with has really
		// lost its target, which a search will find better.
		if (similarity(anchor.quote, current) >= 0.3 || current.length <= anchor.quote.length * 2) {
			return { status: "edited", from, to, current, searched: false };
		}
	}
	return findQuote(source, anchor) ?? detached;
}

/**
 * Point the live positions at a range found by searching, so the anchor
 * tracks edits again from here on. Quote and commit are left alone so the
 * original passage is never lost.
 */
export function reattach(text: Y.Text, anchor: Anchor, resolved: Resolved): Anchor {
	return { ...anchor, ...livePositions(text, resolved.from, resolved.to) };
}

/**
 * Turn `text` into `next` with the smallest set of insertions and deletions,
 * so unchanged regions keep their identity and any positions inside them.
 */
export function applyMinimalDiff(text: Y.Text, next: string) {
	const current = text.toString();
	if (current === next) return;
	const diffs = diff(current, next);
	let index = 0;
	for (const [op, chunk] of diffs) {
		if (op === DiffMatchPatch.DIFF_EQUAL) index += chunk.length;
		else if (op === DiffMatchPatch.DIFF_DELETE) text.delete(index, chunk.length);
		else {
			text.insert(index, chunk);
			index += chunk.length;
		}
	}
}

/**
 * Three-way merge of plain text. Applies the change from `base` to `theirs` on
 * top of `ours`. Returns the merged text and whether every hunk applied.
 */
export function merge3(
	base: string,
	ours: string,
	theirs: string,
): { text: string; clean: boolean } {
	if (ours === base) return { text: theirs, clean: true };
	if (theirs === base || theirs === ours) return { text: ours, clean: true };
	const patches = dmp.patch_make(base, diff(base, theirs));
	const [text, applied] = dmp.patch_apply(patches, ours);
	return { text, clean: applied.every(Boolean) };
}

export type InlineDiff = [op: -1 | 0 | 1, text: string][];

/**
 * Word-level diff, for showing people what changed in a passage. Each word
 * and each run of whitespace is mapped to one character so the diff never
 * splits a word.
 */
export function inlineDiff(before: string, after: string): InlineDiff {
	const vocab: string[] = [];
	const ids = new Map<string, string>();
	const encode = (text: string) =>
		(text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [])
			.map((token) => {
				let id = ids.get(token);
				if (id === undefined) {
					id = String.fromCharCode(vocab.length + 1);
					ids.set(token, id);
					vocab.push(token);
				}
				return id;
			})
			.join("");
	const diffs = dmp.diff_main(encode(before), encode(after), false);
	dmp.diff_cleanupSemantic(diffs);
	return diffs.map(([op, chars]) => [
		op,
		[...chars].map((c) => vocab[c.charCodeAt(0) - 1]).join(""),
	]) as InlineDiff;
}
