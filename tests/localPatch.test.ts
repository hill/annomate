import { describe, expect, test } from "vitest";
import { localPatch } from "../src/app/localPatch";
import { parsePatch } from "../src/history/diff";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("local patch", () => {
	test("nothing changed means no patch", () => {
		expect(localPatch("a\nb", "a\nb").patch).toBeNull();
	});

	test("one edit gets three lines of context and git's header", () => {
		const before = lines(10);
		const after = before.replace("line 5", "line five");
		const { patch, additions, deletions } = localPatch(before, after);
		expect([additions, deletions]).toEqual([1, 1]);
		expect(patch?.split("\n")[0]).toBe("@@ -2,7 +2,7 @@");
		const [hunk] = parsePatch(patch ?? "");
		expect(hunk.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["line five"]);
		expect(hunk.lines.find((l) => l.kind === "add")?.new).toBe(5);
	});

	test("far apart edits make separate hunks, near ones share", () => {
		const before = lines(40);
		const far = before.replace("line 3", "x").replace("line 30", "y");
		expect(parsePatch(localPatch(before, far).patch ?? "")).toHaveLength(2);
		const near = before.replace("line 3", "x").replace("line 8", "y");
		expect(parsePatch(localPatch(before, near).patch ?? "")).toHaveLength(1);
	});

	test("a new file is all additions from line 1", () => {
		const { patch, additions } = localPatch("", "one\ntwo\n");
		expect(additions).toBe(2);
		expect(patch?.split("\n")[0]).toBe("@@ -0,0 +1,2 @@");
	});

	test("insertion at the top numbers the old side from the first kept line", () => {
		const before = lines(5);
		const { patch } = localPatch(before, `new top\n${before}`);
		expect(patch?.split("\n")[0]).toBe("@@ -1,3 +1,4 @@");
	});
});
