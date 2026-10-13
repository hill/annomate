/** The drag data type the file tree sets, holding the dragged path. */
export const DRAG_TYPE = "application/x-annomate-path";

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

/**
 * `target` as written in `file`. Typst resolves paths against the file that
 * names them, and paths starting with `/` against the project root.
 */
function pathFrom(file: string, target: string) {
	const dir = file.split("/").slice(0, -1).join("/");
	if (!dir) return target;
	return target.startsWith(`${dir}/`) ? target.slice(dir.length + 1) : `/${target}`;
}

const quote = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;

/** The Typst that brings `target` into `file`, without the leading `#` code needs. */
function call(file: string, target: string) {
	const path = quote(pathFrom(file, target));
	if (IMAGE.test(target)) return `image(${path})`;
	if (target.endsWith(".typ")) return `include ${path}`;
	if (target.endsWith(".bib")) return `bibliography(${path})`;
	return null;
}

/** References to `targets` from `file`, joined to suit markup or code at the insertion point. */
export function references(file: string, targets: string[], code: boolean) {
	return targets
		.map((t) => {
			const c = call(file, t);
			if (!c) return quote(pathFrom(file, t));
			return code ? c : `#${c}`;
		})
		.join(code ? ", " : "\n");
}
