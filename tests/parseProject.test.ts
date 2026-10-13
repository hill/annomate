import { describe, expect, test } from "vitest";
import { parseProject } from "../shared/projectName";

describe("parseProject", () => {
	test.each([
		["hill/thesis", { slug: "hill/thesis", branch: undefined }],
		["Hill/Thesis@draft", { slug: "hill/thesis", branch: "draft" }],
		["hill/thesis@feature/intro", { slug: "hill/thesis", branch: "feature/intro" }],
		["git@github.com:hill/thesis.git", { slug: "hill/thesis", branch: undefined }],
		["https://github.com/hill/thesis.git", { slug: "hill/thesis", branch: undefined }],
		["https://github.com/hill/thesis@draft", { slug: "hill/thesis", branch: "draft" }],
		["0f9cf70d", { slug: "0f9cf70d", branch: undefined }],
	])("%s", (input, expected) => {
		expect(parseProject(input)).toEqual(expected);
	});
});
