import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { type Language, StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import type { Extension } from "@codemirror/state";
import type { Parser } from "@lezer/common";
import { typst_lezer } from "codemirror-lang-typst/lezer";
import { typstHover } from "./typstDocs";

// Class and package files are LaTeX too, though they are not documents of their own.
const LATEX = /\.(tex|sty|cls|ltx|def)$/i;
const MARKDOWN = /\.(md|markdown)$/i;

const typst = typst_lezer();
const latex = StreamLanguage.define(stex);

function language(path: string): "typst" | "latex" | "markdown" | null {
	if (path.endsWith(".typ")) return "typst";
	if (LATEX.test(path)) return "latex";
	if (MARKDOWN.test(path)) return "markdown";
	return null;
}

/** Highlighting and language help for a file in the editor. */
export function editorLanguage(path: string): Extension {
	switch (language(path)) {
		case "typst":
			return [typst, typstHover];
		case "latex":
			return latex;
		case "markdown":
			return markdown({ base: markdownLanguage });
		default:
			return [];
	}
}

const PARSERS: Record<"typst" | "latex" | "markdown", Language> = {
	typst: typst.language,
	latex,
	markdown: markdownLanguage,
};

/** A parser for a file's syntax, for highlighting outside the editor. Null for plain files. */
export function parserFor(path: string): Parser | null {
	const name = language(path);
	return name ? PARSERS[name].parser : null;
}
