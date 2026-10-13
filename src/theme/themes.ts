import { type LucideIcon, Moon, Sun } from "lucide-react";

export interface Theme {
	/** Matches a `[data-theme="<id>"]` block of colour tokens in styles.css. */
	id: string;
	label: string;
	icon: LucideIcon;
}

export const THEMES = [
	{ id: "light", label: "Light", icon: Sun },
	{ id: "dark", label: "Dark", icon: Moon },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof THEMES)[number]["id"];

/** "system" follows the OS appearance through `SYSTEM_THEMES`. */
export type ThemePreference = ThemeId | "system";

// The inline script in index.html repeats this mapping, because it runs before any module loads.
export const SYSTEM_THEMES: Record<"light" | "dark", ThemeId> = { light: "light", dark: "dark" };

export function isPreference(value: unknown): value is ThemePreference {
	return value === "system" || THEMES.some((t) => t.id === value);
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ThemeId {
	if (preference !== "system") return preference;
	return SYSTEM_THEMES[prefersDark ? "dark" : "light"];
}
