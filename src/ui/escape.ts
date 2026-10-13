import { useEffect, useRef } from "react";

/**
 * Escape closes the topmost open layer and nothing under it. Layers register in the order they
 * open, and one capture listener hands Escape to the last. It marks the event handled with
 * preventDefault, which keyboard handlers further down check before acting on Escape themselves.
 */
const stack: { current: () => void }[] = [];

function onKey(e: KeyboardEvent) {
	if (e.key !== "Escape" || e.defaultPrevented) return;
	const top = stack.at(-1);
	if (!top) return;
	e.preventDefault();
	top.current();
}

export function useEscape(onEscape: () => void, active = true) {
	const handler = useRef(onEscape);
	handler.current = onEscape;
	useEffect(() => {
		if (!active) return;
		const entry = { current: () => handler.current() };
		stack.push(entry);
		if (stack.length === 1) addEventListener("keydown", onKey, true);
		return () => {
			stack.splice(stack.indexOf(entry), 1);
			if (!stack.length) removeEventListener("keydown", onKey, true);
		};
	}, [active]);
}
