/**
 * Maps between a position in the Typst source and a line of rendered text.
 * typst.ts lays a hidden text layer over the glyphs, one element per laid-out
 * run, so both directions come down to matching word sequences. Markup words
 * that do not render simply fail to match and are outvoted by their context.
 */

const WORD = /[\p{L}\p{N}]+/gu;
const CONTEXT = 8;

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface SourceWord {
	word: string;
	start: number;
	end: number;
}

export function sourceWords(source: string): SourceWord[] {
	const out: SourceWord[] = [];
	for (const m of source.matchAll(WORD)) {
		out.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
	}
	return out;
}

/** Score how well `b` around `j` lines up with `a` around `i`. Nearer words count more. */
function score(a: string[], i: number, b: string[], j: number): number {
	let s = 0;
	for (let k = -CONTEXT; k <= CONTEXT; k++) {
		const x = a[i + k];
		if (x !== undefined && x === b[j + k]) s += 1 / (1 + Math.abs(k) * 0.2);
	}
	return s;
}

/** Best position in `hay` for the word at `needle[at]`, preferring places near `expected`. */
function align(
	needle: string[],
	at: number,
	hay: string[],
	expected: number,
): { index: number; score: number } | null {
	let best: { index: number; score: number } | null = null;
	const target = needle[at];
	for (let j = 0; j < hay.length; j++) {
		if (hay[j] !== target) continue;
		const s = score(needle, at, hay, j) - (Math.abs(j - expected) / Math.max(1, hay.length)) * 0.5;
		if (!best || s > best.score) best = { index: j, score: s };
	}
	return best && best.score >= 1.6 ? best : null;
}

export class TextIndex {
	readonly words: string[] = [];
	private runOf: number[] = [];
	private runStart: number[] = [];
	readonly rects: Rect[] = [];

	/**
	 * @param stage the element the rects are measured against
	 * @param scale CSS pixels per point at the time of measuring
	 * @param selector the renderer's selectable text runs
	 */
	constructor(root: Element, stage: Element, scale: number, selector: string) {
		const origin = stage.getBoundingClientRect();
		for (const el of root.querySelectorAll(selector)) {
			const box = (el.parentElement ?? el).getBoundingClientRect();
			const words = (el.textContent ?? "").toLowerCase().match(WORD) ?? [];
			if (!words.length) continue;
			const run = this.rects.length;
			this.rects.push({
				x: (box.left - origin.left) / scale,
				y: (box.top - origin.top) / scale,
				w: box.width / scale,
				h: box.height / scale,
			});
			this.runStart.push(this.words.length);
			for (const w of words) {
				this.words.push(w);
				this.runOf.push(run);
			}
		}
	}

	/** The rendered run that shows the source text at `offset`. */
	fromSource(source: string, offset: number): Rect | null {
		const sw = sourceWords(source);
		const at = sw.findIndex((w) => w.end >= offset);
		if (at === -1 || !this.words.length) return null;
		const expected = (at / sw.length) * this.words.length;
		const hit = align(
			sw.map((w) => w.word),
			at,
			this.words,
			expected,
		);
		return hit ? this.rects[this.runOf[hit.index]] : null;
	}

	/** The run under a point in document coordinates, or the nearest one within reach. */
	runAt(x: number, y: number): number | null {
		let best: number | null = null;
		let bestDist = 24;
		this.rects.forEach((r, i) => {
			const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0;
			const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - r.y - r.h : 0;
			const d = Math.hypot(dx, dy * 2);
			if (d < bestDist) {
				best = i;
				bestDist = d;
			}
		});
		return best;
	}

	/** Find the source position for a point inside a run, across the given files. */
	toSource(
		run: number,
		x: number,
		files: { path: string; text: string }[],
	): { path: string; offset: number } | null {
		const start = this.runStart[run];
		const end = run + 1 < this.runStart.length ? this.runStart[run + 1] : this.words.length;
		const r = this.rects[run];
		const fraction = r.w ? Math.min(1, Math.max(0, (x - r.x) / r.w)) : 0.5;
		const at = Math.min(end - 1, start + Math.floor(fraction * (end - start)));
		let best: { path: string; offset: number; score: number } | null = null;
		for (const file of files) {
			const sw = sourceWords(file.text);
			const expected = (at / this.words.length) * sw.length;
			const hit = align(
				this.words,
				at,
				sw.map((w) => w.word),
				expected,
			);
			if (hit && (!best || hit.score > best.score))
				best = { path: file.path, offset: sw[hit.index].start, score: hit.score };
		}
		return best && { path: best.path, offset: best.offset };
	}
}
