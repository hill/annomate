/**
 * The document formats a project can hold. Plain data, so the worker and the browser share it.
 * Each format's compiler, editor language and reference syntax live with the code that uses
 * them, keyed by `ProjectFormat`.
 */
export type ProjectFormat = "typst" | "markdown" | "latex";

export interface FormatSpec {
	id: ProjectFormat;
	label: string;
	/** Extensions of the files that make up the document, as opposed to data and assets. */
	sources: string[];
	/** Preferred main files, most likely first. */
	mains: string[];
	/** Whether a candidate's text marks it as the document's entry point. */
	isEntry?(text: string): boolean;
}

export const FORMATS: Record<ProjectFormat, FormatSpec> = {
	typst: { id: "typst", label: "Typst", sources: [".typ"], mains: ["main.typ"] },
	latex: {
		id: "latex",
		label: "LaTeX",
		sources: [".tex"],
		mains: ["main.tex"],
		isEntry: (text) => /^[^%\n]*\\documentclass/m.test(text),
	},
	markdown: {
		id: "markdown",
		label: "Markdown",
		sources: [".md", ".markdown"],
		mains: ["main.md", "index.md", "README.md"],
	},
};

// Typst first: a Typst or LaTeX repo usually carries a README too.
const DETECTION_ORDER: ProjectFormat[] = ["typst", "latex", "markdown"];

export const isFormat = (value: unknown): value is ProjectFormat =>
	typeof value === "string" && value in FORMATS;

export const isSource = (format: ProjectFormat, path: string) =>
	FORMATS[format].sources.some((ext) => path.toLowerCase().endsWith(ext));

/** The format a source file belongs to, by its extension. */
export const formatOf = (path: string): ProjectFormat | null =>
	DETECTION_ORDER.find((format) => isSource(format, path)) ?? null;

const depth = (path: string) => path.split("/").length;

/**
 * The main file for a format among a repo's text files: a preferred name at the root, then the
 * shallowest source that reads as an entry point, then the shallowest source.
 */
export function pickMain(
	format: ProjectFormat,
	paths: string[],
	read: (path: string) => string | undefined = () => undefined,
): string | null {
	const spec = FORMATS[format];
	const sources = paths.filter((p) => isSource(format, p)).sort((a, b) => depth(a) - depth(b));
	if (!sources.length) return null;
	for (const name of spec.mains) {
		const hit = sources.find((p) => p.toLowerCase() === name.toLowerCase());
		if (hit) return hit;
	}
	if (spec.isEntry) {
		const entry = sources.find((p) => {
			const text = read(p);
			return text !== undefined && spec.isEntry?.(text);
		});
		if (entry) return entry;
	}
	return sources[0];
}

/** A format and main file for a repo, or null when it holds no document annomate can show. */
export function detectFormat(
	paths: string[],
	read?: (path: string) => string | undefined,
): { format: ProjectFormat; mainFile: string } | null {
	for (const format of DETECTION_ORDER) {
		const mainFile = pickMain(format, paths, read);
		if (mainFile) return { format, mainFile };
	}
	return null;
}

/** The name an exported PDF gets: the repo, then the main file without its extension. */
export function pdfName(repo: string, mainFile: string): string {
	const name = repo.split("/").pop() ?? "document";
	const main = (mainFile.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
	return `${name}-${main || "document"}.pdf`;
}
