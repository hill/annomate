import {
	GlobalWorkerOptions,
	getDocument,
	type PDFDocumentLoadingTask,
	type PDFDocumentProxy,
	type PDFPageProxy,
	TextLayer,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Room } from "../room/provider";
import { type Engine, type EngineState, PAGE_GAP, type Page } from "./types";

GlobalWorkerOptions.workerSrc = workerUrl;

// Redraw this long after the last zoom or resize, rather than on every frame of a pinch.
const REDRAW_MS = 150;
// Draw pages this far outside the visible area, so scrolling meets drawn pages.
const MARGIN = "100%";

/**
 * Shows a LaTeX project's PDF. The room compiles it on the server and announces each result;
 * this fetches the PDF, lays its pages out in points like the Typst engine, and draws them with
 * pdf.js. Text layers go on every page at once, because source sync searches all the text.
 * Page images are drawn only as they come into view.
 */
export class PdfEngine implements Engine {
	readonly textSelector = ".textLayer span";
	private pdfDoc: PDFDocumentProxy | null = null;
	private task: PDFDocumentLoadingTask | null = null;
	private bytes: Uint8Array | null = null;
	private shown: number | null = null;
	private seen = 0;
	private listeners = new Set<() => void>();
	private unsubscribe: (() => void) | null = null;
	private el: HTMLElement | null = null;
	private resize: ResizeObserver | null = null;
	private visible: IntersectionObserver | null = null;
	private drawn = new Map<number, number>();
	private drawnWidth = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private state: EngineState = {
		phase: "loading",
		pages: [],
		width: 0,
		height: 0,
		diagnostics: [],
		compileMs: 0,
		version: 0,
	};

	constructor(private room: Room) {}

	async start() {
		if (this.unsubscribe) return;
		this.unsubscribe = this.room.subscribe(this.onRoom);
		this.onRoom();
	}

	private onRoom = () => {
		const { tex, texBusy } = this.room.getSnapshot();
		if (texBusy !== this.state.busy) this.set({ busy: texBusy });
		if (!tex || tex.n === this.seen) return;
		this.seen = tex.n;
		this.set({
			diagnostics: tex.diagnostics,
			compileMs: tex.ms,
			phase: tex.pdf === null ? "ready" : this.state.phase,
		});
		if (tex.pdf !== null && tex.pdf !== this.shown) void this.load(tex.pdf);
	};

	private async load(n: number) {
		try {
			const res = await fetch(`/api/projects/${this.room.projectId}/tex/${n}/pdf`);
			if (!res.ok) throw new Error(`The PDF did not load (${res.status})`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			// pdf.js takes ownership of the buffer it is given.
			const task = getDocument({ data: bytes.slice() });
			const pdfDoc = await task.promise;
			if (this.room.getSnapshot().tex?.pdf !== n) return void task.destroy();
			const pages: Page[] = [];
			let top = 0;
			let width = 0;
			for (let i = 1; i <= pdfDoc.numPages; i++) {
				const view = (await pdfDoc.getPage(i)).getViewport({ scale: 1 });
				pages.push({ top, width: view.width, height: view.height });
				width = Math.max(width, view.width);
				top += view.height + PAGE_GAP;
			}
			void this.task?.destroy();
			this.task = task;
			this.pdfDoc = pdfDoc;
			this.bytes = bytes;
			this.shown = n;
			this.drawn.clear();
			this.set({
				phase: "ready",
				pages,
				width,
				height: Math.max(0, top - PAGE_GAP),
				version: this.state.version + 1,
			});
		} catch (e) {
			if (!this.state.version) this.set({ phase: "failed", error: String(e) });
		}
	}

	mount(el: HTMLElement) {
		if (this.el !== el) {
			this.resize?.disconnect();
			this.el = el;
			this.resize = new ResizeObserver(() => this.redrawSoon());
			this.resize.observe(el);
		}
		this.layoutPages();
	}

	private redrawSoon() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.layoutPages(), REDRAW_MS);
	}

	/** Build one box per page, sized in CSS pixels for the element's current width. */
	private layoutPages() {
		const { el, pdfDoc } = this;
		const { pages, width, version } = this.state;
		if (!el || !pdfDoc || !width || !el.clientWidth) return;
		if (el.dataset.version === String(version) && this.drawnWidth === el.clientWidth) return;
		el.dataset.version = String(version);
		this.drawnWidth = el.clientWidth;
		const scale = el.clientWidth / width;

		this.visible?.disconnect();
		this.visible = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting)
						void this.drawPage(Number((entry.target as HTMLElement).dataset.page));
				}
			},
			{ rootMargin: MARGIN },
		);
		this.drawn.clear();
		el.replaceChildren(
			...pages.map((page, i) => {
				const box = document.createElement("div");
				box.className = "pdf-page";
				box.dataset.page = String(i + 1);
				Object.assign(box.style, {
					top: `${page.top * scale}px`,
					width: `${page.width * scale}px`,
					height: `${page.height * scale}px`,
				});
				this.visible?.observe(box);
				void this.drawText(i + 1, box, scale);
				return box;
			}),
		);
	}

	private async drawText(n: number, box: HTMLElement, scale: number) {
		const page = await this.pdfDoc?.getPage(n);
		if (!page || !box.isConnected) return;
		const layer = document.createElement("div");
		layer.className = "textLayer";
		layer.style.setProperty("--total-scale-factor", String(scale));
		box.append(layer);
		await new TextLayer({
			textContentSource: page.streamTextContent(),
			container: layer,
			viewport: page.getViewport({ scale }),
		}).render();
	}

	private async drawPage(n: number) {
		const width = this.drawnWidth;
		if (this.drawn.get(n) === width) return;
		this.drawn.set(n, width);
		const page = await this.pdfDoc?.getPage(n);
		const box = this.el?.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`);
		if (!page || !box) return;
		const scale = width / this.state.width;
		const canvas = await draw(page, scale * devicePixelRatio);
		if (!canvas || !box.isConnected || this.drawnWidth !== width) return;
		canvas.style.width = "100%";
		canvas.style.height = "100%";
		box.querySelector("canvas")?.remove();
		box.prepend(canvas);
	}

	compile() {
		this.room.send({ t: "tex.compile" });
	}

	async pdf() {
		return { pdf: this.bytes?.slice(), diagnostics: this.state.diagnostics };
	}

	async thumbnail(width = 480): Promise<Blob | null> {
		const page = await this.pdfDoc?.getPage(1);
		const first = this.state.pages[0];
		if (!page || !first) return null;
		const canvas = await draw(page, width / first.width);
		if (!canvas) return null;
		return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
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
		this.unsubscribe?.();
		this.resize?.disconnect();
		this.visible?.disconnect();
		if (this.timer) clearTimeout(this.timer);
		void this.task?.destroy();
	}
}

async function draw(page: PDFPageProxy, scale: number): Promise<HTMLCanvasElement | null> {
	const viewport = page.getViewport({ scale });
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(viewport.width);
	canvas.height = Math.round(viewport.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	await page.render({ canvas, canvasContext: ctx, viewport }).promise;
	return canvas;
}
