import { describe, expect, test } from "vitest";
import { references } from "../src/editor/references";

describe("references", () => {
	test("images in markup and code", () => {
		expect(references("main.typ", ["images/a.png"], false)).toBe('#image("images/a.png")');
		expect(references("main.typ", ["images/a.png"], true)).toBe('image("images/a.png")');
	});

	test("are relative inside the file's folder and rooted outside it", () => {
		expect(references("ch/one.typ", ["ch/fig/a.jpg"], false)).toBe('#image("fig/a.jpg")');
		expect(references("ch/one.typ", ["fig/a.jpg"], false)).toBe('#image("/fig/a.jpg")');
	});

	test("chapters, bibliographies and other files", () => {
		expect(references("main.typ", ["ch/one.typ"], false)).toBe('#include "ch/one.typ"');
		expect(references("main.typ", ["refs.bib"], false)).toBe('#bibliography("refs.bib")');
		expect(references("main.typ", ["data.csv"], true)).toBe('"data.csv"');
	});

	test("several join by line in markup and by comma in code", () => {
		expect(references("main.typ", ["a.png", "b.png"], false)).toBe(
			'#image("a.png")\n#image("b.png")',
		);
		expect(references("main.typ", ["a.png", "b.png"], true)).toBe('image("a.png"), image("b.png")');
	});
});
