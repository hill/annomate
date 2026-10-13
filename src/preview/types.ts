/** A compiler message, located by zero-based line and column in a project file. */
export interface Diagnostic {
	/** Project-relative path, or empty when the compiler named no file. */
	path: string;
	severity: "error" | "warning" | "info";
	message: string;
	/** Null when the compiler gave no position. */
	line: number | null;
	column: number;
	endLine: number | null;
	endColumn: number;
}

export interface Page {
	top: number;
	width: number;
	height: number;
}

export interface EngineState {
	phase: "loading" | "ready" | "failed";
	/** Pages stacked top to bottom, PAGE_GAP apart, in points. */
	pages: Page[];
	width: number;
	height: number;
	diagnostics: Diagnostic[];
	compileMs: number;
	/** Bumps on every successful render, so views know to redraw. */
	version: number;
	error?: string;
}

/** Space between pages in the preview, in points. Pointer positions are shared in this layout. */
export const PAGE_GAP = 16;

/**
 * Turns a project into pages. Every engine lays its pages out in points with the same gap, so
 * presence, follow mode and pointers work the same whatever compiled the document.
 */
export interface Engine {
	/** Call once the room has synced, so the files and assets are known. */
	start(): Promise<void>;
	compile(): void;
	subscribe(listener: () => void): () => void;
	getState(): EngineState;
	/** Draw the latest render into `el`, which is sized to the document in points. */
	mount(el: HTMLElement): void;
	/** The CSS selector for the renderer's selectable text runs, which source sync aligns against. */
	textSelector: string;
	pdf(): Promise<{ pdf?: Uint8Array; diagnostics: Diagnostic[] }>;
	/** The first page as a small image, for the project grid. Null before anything renders. */
	thumbnail(width?: number): Promise<Blob | null>;
	destroy(): void;
}
