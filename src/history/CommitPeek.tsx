import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cachedCommit, loadCommit } from "./commits";
import { Counts, Snippet, StatusBadge } from "./FileDiff";

const OPEN_DELAY = 350;
// Long enough to cross the gap between two rows without the card closing and reopening.
const CLOSE_DELAY = 80;
const WIDTH = 380;
const GAP = 8;
const MAX_FILES = 4;

export interface Peek {
	sha: string;
	anchor: DOMRect;
}

/**
 * Hover intent for a list of rows. The first card waits for the pointer to settle. Once one is
 * open, moving to another row swaps it at once, the way tooltips behave.
 */
export function usePeek(disabledFor: string | null) {
	const [peek, setPeek] = useState<Peek | null>(null);
	const open = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

	const show = useCallback((sha: string, el: HTMLElement) => {
		clearTimeout(timer.current);
		const anchor = el.getBoundingClientRect();
		// No room beside the drawer on a narrow screen.
		if (anchor.left < WIDTH + GAP * 2) return;
		const apply = () => {
			open.current = true;
			setPeek({ sha, anchor });
		};
		if (open.current) apply();
		else timer.current = setTimeout(apply, OPEN_DELAY);
	}, []);

	const hide = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			open.current = false;
			setPeek(null);
		}, CLOSE_DELAY);
	}, []);

	const dismiss = useCallback(() => {
		clearTimeout(timer.current);
		open.current = false;
		setPeek(null);
	}, []);

	// The anchor rect goes stale once the list scrolls.
	useEffect(() => {
		addEventListener("scroll", dismiss, true);
		return () => {
			removeEventListener("scroll", dismiss, true);
			clearTimeout(timer.current);
		};
	}, [dismiss]);

	const rowProps = (sha: string) => ({
		onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
			if (e.pointerType === "mouse" && sha !== disabledFor) show(sha, e.currentTarget);
		},
		onPointerLeave: hide,
	});

	return { peek: peek?.sha === disabledFor ? null : peek, rowProps, dismiss };
}

export function CommitPeek({ projectId, peek }: { projectId: string; peek: Peek }) {
	const [detail, setDetail] = useState(() => cachedCommit(projectId, peek.sha));
	const [error, setError] = useState(false);
	const card = useRef<HTMLDivElement>(null);
	const [top, setTop] = useState(peek.anchor.top);

	useEffect(() => {
		let live = true;
		setDetail(cachedCommit(projectId, peek.sha));
		setError(false);
		loadCommit(projectId, peek.sha).then(
			(d) => live && setDetail(d),
			() => live && setError(true),
		);
		return () => {
			live = false;
		};
	}, [projectId, peek.sha]);

	// Line the card up with its row, but keep it on screen. Its height changes as the commit
	// loads, so measure on every resize.
	useLayoutEffect(() => {
		const el = card.current;
		if (!el) return;
		const place = () =>
			setTop(Math.max(GAP, Math.min(peek.anchor.top - 6, innerHeight - el.offsetHeight - GAP)));
		place();
		const observer = new ResizeObserver(place);
		observer.observe(el);
		return () => observer.disconnect();
	}, [peek.anchor]);

	const files = detail?.files ?? [];
	const first = files.find((f) => f.patch);

	return createPortal(
		<div
			ref={card}
			className="peek"
			role="tooltip"
			style={{ top, left: peek.anchor.left - WIDTH - GAP, width: WIDTH }}
		>
			{error ? (
				<div className="peek-note">Could not load this commit</div>
			) : !detail ? (
				<div className="peek-note">
					<div className="loader" />
				</div>
			) : files.length === 0 ? (
				<div className="peek-note">No file changes</div>
			) : (
				<>
					<ul className="peek-files">
						{files.slice(0, MAX_FILES).map((f) => {
							const slash = f.path.lastIndexOf("/") + 1;
							return (
								<li key={f.path}>
									<StatusBadge status={f.status} />
									<span className="path mono">
										<span className="dir">{f.path.slice(0, slash)}</span>
										{f.path.slice(slash)}
									</span>
									<Counts additions={f.additions} deletions={f.deletions} />
								</li>
							);
						})}
						{files.length > MAX_FILES && (
							<li className="more">
								{files.length - MAX_FILES} more file{files.length - MAX_FILES === 1 ? "" : "s"}
							</li>
						)}
					</ul>
					{first && <Snippet file={first} />}
				</>
			)}
		</div>,
		document.body,
	);
}
