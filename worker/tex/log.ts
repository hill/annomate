import type { Diagnostic } from "../../shared/protocol";

/**
 * Problems from a LaTeX log, compiled with -file-line-error and long log lines.
 *
 * Errors name their file and line. Warnings only name a line, so the file comes from the
 * `(./file.tex … )` nesting TeX writes as it opens and closes each input. Paths in the log are
 * relative to the folder the compile ran in, which holds the main file.
 */
export function parseTexLog(
	log: string,
	mainFile: string,
	inProject: (path: string) => boolean,
): Diagnostic[] {
	const dir = mainFile.split("/").slice(0, -1).join("/");
	const project = (logPath: string) => {
		const path = normalise(dir ? `${dir}/${logPath}` : logPath);
		return inProject(path) ? path : null;
	};
	const out: Diagnostic[] = [];
	const seen = new Set<string>();
	const add = (d: Diagnostic) => {
		const key = `${d.severity}|${d.path}|${d.line}|${d.message}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(d);
	};
	const at = (
		path: string | null,
		line: number | null,
		column = 0,
		endColumn = column,
	): Pick<Diagnostic, "path" | "line" | "column" | "endLine" | "endColumn"> =>
		// A problem inside an installed package belongs to the document that loaded it.
		path
			? { path, line, column, endLine: line, endColumn }
			: { path: mainFile, line: null, column: 0, endLine: null, endColumn: 0 };

	const files: (string | null)[] = [];
	const current = () => {
		for (let i = files.length - 1; i >= 0; i--) {
			const f = files[i];
			if (f) return project(f);
		}
		return null;
	};

	const lines = log.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const error = line.match(FILE_LINE_ERROR);
		if (error) {
			const [, file, n, message] = error;
			const context = lines.slice(i + 1, i + 8).find((l) => /^l\.\d+ /.test(l));
			add({
				severity: "error",
				message: errorMessage(message),
				...at(project(file), Number(n) - 1, ...culprit(context)),
			});
			continue;
		}

		if (line.startsWith("! ")) {
			const context = lines.slice(i + 1, i + 8).find((l) => /^l\.\d+ /.test(l));
			const n = context ? Number(context.match(/^l\.(\d+)/)?.[1]) - 1 : null;
			add({ severity: "error", message: errorMessage(line.slice(2)), ...at(current(), n) });
			continue;
		}

		const warning = line.match(WARNING)?.groups;
		if (warning) {
			const from = warning.pkg ?? warning.cls;
			let message = warning.msg;
			// A warning continues on lines indented to sit under its first.
			while (i + 1 < lines.length && /^\(\S+\)\s+/.test(lines[i + 1])) {
				message += ` ${lines[++i].replace(/^\(\S+\)\s+/, "")}`;
			}
			const n = message.match(/on input line (\d+)/);
			add({
				severity: "warning",
				message: `${from ? `${from}: ` : ""}${message.replace(/\s+on input line \d+\.$/, ".")}`,
				...at(current(), n ? Number(n[1]) - 1 : null),
			});
			continue;
		}

		const box = line.match(BOX);
		if (box) {
			add({
				severity: "info",
				message: line.replace(/ in (paragraph|alignment) at lines? .*$/, ""),
				...at(current(), Number(box[1]) - 1),
			});
			continue;
		}

		track(line, files);
	}
	return out;
}

const FILE_LINE_ERROR = /^(\.?\.?\/?[^:\s][^:]*\.(?:tex|sty|cls|ltx|def|bbl|cfg|clo)):(\d+): (.*)$/;
const WARNING = /^(?:LaTeX|Package (?<pkg>\S+)|Class (?<cls>\S+)) Warning: (?<msg>.*)$/;
const BOX = /^(?:Over|Under)full \\[hv]box .* at lines? (\d+)/;

/**
 * TeX breaks the `l.<n>` context line where it stopped, so the text before the break ends with
 * the token at fault. Its columns, start and end.
 */
function culprit(context: string | undefined): [number, number] {
	if (!context) return [0, 0];
	const before = context.replace(/^l\.\d+ /, "");
	const token = before.match(/(\\[A-Za-z@]+|\S+)\s*$/);
	const start = token?.index ?? before.length;
	return [start, start + (token?.[1].length ?? 0)];
}

function errorMessage(message: string): string {
	const missing = message.match(/^(?:LaTeX Error: )?File [`'](.+?)' not found\./);
	if (missing) return `${missing[1]} is not in the project or among the installed TeX packages.`;
	return message.replace(/^LaTeX Error: /, "");
}

/** Follow TeX's `(file` and `)` markers, which bracket the output of each file it reads. */
function track(line: string, files: (string | null)[]) {
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "(") {
			const name = line.slice(i + 1).match(/^[^\s()]+/)?.[0] ?? "";
			files.push(/\.[a-z]{2,4}$/i.test(name) ? name : null);
		} else if (line[i] === ")") {
			files.pop();
		}
	}
}

function normalise(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return parts.join("/");
}
