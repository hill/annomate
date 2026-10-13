import {
	createTypstRenderer,
	type RenderSession,
	type TypstRenderer,
} from "@myriaddreamin/typst.ts/renderer";
import * as Y from "yjs";
import type { Room } from "../room/provider";
import { type Diagnostic, type Engine, type EngineState, PAGE_GAP, type Page } from "./types";
import type { WorkerRequest, WorkerResponse } from "./typst.worker";
import TypstWorker from "./typst.worker?worker";

const RENDERER_WASM =
	"https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.7.0/pkg/typst_ts_renderer_bg.wasm";

const DEBOUNCE_MS = 120;
const FONT = /\.(ttf|otf|ttc|otc)$/i;

/**
 * Compiles the room's files in a Web Worker and renders the result to SVG on
 * the main thread. Keeps the last good render on screen while there are errors.
 */
export class TypstEngine implements Engine {
	readonly textSelector = ".tsel";
	private svg: string | null = null;
	private worker = new TypstWorker();
	private renderer: TypstRenderer = createTypstRenderer();
	private session: RenderSession | null = null;
	private releaseSession: (() => void) | null = null;
	private nextId = 0;
	private latest = 0;
	private dirty = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private retry: ReturnType<typeof setTimeout> | undefined;
	private pdfWaiters = new Map<
		number,
		(r: { pdf?: Uint8Array; diagnostics: Diagnostic[] }) => void
	>();
	private loadedAssets = new Map<string, string>();
	private listeners = new Set<() => void>();
	private started = false;
	state: EngineState = {
		phase: "loading",
		pages: [],
		width: 0,
		height: 0,
		diagnostics: [],
		compileMs: 0,
		version: 0,
	};

	private entrySource: string | null = null;

	/**
	 * @param entry generates the file to compile from the main file, for documents Typst
	 *   typesets but does not read directly. It is compiled at `entry.path`, outside the project.
	 */
	constructor(
		private room: Room,
		private mainFile: () => string,
		private entry?: { path: string; source(main: string, paths: string[]): string },
	) {
		this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
	}

	/** The file to compile, posting a fresh entry first when the main file or template changed. */
	private target(): string {
		if (!this.entry) return this.mainFile();
		const paths = [...this.room.files.keys(), ...this.room.assets.keys()];
		const source = this.entry.source(this.mainFile(), paths);
		if (source !== this.entrySource) {
			this.entrySource = source;
			this.post({ type: "source", path: this.entry.path, text: source });
		}
		return this.entry.path;
	}

	/**
	 * Point problems in the generated entry, or in the packages it loads, at the main file. The
	 * person can only fix the document, so that is where the message belongs.
	 */
	private located(diagnostics: Diagnostic[]): Diagnostic[] {
		if (!this.entry) return diagnostics;
		return (
			diagnostics
				// Call frames inside the generated code say nothing the person can act on.
				.filter((d) => this.room.files.has(d.path) || !d.message.startsWith("while calling"))
				.map((d) =>
					this.room.files.has(d.path)
						? d
						: { ...d, path: this.mainFile(), line: null, endLine: null, column: 0, endColumn: 0 },
				)
		);
	}

	/** Call once the room has synced, so the asset list and files are known. */
	async start() {
		if (this.started) return;
		this.started = true;
		try {
			const [fonts] = await Promise.all([this.fetchFonts(), this.initRenderer()]);
			this.post({ type: "init", fonts });
			for (const [path, text] of this.room.files)
				this.post({ type: "source", path, text: text.toString() });
			await this.syncAssets();
			this.room.files.observeDeep(this.onFilesChanged);
			this.room.assets.observe(this.onAssetsChanged);
			this.compile();
		} catch (e) {
			this.set({ phase: "failed", error: String(e) });
		}
	}

	private async initRenderer() {
		await this.renderer.init({ getModule: () => RENDERER_WASM });
		// The session lives as long as the engine. runWithSession frees it when the callback settles.
		void this.renderer.runWithSession(
			(session) =>
				new Promise<void>((release) => {
					this.session = session;
					this.releaseSession = release;
				}),
		);
		while (!this.session) await new Promise((r) => setTimeout(r, 0));
	}

	private blobUrl(sha: string) {
		return `/api/projects/${this.room.projectId}/blob/${sha}`;
	}

	/** Fetch a repo file by blob sha, or null if the network or GitHub fails. */
	private async fetchBlob(sha: string): Promise<Uint8Array | null> {
		try {
			const res = await fetch(this.blobUrl(sha));
			return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
		} catch {
			return null;
		}
	}

	private async fetchFonts(): Promise<Uint8Array[]> {
		const fonts = [...this.room.assets].filter(([path]) => FONT.test(path));
		const loaded = await Promise.all(
			fonts.map(async ([path, { sha }]) => {
				const data = await this.fetchBlob(sha);
				if (data) this.loadedAssets.set(path, sha);
				return data;
			}),
		);
		return loaded.filter((d): d is Uint8Array => d !== null);
	}

	/**
	 * A file that fails to download is skipped so the rest still compiles,
	 * and tried again shortly after.
	 */
	private async syncAssets() {
		const wanted = [...this.room.assets].filter(
			([path, { sha }]) => !FONT.test(path) && this.loadedAssets.get(path) !== sha,
		);
		let failed = false;
		await Promise.all(
			wanted.map(async ([path, { sha }]) => {
				const data = await this.fetchBlob(sha);
				if (!data) {
					failed = true;
					return;
				}
				this.post({ type: "binary", path, data });
				this.loadedAssets.set(path, sha);
			}),
		);
		if (failed) {
			clearTimeout(this.retry);
			this.retry = setTimeout(() => void this.syncAssets().then(() => this.schedule()), 5000);
		}
		for (const path of this.loadedAssets.keys()) {
			if (!this.room.assets.has(path) && !FONT.test(path)) {
				this.post({ type: "remove", path });
				this.loadedAssets.delete(path);
			}
		}
	}

	private onFilesChanged = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		for (const event of events) {
			if (event.target === this.room.files) {
				for (const key of event.changes.keys.keys()) this.dirty.add(key);
			} else if (event.target instanceof Y.Text) {
				for (const [path, text] of this.room.files) if (text === event.target) this.dirty.add(path);
			}
		}
		this.schedule();
	};

	private onAssetsChanged = () => {
		void this.syncAssets().then(() => this.schedule());
	};

	private schedule() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
	}

	private flush() {
		for (const path of this.dirty) {
			const text = this.room.files.get(path);
			if (text) this.post({ type: "source", path, text: text.toString() });
			else this.post({ type: "remove", path });
		}
		this.dirty.clear();
		this.compile();
	}

	compile() {
		this.latest = ++this.nextId;
		this.post({ type: "compile", id: this.latest, main: this.target() });
	}

	async pdf(): Promise<{ pdf?: Uint8Array; diagnostics: Diagnostic[] }> {
		this.flush();
		const id = ++this.nextId;
		return new Promise((resolve) => {
			this.pdfWaiters.set(id, resolve);
			this.post({ type: "pdf", id, main: this.target() });
		});
	}

	/**
	 * Draw the first page of the last good render to a small image, for the
	 * project grid. Returns null before anything has rendered.
	 *
	 * It rasterises the SVG already on screen. The renderer's own canvas output
	 * holds the renderer, and so blocks the preview, until every image on the
	 * page loads, which can be never.
	 */
	async thumbnail(width = 480): Promise<Blob | null> {
		const { svg } = this;
		const { pages, width: docWidth, height: docHeight } = this.state;
		const page = pages[0];
		if (!svg || !page) return null;
		const template = document.createElement("template");
		template.innerHTML = svg;
		const root = template.content.querySelector("svg");
		if (!root) return null;
		// The selectable text layer is HTML in foreignObject, which taints the canvas. The glyphs are paths.
		for (const fo of root.querySelectorAll("foreignObject")) fo.remove();
		// An image source must be strict XML, which the stored markup is not.
		const xml = new XMLSerializer().serializeToString(root);
		const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
		try {
			const img = new Image();
			img.src = url;
			await img.decode();
			const scale = width / page.width;
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(page.width * scale);
			canvas.height = Math.round(page.height * scale);
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(img, 0, -page.top * scale, docWidth * scale, docHeight * scale);
			return await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	private post(msg: WorkerRequest) {
		const transfer =
			msg.type === "binary"
				? [msg.data.buffer]
				: msg.type === "init"
					? msg.fonts.map((f) => f.buffer)
					: [];
		this.worker.postMessage(msg, transfer as Transferable[]);
	}

	private async onMessage(msg: WorkerResponse) {
		if (msg.type === "fatal") return this.set({ phase: "failed", error: msg.message });
		if (msg.type === "pdf") {
			this.pdfWaiters.get(msg.id)?.({ pdf: msg.pdf, diagnostics: this.located(msg.diagnostics) });
			this.pdfWaiters.delete(msg.id);
			return;
		}
		if (msg.type !== "compiled" || msg.id !== this.latest) return;
		const diagnostics = this.located(msg.diagnostics);
		if (!msg.vector || !this.session) {
			return this.set({ phase: "ready", diagnostics, compileMs: msg.ms });
		}
		this.renderer.manipulateData({
			renderSession: this.session,
			action: "reset",
			data: msg.vector,
		});
		const raw = await this.renderer.renderSvg({ renderSession: this.session });
		if (msg.id !== this.latest) return;
		const { svg, ...size } = layout(raw);
		this.svg = svg;
		this.set({
			phase: "ready",
			diagnostics,
			compileMs: msg.ms,
			version: this.state.version + 1,
			...size,
		});
	}

	mount(el: HTMLElement) {
		if (this.svg !== null && el.dataset.version !== String(this.state.version)) {
			el.innerHTML = this.svg;
			el.dataset.version = String(this.state.version);
		}
	}

	private set(patch: Partial<EngineState>) {
		this.state = { ...this.state, ...patch };
		for (const l of this.listeners) l();
	}

	subscribe = (l: () => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};

	getState = () => this.state;

	destroy() {
		clearTimeout(this.timer);
		clearTimeout(this.retry);
		if (this.started) {
			this.room.files.unobserveDeep(this.onFilesChanged);
			this.room.assets.unobserve(this.onAssetsChanged);
		}
		this.releaseSession?.();
		this.worker.terminate();
	}
}

/**
 * typst.ts stacks pages edge to edge. Spread them apart by PAGE_GAP so each
 * reads as a sheet, and report where each one sits.
 */
function layout(raw: string): { svg: string; pages: Page[]; width: number; height: number } {
	// The renderer's output is not strict XML, so it goes through the forgiving HTML parser.
	const template = document.createElement("template");
	template.innerHTML = raw;
	const svg = template.content.querySelector("svg");
	if (!svg) return { svg: raw, pages: [], width: 0, height: 0 };
	const pages: Page[] = [];
	let top = 0;
	let width = 0;
	for (const g of svg.querySelectorAll("g.typst-page")) {
		const w = Number(g.getAttribute("data-page-width"));
		const h = Number(g.getAttribute("data-page-height"));
		g.setAttribute("transform", `translate(0, ${top})`);
		pages.push({ top, width: w, height: h });
		width = Math.max(width, w);
		top += h + PAGE_GAP;
	}
	const height = Math.max(0, top - PAGE_GAP);
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.removeAttribute("width");
	svg.removeAttribute("height");
	svg.setAttribute("preserveAspectRatio", "xMidYMin meet");
	return { svg: svg.outerHTML, pages, width, height };
}
