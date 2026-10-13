import { describe, expect, test } from "vitest";
import { locatePassage } from "../shared/locate";

const SOURCE = `= Introduction

Typst is a markup-based typesetting system.
It is designed to be as powerful
as LaTeX while being much easier to learn.

= Method

Typst is a markup-based typesetting system.
`;

const slice = (r: ReturnType<typeof locatePassage>) =>
	"error" in r ? r.error : SOURCE.slice(r.from, r.to);

describe("locating a passage for an agent's comment", () => {
	test("an exact quote that appears once", () => {
		expect(slice(locatePassage(SOURCE, { quote: "much easier to learn" }))).toBe(
			"much easier to learn",
		);
	});

	test("a quote wrapped differently from the live text", () => {
		const r = locatePassage(SOURCE, { quote: "designed to be as powerful as LaTeX" });
		expect(slice(r)).toBe("designed to be as powerful\nas LaTeX");
	});

	test("a repeated quote asks for a line, then picks the nearest one", () => {
		const quote = "Typst is a markup-based typesetting system.";
		const ambiguous = locatePassage(SOURCE, { quote });
		expect("error" in ambiguous && ambiguous.error).toContain("lines 3, 9");
		const near = locatePassage(SOURCE, { quote, line: 8 });
		expect("error" in near ? null : near.from).toBe(SOURCE.lastIndexOf(quote));
	});

	test("a line alone covers that line without its indentation", () => {
		expect(slice(locatePassage(SOURCE, { line: 4 }))).toBe("It is designed to be as powerful");
	});

	test("explains what went wrong", () => {
		expect(slice(locatePassage(SOURCE, { quote: "not in here" }))).toContain("not in the file");
		expect(slice(locatePassage(SOURCE, { line: 2 }))).toContain("blank");
		expect(slice(locatePassage(SOURCE, { line: 99 }))).toContain("no line 99");
		expect(slice(locatePassage(SOURCE, {}))).toContain("quote");
	});
});
