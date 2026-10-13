import type { Diagnostic } from "../../shared/protocol";

export type { Diagnostic };

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
	/** A compile is running somewhere other than this tab, as LaTeX's does on the server. */
	busy?: boolean;
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
