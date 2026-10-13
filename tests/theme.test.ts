import { describe, expect, test } from "vitest";
import { isPreference, resolveTheme } from "../src/theme/themes";

describe("resolveTheme", () => {
	test("follows the OS for the system preference", () => {
		expect(resolveTheme("system", false)).toBe("light");
		expect(resolveTheme("system", true)).toBe("dark");
	});

	test("ignores the OS for an explicit theme", () => {
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
	});
});

describe("isPreference", () => {
	test("accepts system and every registered theme", () => {
		for (const id of ["system", "light", "dark"]) expect(isPreference(id)).toBe(true);
	});

	test("rejects anything else", () => {
		for (const value of [null, "", "sepia", 1]) expect(isPreference(value)).toBe(false);
	});
});
