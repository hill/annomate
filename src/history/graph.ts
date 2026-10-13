export interface GraphCommit {
	sha: string;
	parents: string[];
}

export interface Segment {
	/** Lane at the top of the row, or the node when `fromNode`. */
	from: number;
	to: number;
	/** Segment runs from the top edge to the node, node to the bottom edge, or straight through. */
	kind: "in" | "out" | "through";
	color: number;
}

export interface GraphRow {
	lane: number;
	color: number;
	segments: Segment[];
	merge: boolean;
}

/**
 * Lay commits (newest first) out in lanes, the way `git log --graph` does.
 * Each lane holds the sha it expects next. A commit takes the lane that was
 * waiting for it, hands that lane to its first parent and opens lanes for
 * any further parents.
 */
export function layout(commits: GraphCommit[]): { rows: GraphRow[]; width: number } {
	let lanes: (string | null)[] = [];
	const colors: number[] = [];
	let nextColor = 0;
	let width = 1;
	const rows: GraphRow[] = [];

	for (const commit of commits) {
		let lane = lanes.indexOf(commit.sha);
		if (lane === -1) {
			lane = lanes.indexOf(null);
			if (lane === -1) lane = lanes.length;
			lanes[lane] = commit.sha;
			colors[lane] = nextColor++;
		}
		const color = colors[lane];
		const segments: Segment[] = [];

		lanes.forEach((sha, j) => {
			if (sha === null) return;
			if (sha === commit.sha) segments.push({ from: j, to: lane, kind: "in", color: colors[j] });
		});

		const after = lanes.map((sha) => (sha === commit.sha ? null : sha));
		const [first, ...rest] = commit.parents;
		if (first !== undefined) {
			const existing = after.indexOf(first);
			if (existing === -1 || existing > lane) {
				// Shared parents gather in the leftmost lane that wants them.
				if (existing !== -1) after[existing] = null;
				after[lane] = first;
				colors[lane] = color;
				segments.push({ from: lane, to: lane, kind: "out", color });
			} else {
				segments.push({ from: lane, to: existing, kind: "out", color: colors[existing] });
			}
		}
		for (const parent of rest) {
			let target = after.indexOf(parent);
			if (target === -1) {
				target = after.indexOf(null, lane + 1);
				if (target === -1) target = after.length;
				after[target] = parent;
				colors[target] = nextColor++;
			}
			segments.push({ from: lane, to: target, kind: "out", color: colors[target] });
		}

		lanes.forEach((sha, j) => {
			if (sha === null || sha === commit.sha) return;
			const to = after.indexOf(sha);
			if (to !== -1) segments.push({ from: j, to, kind: "through", color: colors[to] });
		});

		while (after.length && after[after.length - 1] === null) after.pop();
		width = Math.max(width, lanes.length, after.length);
		lanes = after;
		rows.push({ lane, color, segments, merge: commit.parents.length > 1 });
	}
	return { rows, width };
}
