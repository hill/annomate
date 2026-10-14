import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();

export interface LocalPatch {
	/** Unified diff hunks in the shape GitHub returns per file, or null when nothing changed. */
	patch: string | null;
	additions: number;
	deletions: number;
}

/**
 * Build a unified diff for one file, so uncommitted changes render in the same
 * viewer as commits from GitHub. Lines are compared whole, with `context`
 * unchanged lines kept around each change.
 */
export function localPatch(before: string, after: string, context = 3): LocalPatch {
	if (before === after) return { patch: null, additions: 0, deletions: 0 };
	const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(before, after);
	const diffs = dmp.diff_main(chars1, chars2, false);

	const ops: { kind: " " | "-" | "+"; text: string; old: number; new: number }[] = [];
	let oldNo = 0;
	let newNo = 0;
	for (const [op, chars] of diffs) {
		for (const ch of chars) {
			const text = lineArray[ch.charCodeAt(0)].replace(/\n$/, "");
			if (op === DiffMatchPatch.DIFF_EQUAL)
				ops.push({ kind: " ", text, old: ++oldNo, new: ++newNo });
			else if (op === DiffMatchPatch.DIFF_DELETE)
				ops.push({ kind: "-", text, old: ++oldNo, new: newNo });
			else ops.push({ kind: "+", text, old: oldNo, new: ++newNo });
		}
	}

	const changed = ops.flatMap((o, i) => (o.kind === " " ? [] : [i]));
	const hunks: string[] = [];
	let additions = 0;
	let deletions = 0;
	for (let c = 0; c < changed.length; ) {
		const start = Math.max(0, changed[c] - context);
		let last = changed[c];
		// Changes closer than twice the context share a hunk, as git does.
		while (c + 1 < changed.length && changed[c + 1] - last <= context * 2) last = changed[++c];
		c++;
		const end = Math.min(ops.length, last + context + 1);
		const slice = ops.slice(start, end);
		const oldCount = slice.filter((o) => o.kind !== "+").length;
		const newCount = slice.filter((o) => o.kind !== "-").length;
		// Each side starts at its first line in the hunk. A side with no lines names the line
		// before the hunk instead, which is 0 at the top of a file.
		const firstOld = slice.find((o) => o.kind !== "+");
		const firstNew = slice.find((o) => o.kind !== "-");
		const oldStart = firstOld ? firstOld.old : slice[0].old;
		const newStart = firstNew ? firstNew.new : slice[0].new;
		const body = slice.map((o) => {
			if (o.kind === "+") additions++;
			if (o.kind === "-") deletions++;
			return o.kind + o.text;
		});
		hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
	}
	return { patch: hunks.join("\n"), additions, deletions };
}
