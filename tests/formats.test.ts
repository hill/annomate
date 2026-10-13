import { describe, expect, test } from "vitest";
import { detectFormat, formatOf, pdfName, pickMain } from "../shared/formats";
import { isTextPath } from "../shared/protocol";

describe("detectFormat", () => {
	test("prefers Typst, since Typst and LaTeX repos carry READMEs too", () => {
		expect(detectFormat(["README.md", "paper/main.typ", "notes.typ"])).toEqual({
			format: "typst",
			mainFile: "notes.typ",
		});
		expect(detectFormat(["README.md", "main.typ", "a.typ"])?.mainFile).toBe("main.typ");
	});

	test("finds a LaTeX document by its \\documentclass when there is no main.tex", () => {
		const texts: Record<string, string> = {
			"chapters/intro.tex": "\\section{Intro}",
			"thesis.tex": "% A thesis\n\\documentclass{report}",
		};
		expect(detectFormat(["README.md", ...Object.keys(texts)], (p) => texts[p])).toEqual({
			format: "latex",
			mainFile: "thesis.tex",
		});
	});

	test("ignores a commented-out \\documentclass", () => {
		const texts: Record<string, string> = {
			"a.tex": "% \\documentclass{article}",
			"b.tex": "\\documentclass{article}",
		};
		expect(pickMain("latex", ["a.tex", "b.tex"], (p) => texts[p])).toBe("b.tex");
	});

	test("falls back to Markdown, preferring main, index, then README", () => {
		expect(detectFormat(["docs/x.md", "README.md"])?.mainFile).toBe("README.md");
		expect(detectFormat(["README.md", "index.md"])?.mainFile).toBe("index.md");
		expect(detectFormat(["docs/guide.md"])).toEqual({
			format: "markdown",
			mainFile: "docs/guide.md",
		});
	});

	test("finds nothing in a repo with no documents", () => {
		expect(detectFormat(["src/index.ts", "package.json"])).toBeNull();
	});
});

describe("formats", () => {
	test("formatOf knows each document extension", () => {
		expect(formatOf("a/b.typ")).toBe("typst");
		expect(formatOf("b.TEX")).toBe("latex");
		expect(formatOf("notes.markdown")).toBe("markdown");
		expect(formatOf("refs.bib")).toBeNull();
	});

	test("pdfName uses the repo and the main file's name", () => {
		expect(pdfName("hill/thesis", "chapters/main.tex")).toBe("thesis-main.pdf");
		expect(pdfName("hill/notes", "README.md")).toBe("notes-README.pdf");
	});

	test("LaTeX support files load as text", () => {
		for (const p of ["style/thesis.cls", "a.sty", "refs.bst", "latexmkrc", "sub/.latexmkrc"])
			expect(isTextPath(p)).toBe(true);
		expect(isTextPath("figure.pdf")).toBe(false);
	});
});
