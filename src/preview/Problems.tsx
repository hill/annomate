import { ArrowRight, CircleAlert, TriangleAlert } from "lucide-react";
import { Drawer } from "../ui/Drawer";
import type { Diagnostic } from "./types";

interface Span {
	line: number;
	col: number;
	endLine: number;
	endCol: number;
}

function spanOf(d: Diagnostic): Span | null {
	if (d.line === null) return null;
	return { line: d.line, col: d.column, endLine: d.endLine ?? d.line, endCol: d.endColumn };
}

const CONTEXT = 16;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function problemCount(diagnostics: Diagnostic[]) {
	const errors = diagnostics.filter((d) => d.severity === "error").length;
	return { errors, warnings: diagnostics.length - errors };
}

/** The source line a diagnostic points at, split around the span it covers on that line. */
function excerpt(source: string | undefined, span: Span | null) {
	if (!source || !span) return null;
	const text = source.split("\n")[span.line];
	if (text === undefined) return null;
	const end = span.endLine === span.line ? Math.max(span.endCol, span.col + 1) : text.length;
	const indent = text.length - text.trimStart().length;
	const from = Math.max(indent, Math.min(span.col, text.length));
	// Keep the span in view on long lines by trimming what comes before it.
	const start = Math.max(indent, from - CONTEXT);
	return {
		before: (start > indent ? "…" : "") + text.slice(start, from),
		hit: text.slice(from, end) || " ",
		after: text.slice(end),
	};
}

interface Props {
	diagnostics: Diagnostic[];
	source(path: string): string | undefined;
	mainFile: string;
	onOpen(path: string, line: number): void;
	onClose(): void;
}

export function Problems({ diagnostics, source, mainFile, onOpen, onClose }: Props) {
	const { errors, warnings } = problemCount(diagnostics);
	const sorted = [...diagnostics].sort(
		(a, b) => Number(b.severity === "error") - Number(a.severity === "error"),
	);
	const title = [errors && plural(errors, "error"), warnings && plural(warnings, "warning")]
		.filter(Boolean)
		.join(", ");

	return (
		<Drawer title={title || "No problems"} width={480} onClose={onClose}>
			<div className="problems">
				{sorted.map((d, i) => {
					const path = d.path || mainFile;
					const span = spanOf(d);
					const line = span ? span.line + 1 : 1;
					const code = excerpt(source(path), span);
					const error = d.severity === "error";
					const Icon = error ? CircleAlert : TriangleAlert;
					return (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no identity
							key={i}
							type="button"
							className={`problem ${error ? "error" : "warning"}`}
							onClick={() => onOpen(path, line)}
						>
							<span className="problem-head">
								<Icon size={14} aria-label={error ? "Error" : "Warning"} />
								<span className="problem-where">
									{path}
									<span>
										{line}
										{span && span.col > 0 ? `:${span.col + 1}` : ""}
									</span>
								</span>
								<ArrowRight size={13} className="problem-go" />
							</span>
							{code ? (
								<span className="problem-code">
									<span className="ln">{line}</span>
									<span className="src">
										{code.before}
										<mark>{code.hit}</mark>
										{code.after}
									</span>
									<span className="ln" />
									{/* Monospace padding lines the connector up under the start of the span. */}
									<span className="annot">
										<span className="pad">{" ".repeat(code.before.length)}</span>
										<span className="arm">╰─</span>
										<span className="msg">{d.message}</span>
									</span>
								</span>
							) : (
								<span className="problem-message">{d.message}</span>
							)}
						</button>
					);
				})}
			</div>
		</Drawer>
	);
}
