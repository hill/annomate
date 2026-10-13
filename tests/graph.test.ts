import { describe, expect, test } from "vitest";
import { layout } from "../src/history/graph";

describe("history graph", () => {
	test("keeps a straight history in one lane", () => {
		const { rows, width } = layout([
			{ sha: "c", parents: ["b"] },
			{ sha: "b", parents: ["a"] },
			{ sha: "a", parents: [] },
		]);
		expect(width).toBe(1);
		expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
	});

	test("opens a lane for a branch and closes it at the merge", () => {
		// m merges feature (f) into main (b). Both grew from a.
		const { rows, width } = layout([
			{ sha: "m", parents: ["b", "f"] },
			{ sha: "f", parents: ["a"] },
			{ sha: "b", parents: ["a"] },
			{ sha: "a", parents: [] },
		]);
		expect(width).toBe(2);
		expect(rows[0].merge).toBe(true);
		expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
		// The feature lane bends back into main on b's row, so a sits alone in lane 0.
		expect(rows[2].segments).toContainEqual(
			expect.objectContaining({ kind: "through", from: 1, to: 0 }),
		);
	});

	test("puts two branch tips side by side", () => {
		const { rows } = layout([
			{ sha: "x", parents: ["a"] },
			{ sha: "y", parents: ["a"] },
			{ sha: "a", parents: [] },
		]);
		expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
		expect(rows[1].segments.some((s) => s.kind === "through" && s.from === 0)).toBe(true);
	});
});
