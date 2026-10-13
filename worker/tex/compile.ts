/** One file of the project as the compile server sees it. */
export interface TexFile {
	path: string;
	/** Changes whenever the content does: a SHA-256 of text, or the git blob sha of an asset. */
	hash: string;
	body(): Promise<Uint8Array>;
}

export type TexEngine = "pdflatex" | "xelatex" | "lualatex";

export interface TexOutput {
	ok: boolean;
	ms: number;
	error?: string;
	log: string;
	pdf?: ArrayBuffer;
	synctex?: ArrayBuffer;
}

/**
 * The engine a document asks for: a `% !TEX program = …` line, as editors write it, or the
 * Unicode font packages that need XeLaTeX. Everything else gets pdfLaTeX.
 */
export function engineFor(main: string): TexEngine {
	const magic = main.match(/^%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im)?.[1]?.toLowerCase();
	if (magic === "xelatex" || magic === "lualatex" || magic === "pdflatex") return magic;
	if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math|polyglossia)\b/.test(main))
		return "xelatex";
	return "pdflatex";
}

/**
 * Compile on the project's container, sending only files whose hash it has not seen. `known`
 * is what the caller believes the container holds. A container that restarted holds nothing,
 * says which files it lacks, and gets them on a second request.
 */
export async function compileTex(
	box: { fetch(request: Request): Promise<Response> },
	request: { project: string; main: string; engine: TexEngine },
	files: TexFile[],
	known: Map<string, string>,
): Promise<{ output: TexOutput; known: Map<string, string> }> {
	const manifest = Object.fromEntries(files.map((f) => [f.path, f.hash]));
	const send = async (paths: Set<string>) => {
		const form = new FormData();
		form.set("request", JSON.stringify({ ...request, manifest }));
		for (const f of files) {
			if (paths.has(f.path)) form.append(f.path, new Blob([await f.body()]), f.path);
		}
		return box.fetch(new Request("http://texbox/compile", { method: "POST", body: form }));
	};

	let res = await send(
		new Set(files.filter((f) => known.get(f.path) !== f.hash).map((f) => f.path)),
	);
	if (res.status === 409) {
		const { missing } = await res.json<{ missing: string[] }>();
		res = await send(new Set(missing));
	}
	if (!res.ok) throw new Error(`The compile server answered ${res.status}: ${await res.text()}`);

	const form = await res.formData();
	const result = JSON.parse(String(form.get("result"))) as Omit<TexOutput, "log">;
	const file = async (name: string) => {
		const part = form.get(name);
		return part instanceof File ? await part.arrayBuffer() : undefined;
	};
	return {
		output: {
			...result,
			log: String(form.get("log") ?? ""),
			pdf: await file("pdf"),
			synctex: await file("synctex"),
		},
		known: new Map(Object.entries(manifest)),
	};
}
