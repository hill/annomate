import { syntaxHighlighting } from "@codemirror/language";
import { tags as t, tagHighlighter } from "@lezer/highlight";

// Class names rather than inline styles, so anything that renders Typst (the editor, the diff
// viewer) shares one set of rules. The `.syn-*` rules in styles.css map them to theme colours.
export const highlighter = tagHighlighter([
	{ tag: t.comment, class: "syn-comment" },
	{ tag: t.heading, class: "syn-heading" },
	{ tag: t.strong, class: "syn-strong" },
	{ tag: t.emphasis, class: "syn-emphasis" },
	{ tag: t.link, class: "syn-link" },
	{ tag: t.monospace, class: "syn-raw" },
	{ tag: [t.escape, t.labelName], class: "syn-label" },
	{ tag: [t.keyword, t.null, t.atom, t.bool], class: "syn-keyword" },
	{ tag: t.number, class: "syn-number" },
	{ tag: t.string, class: "syn-string" },
	{ tag: t.function(t.variableName), class: "syn-func" },
	{ tag: t.propertyName, class: "syn-prop" },
	{ tag: [t.operator, t.punctuation], class: "syn-punct" },
	{ tag: t.invalid, class: "syn-invalid" },
]);

export const highlighting = syntaxHighlighting(highlighter);
