import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { isPreference, resolveTheme, type ThemeId, type ThemePreference } from "./themes";

// index.html reads the same key to set the theme before first paint.
const KEY = "annomate:theme";

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

interface State {
	preference: ThemePreference;
	theme: ThemeId;
}

let state = compute(read());

function read(): ThemePreference {
	try {
		const stored = localStorage.getItem(KEY);
		if (isPreference(stored)) return stored;
	} catch {}
	return "system";
}

function compute(preference: ThemePreference): State {
	return { preference, theme: resolveTheme(preference, darkQuery.matches) };
}

function apply(next: State) {
	state = next;
	document.documentElement.dataset.theme = next.theme;
	for (const listener of listeners) listener();
}

apply(state);
darkQuery.addEventListener("change", () => apply(compute(state.preference)));
// Another tab changed the theme.
window.addEventListener("storage", (e) => e.key === KEY && apply(compute(read())));

export function setThemePreference(preference: ThemePreference) {
	try {
		if (preference === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, preference);
	} catch {}

	const next = compute(preference);
	if (next.theme === state.theme || !document.startViewTransition) {
		apply(next);
		return;
	}
	const root = document.documentElement;
	root.classList.add("theme-switching");
	// flushSync so React's re-render lands inside the "after" snapshot.
	const transition = document.startViewTransition(() => flushSync(() => apply(next)));
	transition.finished.finally(() => root.classList.remove("theme-switching"));
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useTheme(): State {
	return useSyncExternalStore(subscribe, () => state);
}
