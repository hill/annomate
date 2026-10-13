import { useEffect, useRef } from "react";

/**
 * Pages are shown as bitmaps, the way PDF.js and typst.app show theirs. A
 * bitmap costs the browser one image draw per frame, so pane resizes and
 * zooms stretch it for free, where the page's SVG would be re-recorded and
 * re-layered on every frame. The bitmap is redrawn at the new size once the
 * view holds still.
 */

/** A page's pixels per point snap to this step, so small size changes reuse the bitmap. */
const STEP = 0.25;
/** The largest bitmap per page, in pixels. Past it a page stays sharp only up to that size. */
const MAX_PIXELS = 2 ** 24;

/** Pixels per point to rasterise a page at, for its size on screen. */
export function resolution(width: number, height: number, scale: number): number {
	const wanted = Math.max(STEP, Math.round((scale * devicePixelRatio) / STEP) * STEP);
	return Math.min(wanted, Math.sqrt(MAX_PIXELS / (width * height)));
}

// One page draws at a time, so a burst of pages never stalls a single frame.
let queue: Promise<void> = Promise.resolve();
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

interface Props {
	image: HTMLImageElement;
	/** Page size in points. */
	width: number;
	height: number;
	/** Pixels per point to draw at. */
	density: number;
	/** Near the viewport. Pages away from it give up their bitmap. */
	near: boolean;
	/** The view is moving. A page with a bitmap keeps stretching it until the view settles. */
	moving: boolean;
}

export function PageCanvas({ image, width, height, density, near, moving }: Props) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const drawn = useRef<{ image: HTMLImageElement; density: number } | null>(null);

	useEffect(() => {
		const el = canvas.current;
		const ctx = el?.getContext("bitmaprenderer");
		if (!el || !ctx) return;
		if (!near) {
			if (drawn.current) ctx.transferFromImageBitmap(null);
			drawn.current = null;
			return;
		}
		const current = drawn.current;
		if (current?.image === image && current.density === density) return;
		if (current && moving) return;

		let cancelled = false;
		queue = queue.then(async () => {
			if (cancelled) return;
			const w = Math.max(1, Math.round(width * density));
			const h = Math.max(1, Math.round(height * density));
			const off = new OffscreenCanvas(w, h);
			off.getContext("2d")?.drawImage(image, 0, 0, w, h);
			if (cancelled) return;
			ctx.transferFromImageBitmap(off.transferToImageBitmap());
			drawn.current = { image, density };
			await nextFrame();
		});
		return () => {
			cancelled = true;
		};
	}, [image, width, height, density, near, moving]);

	return <canvas ref={canvas} />;
}
