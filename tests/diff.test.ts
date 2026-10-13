import { describe, expect, test } from "vitest";
import { parsePatch, segments, splitRows, wordChanges } from "../src/history/diff";

const PATCH = [
	"@@ -1,4 +1,4 @@ = Methods",
	" We sampled ten sites.",
	"-The results were significant.",
	"+The results were not significant.",
	" Each site was visited twice.",
	"@@ -20 +20,2 @@",
	" end",
	"+tail",
	"\\ No newline at end of file",
].join("\n");

describe("parsePatch", () => {
	test("reads hunk headers, sections and line numbers", () => {
		const [first, second] = parsePatch(PATCH);
		expect(first).toMatchObject({
			oldStart: 1,
			oldLines: 4,
			newStart: 1,
			newLines: 4,
			section: "= Methods",
		});
		expect(first.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
			["context", 1, 1],
			["del", 2, null],
			["add", null, 2],
			["context", 3, 3],
		]);
		expect(second).toMatchObject({
			oldStart: 20,
			oldLines: 1,
			newStart: 20,
			newLines: 2,
			section: "",
		});
	});

	test("marks the line before a no-newline marker", () => {
		const lines = parsePatch(PATCH)[1].lines;
		expect(lines.map((l) => l.noNewline)).toEqual([false, true]);
	});

	test("marks the changed words of a paired line", () => {
		const [del, add] = parsePatch(PATCH)[0].lines.slice(1, 3);
		expect(del.changes).toEqual([]);
		expect(add.changes?.map(([a, b]) => add.text.slice(a, b))).toEqual(["not "]);
	});
});

describe("wordChanges", () => {
	test("keeps whole words together", () => {
		const out = wordChanges("the quick fox", "the quiet fox");
		expect(out?.before).toEqual([[4, 9]]);
		expect(out?.after).toEqual([[4, 9]]);
	});

	test("gives up on lines with little in common", () => {
		expect(wordChanges("completely different", "nothing shared here")).toBeNull();
	});
});

describe("splitRows", () => {
	test("pairs removals with additions and pads the shorter side", () => {
		const lines = parsePatch("@@ -1,3 +1,2 @@\n a\n-b\n-c\n+B\n").flatMap((h) => h.lines);
		expect(splitRows(lines).map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
			["a", "a"],
			["b", "B"],
			["c", null],
		]);
	});
});

describe("segments", () => {
	test("cuts where syntax and changes start and end, and merges equal neighbours", () => {
		expect(segments("#let x = 1", [{ from: 0, to: 4, cls: "kw" }], [[5, 6]])).toEqual([
			{ text: "#let", cls: "kw", changed: false },
			{ text: " ", cls: null, changed: false },
			{ text: "x", cls: null, changed: true },
			{ text: " = 1", cls: null, changed: false },
		]);
	});
});
