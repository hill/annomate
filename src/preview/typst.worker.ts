/// <reference lib="webworker" />
import { createTypstCompiler, type TypstCompiler } from "@myriaddreamin/typst.ts/compiler";
import { MemoryAccessModel } from "@myriaddreamin/typst.ts/fs/memory";
import { FetchPackageRegistry } from "@myriaddreamin/typst.ts/fs/package";
import {
	loadFonts,
	withAccessModel,
	withPackageRegistry,
} from "@myriaddreamin/typst.ts/options.init";
import type { Diagnostic } from "./types";

// The compiler WASM is 28 MB, over the Workers static asset limit, so it comes from the npm CDN.
const COMPILER_WASM =
	"https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.7.0/pkg/typst_ts_web_compiler_bg.wasm";

export type WorkerRequest =
	| { type: "init"; fonts: Uint8Array[] }
	| { type: "source"; path: string; text: string }
	| { type: "binary"; path: string; data: Uint8Array }
	| { type: "remove"; path: string }
	| { type: "compile"; id: number; main: string }
	| { type: "pdf"; id: number; main: string };

export type WorkerResponse =
	| { type: "ready" }
	| { type: "compiled"; id: number; vector?: Uint8Array; diagnostics: Diagnostic[]; ms: number }
	| { type: "pdf"; id: number; pdf?: Uint8Array; diagnostics: Diagnostic[] }
	| { type: "fatal"; message: string };

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
	self.postMessage(msg, transfer);

let compiler: TypstCompiler | null = null;
const encoder = new TextEncoder();
const abs = (path: string) => `/${path.replace(/^\/+/, "")}`;

async function init(fonts: Uint8Array[]) {
	const c = createTypstCompiler();
	const am = new MemoryAccessModel();
	await c.init({
		getModule: () => COMPILER_WASM,
		beforeBuild: [
			loadFonts(fonts, { assets: ["text"] }),
			withAccessModel(am),
			withPackageRegistry(new FetchPackageRegistry(am)),
		],
	});
	compiler = c;
	post({ type: "ready" });
}

interface TypstDiagnostic {
	path?: string;
	range?: string;
	severity?: string;
	message?: string;
}

function normalise(diagnostics: unknown[] | undefined): Diagnostic[] {
	return (diagnostics ?? []).map((d) => {
		const x = d as TypstDiagnostic;
		return {
			path: (x.path ?? "").replace(/^\/+/, ""),
			severity: x.severity === "warning" ? "warning" : "error",
			message: x.message ?? String(d),
			...parseRange(x.range ?? ""),
		};
	});
}

/** Typst reports zero-based `line:col-line:col`, or sometimes just a line. */
export function parseRange(range: string) {
	const full = range.match(/^(\d+):(\d+)-(\d+):(\d+)/);
	if (full) {
		const [line, column, endLine, endColumn] = full.slice(1).map(Number);
		return { line, column, endLine, endColumn };
	}
	const line = range.match(/^(\d+)/);
	if (line) return { line: Number(line[1]), column: 0, endLine: Number(line[1]), endColumn: 0 };
	return { line: null, column: 0, endLine: null, endColumn: 0 };
}

const failure = (path: string, e: unknown): Diagnostic => ({
	path,
	severity: "error",
	message: String(e),
	line: null,
	column: 0,
	endLine: null,
	endColumn: 0,
});

async function handle(msg: WorkerRequest) {
	if (msg.type === "init")
		return init(msg.fonts).catch((e) => post({ type: "fatal", message: String(e) }));
	if (!compiler) return;
	switch (msg.type) {
		case "source":
			if (msg.path.endsWith(".typ")) compiler.addSource(abs(msg.path), msg.text);
			else compiler.mapShadow(abs(msg.path), encoder.encode(msg.text));
			return;
		case "binary":
			return compiler.mapShadow(abs(msg.path), msg.data);
		case "remove":
			return compiler.unmapShadow(abs(msg.path));
		case "compile": {
			const started = performance.now();
			try {
				const out = await compiler.compile({ mainFilePath: abs(msg.main), diagnostics: "full" });
				const vector = out.result;
				post(
					{
						type: "compiled",
						id: msg.id,
						vector,
						diagnostics: normalise(out.diagnostics),
						ms: performance.now() - started,
					},
					vector ? [vector.buffer] : [],
				);
			} catch (e) {
				post({
					type: "compiled",
					id: msg.id,
					diagnostics: [failure(msg.main, e)],
					ms: 0,
				});
			}
			return;
		}
		case "pdf": {
			try {
				const out = await compiler.compile({
					mainFilePath: abs(msg.main),
					format: 1,
					diagnostics: "full",
				});
				post(
					{ type: "pdf", id: msg.id, pdf: out.result, diagnostics: normalise(out.diagnostics) },
					out.result ? [out.result.buffer] : [],
				);
			} catch (e) {
				post({
					type: "pdf",
					id: msg.id,
					diagnostics: [failure(msg.main, e)],
				});
			}
		}
	}
}

// Requests run strictly in order, so a compile always sees every edit sent before it.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	queue = queue.then(() => handle(event.data));
};
