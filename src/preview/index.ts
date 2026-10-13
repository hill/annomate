import type { ProjectFormat } from "../../shared/formats";
import type { Room } from "../room/provider";
import { TypstEngine } from "./engine";
import { ENTRY, markdownEntry } from "./markdownEntry";
import { PdfEngine } from "./pdfEngine";
import type { Engine } from "./types";

/** The engine that renders a project of this format. */
export function createEngine(format: ProjectFormat, room: Room, mainFile: () => string): Engine {
	switch (format) {
		case "typst":
			return new TypstEngine(room, mainFile);
		case "markdown":
			return new TypstEngine(room, mainFile, { path: ENTRY, source: markdownEntry });
		case "latex":
			return new PdfEngine(room);
	}
}
