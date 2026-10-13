import { describe, expect, test } from "vitest";
import { parseTexLog } from "../worker/tex/log";

const FILES = new Set(["thesis/main.tex", "thesis/chapters/intro.tex", "thesis/refs.bib"]);
const inProject = (p: string) => FILES.has(p);

const LOG =
	String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2026) (preloaded format=pdflatex)
(./main.tex
LaTeX2e <2025-11-01>
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Document Class: article 2024/06/29 v1.4n Standard LaTeX document class
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size10.clo))
(./chapters/intro.tex
./chapters/intro.tex:12: Undefined control sequence.
l.12 We cite \citee
                  {knuth}.

LaTeX Warning: Reference ` +
	"`fig:map'" +
	String.raw` on page 1 undefined on input line 20.

Overfull \hbox (12.3pt too wide) in paragraph at lines 30--31
[]\T1/cmr/m/n/10 A very long line
)
Package natbib Warning: Citation ` +
	"`smith'" +
	String.raw` on page 2 undefined on input line
(natbib)                41.

./main.tex:5: LaTeX Error: File ` +
	"`fancy.sty'" +
	String.raw` not found.

LaTeX Warning: There were undefined references.

)`;

describe("parseTexLog", () => {
	const problems = parseTexLog(LOG, "thesis/main.tex", inProject);

	test("places errors at their file, line and column", () => {
		expect(problems).toContainEqual({
			severity: "error",
			message: "Undefined control sequence.",
			path: "thesis/chapters/intro.tex",
			line: 11,
			column: 8,
			endLine: 11,
			endColumn: 14,
		});
	});

	test("explains a missing package", () => {
		const missing = problems.find((p) => p.message.includes("fancy.sty"));
		expect(missing).toMatchObject({ severity: "error", path: "thesis/main.tex", line: 4 });
		expect(missing?.message).toBe(
			"fancy.sty is not in the project or among the installed TeX packages.",
		);
	});

	test("attributes warnings to the file open at the time", () => {
		expect(problems).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				path: "thesis/chapters/intro.tex",
				line: 19,
				message: "Reference `fig:map' on page 1 undefined.",
			}),
		);
	});

	test("joins a warning continued on the next line, and names its package", () => {
		expect(problems).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				path: "thesis/main.tex",
				line: 40,
				message: "natbib: Citation `smith' on page 2 undefined.",
			}),
		);
	});

	test("puts warnings without a line on the main file", () => {
		expect(problems).toContainEqual(
			expect.objectContaining({
				path: "thesis/main.tex",
				line: null,
				message: "There were undefined references.",
			}),
		);
	});

	test("reports bad boxes as info", () => {
		expect(problems).toContainEqual(
			expect.objectContaining({ severity: "info", path: "thesis/chapters/intro.tex", line: 29 }),
		);
	});
});
