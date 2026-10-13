import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createAnchor } from "../shared/anchor";
import { buildReport, reportMarkdown } from "../shared/commentReport";
import type { Thread, User } from "../shared/protocol";

const tom: User = { id: 1, login: "hill", name: "Tom Hill", avatar: "" };
const SOURCE = { repo: "hill/thesis", branch: "main", commit: "4f1c2a9e8b7d6c5a4f3e" };
const METHODS = [
	"= Methods",
	"",
	"We sampled ten sites across the northern valley.",
	"Each site was visited twice.",
	"",
	"= Results",
].join("\n");

function setup() {
	const doc = new Y.Doc();
	const files = doc.getMap<Y.Text>("files");
	doc.getMap<string>("base").set("methods.typ", METHODS);
	files.set("methods.typ", new Y.Text(METHODS));
	const text = files.get("methods.typ") as Y.Text;
	const thread = (id: string, quote: string, body: string, resolved = false): Thread => {
		const from = METHODS.indexOf(quote);
		return {
			id,
			anchor: createAnchor(text, "methods.typ", from, from + quote.length, SOURCE.commit),
			resolved,
			createdAt: 1_760_000_000_000,
			author: tom,
			comments: [{ id: `${id}-0`, threadId: id, author: tom, body, createdAt: 1_760_000_000_000 }],
		};
	};
	return { doc, text, thread };
}

describe("buildReport", () => {
	test("locates a passage by line and shows the lines around it", () => {
		const { doc, thread } = setup();
		const report = buildReport(doc, [thread("t1", "ten sites", "Twelve, surely?")], SOURCE, {
			context: 1,
		});
		expect(report.uncommitted).toEqual([]);
		expect(report.threads[0]).toMatchObject({
			file: "methods.typ",
			status: "ok",
			lines: { first: 3, last: 3 },
			committedLines: { first: 3, last: 3 },
			excerpt: { start: 2, lines: ["", METHODS.split("\n")[2], "Each site was visited twice."] },
		});
	});

	test("follows a passage pushed down by an edit, and keeps its committed line", () => {
		const { doc, text, thread } = setup();
		const threads = [thread("t1", "Each site was visited twice.", "Which season?")];
		text.insert(0, '#set page(numbering: "1")\n\n');
		const report = buildReport(doc, threads, SOURCE);
		expect(report.uncommitted).toEqual(["methods.typ"]);
		expect(report.threads[0].lines).toEqual({ first: 6, last: 6 });
		expect(report.threads[0].committedLines).toEqual({ first: 4, last: 4 });
	});

	test("reports rewritten text alongside the original", () => {
		const { doc, text, thread } = setup();
		const threads = [thread("t1", "ten sites", "Twelve, surely?")];
		const at = METHODS.indexOf("ten");
		text.delete(at, 3);
		text.insert(at, "twelve");
		const [t] = buildReport(doc, threads, SOURCE).threads;
		expect(t.status).toBe("edited");
		expect(t.quote).toBe("ten sites");
		expect(t.current).toBe("twelve sites");
	});

	test("filters by status and orders by position", () => {
		const { doc, thread } = setup();
		const threads = [
			thread("late", "= Results", "Too short"),
			thread("early", "= Methods", "Rename?"),
			thread("done", "visited twice", "Fine", true),
		];
		expect(buildReport(doc, threads, SOURCE).threads.map((t) => t.id)).toEqual(["early", "late"]);
		expect(
			buildReport(doc, threads, SOURCE, { status: "resolved" }).threads.map((t) => t.id),
		).toEqual(["done"]);
		expect(buildReport(doc, threads, SOURCE, { status: "all" }).counts).toEqual({
			open: 2,
			resolved: 1,
		});
	});
});

describe("reportMarkdown", () => {
	test("gives each thread its location, quote, marked context and conversation", () => {
		const { doc, thread } = setup();
		const t = thread("t1", "ten sites", "Twelve, surely?");
		t.comments.push({
			id: "t1-1",
			threadId: "t1",
			author: tom,
			body: "Fixed in the methods.",
			createdAt: 1_760_000_060_000,
			via: "Claude Code",
		});
		const md = reportMarkdown(buildReport(doc, [t], SOURCE, { context: 1 }));
		expect(md).toContain("## methods.typ:3 · open");
		expect(md).toContain("Thread `t1`.");
		expect(md).toContain("> ten sites");
		expect(md).toContain("> 3 | We sampled ten sites across the northern valley.");
		expect(md).toContain("  4 | Each site was visited twice.");
		expect(md).toContain("**Tom Hill** (@hill) via Claude Code, 2025-10-09 08:54 UTC:");
		expect(md).toContain("matches `4f1c2a9`");
	});

	test("fences context that itself contains backticks", () => {
		const doc = new Y.Doc();
		const source = "Use ```raw``` here.";
		doc.getMap<Y.Text>("files").set("a.typ", new Y.Text(source));
		doc.getMap<string>("base").set("a.typ", source);
		const text = doc.getMap<Y.Text>("files").get("a.typ") as Y.Text;
		const thread: Thread = {
			id: "t",
			anchor: createAnchor(text, "a.typ", 4, 13, SOURCE.commit),
			resolved: false,
			createdAt: 0,
			author: tom,
			comments: [],
		};
		const md = reportMarkdown(buildReport(doc, [thread], SOURCE));
		expect(md).toContain("````typst");
	});
});
