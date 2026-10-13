import { formatOf } from "../../shared/formats";

/** The drag data type the file tree sets, holding the dragged path. */
export const DRAG_TYPE = "application/x-annomate-path";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|pdf|eps)$/i;

const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");

/**
 * `target` as written in `file`. Typst resolves paths against the file that
 * names them, and paths starting with `/` against the project root.
 */
function typstPath(file: string, target: string) {
	const dir = dirOf(file);
	if (!dir) return target;
	return target.startsWith(`${dir}/`) ? target.slice(dir.length + 1) : `/${target}`;
}

/** `target` relative to the folder `dir`, climbing out with `..` where needed. */
function relative(dir: string, target: string) {
	const from = dir ? dir.split("/") : [];
	const to = target.split("/");
	let shared = 0;
	while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
	return [...Array(from.length - shared).fill(".."), ...to.slice(shared)].join("/");
}

const quote = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;

/** The Typst that brings `target` into `file`, without the leading `#` code needs. */
function typstCall(file: string, target: string) {
	const path = quote(typstPath(file, target));
	if (IMAGE.test(target)) return `image(${path})`;
	if (target.endsWith(".typ")) return `include ${path}`;
	if (target.endsWith(".bib")) return `bibliography(${path})`;
	return null;
}

function typst(file: string, targets: string[], code: boolean) {
	return targets
		.map((t) => {
			const c = typstCall(file, t);
			if (!c) return quote(typstPath(file, t));
			return code ? c : `#${c}`;
		})
		.join(code ? ", " : "\n");
}

/** Markdown links resolve against the file that holds them. */
function markdown(file: string, targets: string[]) {
	return targets
		.map((t) => {
			const path = relative(dirOf(file), t).replace(/ /g, "%20");
			const name = t.split("/").pop() ?? t;
			return IMAGE.test(t) ? `![](${path})` : `[${name}](${path})`;
		})
		.join("\n");
}

/** LaTeX resolves paths against the folder it compiles in, which holds the main file. */
function latex(mainFile: string, targets: string[]) {
	return targets
		.map((t) => {
			const path = relative(dirOf(mainFile), t);
			if (IMAGE.test(t)) return `\\includegraphics{${path}}`;
			if (t.endsWith(".tex")) return `\\input{${path.replace(/\.tex$/, "")}}`;
			if (t.endsWith(".bib")) return `\\bibliography{${path.replace(/\.bib$/, "")}}`;
			return path;
		})
		.join("\n");
}

/**
 * References to `targets` written into `file`, in that file's language. For Typst, `code` says
 * whether the insertion point is code, which takes no leading `#`, rather than markup.
 */
export function references(file: string, targets: string[], code = false, mainFile = file) {
	switch (formatOf(file)) {
		case "markdown":
			return markdown(file, targets);
		case "latex":
			return latex(mainFile, targets);
		default:
			return typst(file, targets, code);
	}
}
