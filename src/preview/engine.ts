import {
	createTypstRenderer,
	type RenderSession,
	type TypstRenderer,
} from "@myriaddreamin/typst.ts/renderer";
import * as Y from "yjs";
import type { Room } from "../room/provider";
import type { Diagnostic, WorkerRequest, WorkerResponse } from "./typst.worker";
import TypstWorker from "./typst.worker?worker";

const RENDERER_WASM =
	"https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.7.0/pkg/typst_ts_renderer_bg.wasm";

/** Space between pages in the preview, in points. Pointer positions are shared in this layout. */
export const PAGE_GAP = 16;
const DEBOUNCE_MS = 120;
const FONT = /\.(ttf|otf|ttc|otc)$/i;

export interface Page {
	top: number;
	width: number;
	height: number;
	/** The page drawn as a standalone SVG image, decoded and ready to rasterise. */
	image: HTMLImageElement;
	/** SVG markup of the page's selectable text layer and links, with nothing drawn. */
	text: string;
}

export interface EngineState {
	phase: "loading" | "ready" | "failed";
	/** typst.ts's stylesheet for the text layers, as an SVG of no size. Null until the first render. */
	styles: string | null;
	pages: Page[];
	width: number;
	height: number;
	diagnostics: Diagnostic[];
	compileMs: number;
	error?: string;
}

/**
 * Compiles the room's files in a Web Worker and renders the result to SVG on
 * the main thread. Keeps the last good render on screen while there are errors.
 */
export class Engine {
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
	/** The current page images, by their markup, so an unchanged page keeps its image. */
	private images = new Map<string, HTMLImageElement>();
	private listeners = new Set<() => void>();
	private started = false;
	state: EngineState = {
		phase: "loading",
		styles: null,
		pages: [],
		width: 0,
		height: 0,
		diagnostics: [],
		compileMs: 0,
	};

	constructor(
		private room: Room,
		private mainFile: () => string,
	) {
		this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
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
		this.post({ type: "compile", id: this.latest, main: this.mainFile() });
	}

	async pdf(): Promise<{ pdf?: Uint8Array; diagnostics: Diagnostic[] }> {
		this.flush();
		const id = ++this.nextId;
		return new Promise((resolve) => {
			this.pdfWaiters.set(id, resolve);
			this.post({ type: "pdf", id, main: this.mainFile() });
		});
	}

	/**
	 * Draw the first page of the last good render to a small image, for the
	 * project grid. Returns null before anything has rendered.
	 *
	 * It rasterises the page image the preview draws from. The renderer's own
	 * canvas output holds the renderer, and so blocks the preview, until every
	 * image on the page loads, which can be never.
	 */
	async thumbnail(width = 480): Promise<Blob | null> {
		const page = this.state.pages[0];
		if (!page) return null;
		const img = page.image;
		const scale = width / page.width;
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(page.width * scale);
		canvas.height = Math.round(page.height * scale);
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
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
			this.pdfWaiters.get(msg.id)?.(msg);
			this.pdfWaiters.delete(msg.id);
			return;
		}
		if (msg.type !== "compiled" || msg.id !== this.latest) return;
		if (!msg.vector || !this.session) {
			return this.set({ phase: "ready", diagnostics: msg.diagnostics, compileMs: msg.ms });
		}
		this.renderer.manipulateData({
			renderSession: this.session,
			action: "reset",
			data: msg.vector,
		});
		const raw = await this.renderer.renderSvg({ renderSession: this.session });
		if (msg.id !== this.latest) return;
		const split = layout(raw);
		const previous = this.images;
		this.images = new Map();
		const pages = await Promise.all(
			split.pages.map(async ({ picture, ...page }) => {
				let image = previous.get(picture) ?? this.images.get(picture);
				if (!image) {
					image = new Image();
					image.src = URL.createObjectURL(new Blob([picture], { type: "image/svg+xml" }));
					this.images.set(picture, image);
					// Decoded before it is shown, so a recompile never flashes an empty sheet.
					await image.decode().catch(() => {});
				}
				this.images.set(picture, image);
				return { ...page, image };
			}),
		);
		for (const [picture, image] of previous)
			if (!this.images.has(picture)) URL.revokeObjectURL(image.src);
		if (msg.id !== this.latest) return;
		this.set({
			phase: "ready",
			diagnostics: msg.diagnostics,
			compileMs: msg.ms,
			styles: split.styles,
			width: split.width,
			height: split.height,
			pages,
		});
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
		for (const image of this.images.values()) URL.revokeObjectURL(image.src);
	}
}

interface Split {
	styles: string | null;
	width: number;
	height: number;
	pages: (Omit<Page, "image"> & { picture: string })[];
}

/**
 * typst.ts renders every page into one SVG. Each page is a few thousand glyph
 * elements, and as live DOM the browser re-records and re-layers all of them on
 * any frame where something on screen moves, which stalls resizes and
 * animations. So each page is drawn as an image of its own SVG, which the
 * browser paints as one item and rasterises off the main thread, at full
 * sharpness for any size. Over it sits the page with only its text layer and
 * links, for selection, links and click-to-sync. Pages stack PAGE_GAP apart so
 * each reads as a sheet.
 */
function layout(raw: string): Split {
	// The renderer's output is not strict XML, so it goes through the forgiving HTML parser.
	const template = document.createElement("template");
	template.innerHTML = raw;
	const svg = template.content.querySelector("svg");
	if (!svg) return { styles: null, pages: [], width: 0, height: 0 };
	svg.removeAttribute("width");
	svg.removeAttribute("height");
	const defined = new Map<string, Element>();
	for (const el of svg.querySelectorAll(":scope > defs > [id]")) defined.set(el.id, el);
	const styles = [...svg.querySelectorAll(":scope > style")];
	const xml = new XMLSerializer();

	const pages: Split["pages"] = [];
	let top = 0;
	let width = 0;
	for (const g of svg.querySelectorAll(":scope > g.typst-page")) {
		const w = Number(g.getAttribute("data-page-width"));
		const h = Number(g.getAttribute("data-page-height"));
		g.removeAttribute("transform");

		// The image: everything drawn, with the definitions this page uses. The text
		// layer is HTML in foreignObject, which an image cannot hold.
		const drawn = g.cloneNode(true) as Element;
		for (const el of drawn.querySelectorAll("foreignObject")) el.remove();
		const defs = document.createElementNS(SVG_NS, "defs");
		const wanted = [...references(drawn)];
		const seen = new Set(wanted);
		for (let i = 0; i < wanted.length; i++) {
			const el = defined.get(wanted[i])?.cloneNode(true) as Element | undefined;
			if (!el) continue;
			defs.append(el);
			// A definition can itself refer to others, such as a glyph drawn with a clip.
			for (const id of references(el)) {
				if (seen.has(id)) continue;
				seen.add(id);
				wanted.push(id);
			}
		}
		const picture = document.createElementNS(SVG_NS, "svg");
		picture.setAttribute("width", String(w));
		picture.setAttribute("height", String(h));
		picture.setAttribute("viewBox", `0 0 ${w} ${h}`);
		picture.append(...styles.map((s) => s.cloneNode(true)), defs, drawn);

		// The text layer: the same page with every drawing element taken out.
		for (const el of g.querySelectorAll("use, path, image")) el.remove();
		const text = svg.cloneNode(false) as Element;
		text.setAttribute("viewBox", `0 0 ${w} ${h}`);
		text.append(g);

		pages.push({
			top,
			width: w,
			height: h,
			picture: xml.serializeToString(picture),
			text: text.outerHTML,
		});
		width = Math.max(width, w);
		top += h + PAGE_GAP;
	}
	const sheet = svg.cloneNode(false) as Element;
	sheet.setAttribute("class", "typst-styles");
	sheet.setAttribute("aria-hidden", "true");
	sheet.append(...styles);
	return { styles: sheet.outerHTML, pages, width, height: Math.max(0, top - PAGE_GAP) };
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Ids a drawing refers to, through use elements and url(#id) paint and clip references. */
function references(root: Element): Set<string> {
	const ids = new Set<string>();
	const all = [root, ...root.querySelectorAll("*")];
	for (const el of all.filter((el) => el.localName === "use")) {
		const href = el.getAttribute("href") ?? el.getAttributeNS(XLINK_NS, "href");
		if (href?.startsWith("#")) ids.add(href.slice(1));
	}
	for (const el of all) {
		for (const name of ["clip-path", "fill", "stroke", "mask"]) {
			const m = /url\(#([^)]+)\)/.exec(el.getAttribute(name) ?? "");
			if (m) ids.add(m[1]);
		}
	}
	return ids;
}
