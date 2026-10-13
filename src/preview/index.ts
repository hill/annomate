import type { ProjectFormat } from "../../shared/formats";
import type { Room } from "../room/provider";
import { TypstEngine } from "./engine";
import { ENTRY, markdownEntry } from "./markdownEntry";
import type { Engine, EngineState } from "./types";

/** The engine that renders a project of this format. */
export function createEngine(format: ProjectFormat, room: Room, mainFile: () => string): Engine {
	switch (format) {
		case "typst":
			return new TypstEngine(room, mainFile);
		case "markdown":
			return new TypstEngine(room, mainFile, { path: ENTRY, source: markdownEntry });
		default:
			return new Unavailable("LaTeX preview is coming soon");
	}
}

/** Stands in for a format with no renderer yet, so the rest of the project still works. */
class Unavailable implements Engine {
	readonly textSelector = "";
	private state: EngineState;

	constructor(error: string) {
		this.state = {
			phase: "failed",
			error,
			pages: [],
			width: 0,
			height: 0,
			diagnostics: [],
			compileMs: 0,
			version: 0,
		};
	}

	async start() {}
	compile() {}
	subscribe = () => () => {};
	getState = () => this.state;
	mount() {}
	async pdf() {
		return { diagnostics: [] };
	}
	async thumbnail() {
		return null;
	}
	destroy() {}
}
