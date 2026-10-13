import { CircleAlert, FileX2, Minus, Plus, TriangleAlert } from "lucide-react";
import {
	forwardRef,
	type ReactNode,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { Presence } from "../../shared/protocol";
import type { Room } from "../room/provider";
import { Problems, problemCount } from "./Problems";
import { type Rect, TextIndex } from "./sync";
import type { Engine } from "./types";

export interface PreviewHandle {
	/** Scroll to the rendered text for this source position and flash it. */
	reveal(source: string, offset: number): void;
}

interface Props {
	room: Room;
	engine: Engine;
	presence: Map<number, Presence>;
	following: number | null;
	/** Hold the current scale, while a pane is being resized. */
	frozen?: boolean;
	onDiagnostic(path: string, line: number): void;
	onJump(path: string, offset: number): void;
	sourceFiles(): { path: string; text: string }[];
	/** Where diagnostics without a path come from. */
	mainFile: string;
	/** Extra controls at the right of the pane header. */
	actions?: ReactNode;
}

const PAD_X = 24;
// Percentages are against print size, where one point is 96/72 CSS pixels.
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const Preview = forwardRef<PreviewHandle, Props>(function Preview(
	{
		room,
		engine,
		presence,
		following,
		frozen,
		onDiagnostic,
		onJump,
		sourceFiles,
		mainFile,
		actions,
	},
	ref,
) {
	const state = useSyncExternalStore(engine.subscribe, engine.getState);
	const scroller = useRef<HTMLDivElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const [boxWidth, setBoxWidth] = useState(0);
	const [zoom, setZoom] = useState(1);
	const [showDiags, setShowDiags] = useState(false);
	const [flash, setFlash] = useState<(Rect & { key: number }) | null>(null);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Refitting re-lays out the whole SVG, so it waits until a pane resize finishes.
	const fitRef = useRef(1);
	if (!frozen && state.width) fitRef.current = Math.max(0.1, (boxWidth - PAD_X * 2) / state.width);
	const fit = fitRef.current;
	const scale = fit * zoom;
	const scaleRef = useRef(scale);
	scaleRef.current = scale;

	// Text index, rebuilt lazily after each render. Rects are in points so zoom does not stale them.
	const index = useRef<TextIndex | null>(null);
	const doc = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		void state.version;
		if (doc.current) engine.mount(doc.current);
		index.current = null;
	}, [engine, state.version]);
	const getIndex = useCallback(() => {
		// A hidden pane measures as zero, which would cache useless positions.
		if (!doc.current || !stage.current?.offsetWidth) return null;
		index.current ??= new TextIndex(
			doc.current,
			stage.current,
			scaleRef.current,
			engine.textSelector,
		);
		return index.current;
	}, [engine]);

	// Zoom around a screen point, keeping the document point under it still.
	// While a gesture runs, the painted page is scaled with a CSS transform,
	// which the compositor does for free. The real re-layout happens once the
	// gesture settles.
	const anchor = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
	const live = useRef<{ zoom: number; timer: number; ox: number; oy: number } | null>(null);
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;

	const commitZoom = useCallback(
		(
			target: number,
			clientX?: number,
			clientY?: number,
			shown?: { ox: number; oy: number; f: number },
		) => {
			const el = scroller.current;
			const st = stage.current;
			if (!el || !st) return;
			const box = el.getBoundingClientRect();
			const sx = clientX === undefined ? box.width / 2 : clientX - box.left;
			const sy = clientY === undefined ? box.height / 2 : clientY - box.top;
			const s = scaleRef.current;
			// Point under the cursor in stage pixels, undoing any live transform the user is looking at.
			let px = el.scrollLeft + sx - st.offsetLeft;
			let py = el.scrollTop + sy - st.offsetTop;
			if (shown) {
				px = shown.ox + (px - shown.ox) / shown.f;
				py = shown.oy + (py - shown.oy) / shown.f;
			}
			anchor.current = { x: px / s, y: py / s, sx, sy };
			st.style.transform = "";
			setZoom(clamp(target, MIN_ZOOM, MAX_ZOOM));
		},
		[],
	);

	const zoomAt = useCallback(
		(next: (z: number) => number, clientX?: number, clientY?: number, gesture = false) => {
			const st = stage.current;
			const el = scroller.current;
			if (!gesture || !st || !el) {
				commitZoom(next(live.current?.zoom ?? zoomRef.current), clientX, clientY);
				return;
			}
			const target = clamp(next(live.current?.zoom ?? zoomRef.current), MIN_ZOOM, MAX_ZOOM);
			if (live.current) clearTimeout(live.current.timer);
			const rect = st.getBoundingClientRect();
			const factor = target / zoomRef.current;
			// Origin in the stage's own untransformed pixels.
			const ox = live.current?.ox ?? ((clientX ?? 0) - rect.left) / (rect.width / st.offsetWidth);
			const oy = live.current?.oy ?? ((clientY ?? 0) - rect.top) / (rect.height / st.offsetHeight);
			st.style.transformOrigin = `${ox}px ${oy}px`;
			st.style.transform = `scale(${factor})`;
			live.current = {
				zoom: target,
				ox,
				oy,
				timer: window.setTimeout(() => {
					live.current = null;
					commitZoom(target, clientX, clientY, { ox, oy, f: factor });
				}, 120),
			};
		},
		[commitZoom],
	);

	useLayoutEffect(() => {
		const a = anchor.current;
		const el = scroller.current;
		const st = stage.current;
		if (!a || !el || !st) return;
		anchor.current = null;
		el.scrollLeft = st.offsetLeft + a.x * scale - a.sx;
		el.scrollTop = st.offsetTop + a.y * scale - a.sy;
	}, [scale]);

	// Trackpad pinch arrives as ctrl+wheel. Safari also sends gesture events. Touch screens pinch with two fingers.
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if (!e.ctrlKey && !e.metaKey) return;
			e.preventDefault();
			// Trackpads send small deltas, mouse wheels send ~100 per notch. Cap a notch at about 1.3x.
			const delta = Math.max(-25, Math.min(25, e.deltaMode === 1 ? e.deltaY * 5 : e.deltaY));
			const factor = Math.exp(-delta * 0.01);
			zoomAt((z) => z * factor, e.clientX, e.clientY, true);
		};
		let gestureStart = 1;
		const onGestureStart = (e: Event) => {
			e.preventDefault();
			gestureStart = 1;
		};
		const onGestureChange = (e: Event) => {
			e.preventDefault();
			const g = e as Event & { scale: number; clientX: number; clientY: number };
			const factor = g.scale / gestureStart;
			gestureStart = g.scale;
			zoomAt((z) => z * factor, g.clientX, g.clientY, true);
		};
		let pinch: number | null = null;
		const distance = (t: TouchList) =>
			Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
		const onTouchMove = (e: TouchEvent) => {
			if (e.touches.length !== 2) return;
			e.preventDefault();
			const d = distance(e.touches);
			if (pinch) {
				const factor = d / pinch;
				const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
				const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
				zoomAt((z) => z * factor, cx, cy, true);
			}
			pinch = d;
		};
		const onTouchEnd = () => {
			pinch = null;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		el.addEventListener("gesturestart", onGestureStart);
		el.addEventListener("gesturechange", onGestureChange);
		el.addEventListener("touchmove", onTouchMove, { passive: false });
		el.addEventListener("touchend", onTouchEnd);
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("gesturestart", onGestureStart);
			el.removeEventListener("gesturechange", onGestureChange);
			el.removeEventListener("touchmove", onTouchMove);
			el.removeEventListener("touchend", onTouchEnd);
		};
	}, [zoomAt]);

	// Broadcast where our viewport sits, so others can follow us.
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		let frame = 0;
		const onScroll = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				room.setPresence({ view: { y: (el.scrollTop + el.clientHeight / 2) / scaleRef.current } });
			});
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			el.removeEventListener("scroll", onScroll);
			cancelAnimationFrame(frame);
		};
	}, [room]);

	const leaderY = following !== null ? presence.get(following)?.view?.y : undefined;
	useEffect(() => {
		const el = scroller.current;
		if (!el || leaderY === undefined) return;
		el.scrollTo({ top: leaderY * scaleRef.current - el.clientHeight / 2, behavior: "smooth" });
	}, [leaderY]);

	useImperativeHandle(ref, () => ({
		reveal(source, offset) {
			const rect = getIndex()?.fromSource(source, offset);
			const el = scroller.current;
			const st = stage.current;
			if (!rect || !el || !st) return;
			const s = scaleRef.current;
			const top = st.offsetTop + rect.y * s - el.clientHeight * 0.35;
			const visible =
				rect.y * s + st.offsetTop > el.scrollTop + 40 &&
				rect.y * s + st.offsetTop < el.scrollTop + el.clientHeight - 40;
			if (!visible) el.scrollTo({ top, behavior: "smooth" });
			setFlash({ ...rect, key: Date.now() });
		},
	}));

	// Pointer: share position, and a click (not a drag) jumps the editor to that text.
	const frame = useRef(0);
	const down = useRef<{ x: number; y: number } | null>(null);
	const toDoc = (e: React.PointerEvent) => {
		const rect = stage.current?.getBoundingClientRect();
		if (!rect) return null;
		return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
	};
	const onPointerMove = (e: React.PointerEvent) => {
		const p = toDoc(e);
		cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => room.setPresence({ pointer: p }));
	};
	const onPointerLeave = () => {
		cancelAnimationFrame(frame.current);
		room.setPresence({ pointer: null });
	};
	const onPointerDown = (e: React.PointerEvent) => {
		down.current = { x: e.clientX, y: e.clientY };
	};
	const onPointerUp = (e: React.PointerEvent) => {
		const start = down.current;
		down.current = null;
		if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
		if ((e.target as Element).closest("a")) return;
		if (window.getSelection()?.toString()) return;
		const p = toDoc(e);
		const idx = getIndex();
		if (!p || !idx) return;
		const run = idx.runAt(p.x, p.y);
		if (run === null) return;
		const hit = idx.toSource(run, p.x, sourceFiles());
		if (hit) {
			setFlash({ ...idx.rects[run], key: Date.now() });
			onJump(hit.path, hit.offset);
		}
	};

	const errors = state.diagnostics.filter((d) => d.severity === "error");
	const { warnings } = problemCount(state.diagnostics);
	const others = [...presence].filter(([id, p]) => id !== room.doc.clientID && p.pointer && p.user);

	return (
		<>
			<div className="pane-head">
				<span className="title">Preview</span>
				{state.diagnostics.length > 0 && (
					<button
						type="button"
						className={`diag-chip${errors.length ? "" : " warning"}`}
						onClick={() => setShowDiags(true)}
					>
						{errors.length ? <CircleAlert size={13} /> : <TriangleAlert size={13} />}
						{errors.length
							? `${errors.length} error${errors.length === 1 ? "" : "s"}`
							: `${warnings} warning${warnings === 1 ? "" : "s"}`}
					</button>
				)}
				<span className="spacer" />
				{state.busy ? (
					<span className="small muted compiling" style={{ marginRight: 8 }}>
						Compiling
					</span>
				) : (
					state.phase === "ready" &&
					state.compileMs > 0 && (
						<span className="small muted" style={{ marginRight: 8 }}>
							{state.compileMs >= 1000
								? `${(state.compileMs / 1000).toFixed(1)} s`
								: `${Math.round(state.compileMs)} ms`}
						</span>
					)
				)}
				<div className="zoom">
					<button
						type="button"
						className="btn ghost icon small"
						aria-label="Zoom out"
						onClick={() => zoomAt((z) => z / 1.2)}
					>
						<Minus size={14} />
					</button>
					<button type="button" className="pct" title="Fit width" onClick={() => zoomAt(() => 1)}>
						{Math.round((scale * 100 * 72) / 96)}%
					</button>
					<button
						type="button"
						className="btn ghost icon small"
						aria-label="Zoom in"
						onClick={() => zoomAt((z) => z * 1.2)}
					>
						<Plus size={14} />
					</button>
				</div>
				{actions}
			</div>

			{showDiags && state.diagnostics.length > 0 && (
				<Problems
					diagnostics={state.diagnostics}
					mainFile={mainFile}
					source={(path) => room.files.get(path)?.toString()}
					onOpen={(path, line) => {
						setShowDiags(false);
						onDiagnostic(path, line);
					}}
					onClose={() => setShowDiags(false)}
				/>
			)}

			<div className="preview-scroll" ref={scroller}>
				{state.version > 0 ? (
					// An explicit width: max-content would make the browser measure every text-layer element on each resize.
					<div
						style={{
							width: Math.max(boxWidth, state.width * scale + PAD_X * 2),
							padding: `20px ${PAD_X}px 60px`,
						}}
					>
						<div
							className="stage"
							ref={stage}
							style={{ width: state.width * scale, height: state.height * scale, margin: "0 auto" }}
							onPointerMove={onPointerMove}
							onPointerLeave={onPointerLeave}
							onPointerDown={onPointerDown}
							onPointerUp={onPointerUp}
						>
							{state.pages.map((p) => (
								<div
									key={p.top}
									className="sheet"
									style={{ top: p.top * scale, width: p.width * scale, height: p.height * scale }}
								/>
							))}
							<div className="doc" ref={doc} />
							{flash && (
								<div
									key={flash.key}
									className="sync-flash"
									style={{
										left: flash.x * scale - 4,
										top: flash.y * scale - 2,
										width: flash.w * scale + 8,
										height: flash.h * scale + 4,
									}}
								/>
							)}
							{others.map(([id, p]) => (
								<RemotePointer key={id} presence={p} scale={scale} />
							))}
						</div>
					</div>
				) : (
					<div className="empty">
						{state.phase === "failed" ? (
							<div>
								<div className="icon-tile">
									<FileX2 size={18} />
								</div>
								<h3>Preview failed</h3>
								<div>{state.error}</div>
							</div>
						) : state.phase === "loading" ? (
							<div className="loader" />
						) : (
							<div>
								<div className="icon-tile">
									<FileX2 size={18} />
								</div>
								<h3>Nothing to show</h3>
								<div>{errors[0]?.message}</div>
							</div>
						)}
					</div>
				)}
			</div>
		</>
	);
});

function RemotePointer({ presence, scale }: { presence: Presence; scale: number }) {
	const { x, y } = presence.pointer as { x: number; y: number };
	const { color, name, login } = presence.user;
	return (
		<div className="pointer" style={{ transform: `translate(${x * scale}px, ${y * scale}px)` }}>
			<svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true">
				<path
					d="M2 1.5 16 9.2l-6.3 1.7L6.4 17.6 2 1.5Z"
					fill={color}
					stroke="#fff"
					strokeWidth="1.5"
					strokeLinejoin="round"
				/>
			</svg>
			<span className="tag" style={{ background: color }}>
				{name || login}
			</span>
		</div>
	);
}
