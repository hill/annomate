import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
	type Anchor,
	applyMinimalDiff,
	createAnchor,
	inlineDiff,
	merge3,
	reattach,
	resolveAnchor,
} from "../shared/anchor";

const PAPER = `= Introduction

Typst is a markup-based typesetting system. It is designed to be as powerful
as LaTeX while being much easier to learn and use.

= Method

We sampled 400 participants from three cities and asked each of them to
typeset the same two-page document in both systems.

= Results

Participants finished the Typst task 2.3 times faster on average.
`;

function setup(source = PAPER) {
	const doc = new Y.Doc();
	const text = doc.getMap<Y.Text>("files").set("main.typ", new Y.Text(source));
	return { doc, text };
}

function comment(text: Y.Text, quote: string): Anchor {
	const source = text.toString();
	const from = source.indexOf(quote);
	if (from === -1) throw new Error(`quote not in source: ${quote}`);
	return createAnchor(text, "main.typ", from, from + quote.length, "abc123");
}

const QUOTE = "We sampled 400 participants from three cities";

describe("live anchors", () => {
	test("survive edits before the range", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		text.insert(0, '#set page(paper: "a4")\n\n');
		const r = resolveAnchor(doc, text, anchor);
		expect(r.status).toBe("ok");
		expect(r.current).toBe(QUOTE);
	});

	test("do not absorb text typed at either edge", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		const from = text.toString().indexOf(QUOTE);
		text.insert(from + QUOTE.length, " and two villages");
		text.insert(from, "In 2025, ");
		const r = resolveAnchor(doc, text, anchor);
		expect(r.status).toBe("ok");
		expect(r.current).toBe(QUOTE);
	});

	test("report typing inside the range as edited, keeping the original quote", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		const at = text.toString().indexOf("400");
		text.delete(at, 3);
		text.insert(at, "412");
		const r = resolveAnchor(doc, text, anchor);
		expect(r.status).toBe("edited");
		expect(r.current).toBe("We sampled 412 participants from three cities");
		expect(anchor.quote).toBe(QUOTE);
	});

	test("survive a partial deletion", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		const at = text.toString().indexOf(" from three cities");
		text.delete(at, " from three cities".length);
		const r = resolveAnchor(doc, text, anchor);
		expect(r.status).toBe("edited");
		expect(r.current).toBe("We sampled 400 participants");
	});

	test("follow a paragraph that was cut and pasted elsewhere", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		const source = text.toString();
		const para = source.slice(source.indexOf("We sampled"), source.indexOf("= Results"));
		text.delete(source.indexOf(para), para.length);
		text.insert(text.toString().length, `\n${para}`);
		const r = resolveAnchor(doc, text, anchor);
		expect(r.status).toBe("moved");
		expect(text.toString().slice(r.from, r.to)).toBe(QUOTE);
	});

	test("detach with the original quote intact when the passage is gone", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		const source = text.toString();
		const start = source.indexOf("= Method");
		text.delete(start, source.indexOf("= Results") - start);
		const r = resolveAnchor(doc, text, anchor);
		expect(r.status).toBe("detached");
		expect(anchor.quote).toBe(QUOTE);
		expect(anchor.commit).toBe("abc123");
		expect(anchor.line).toBe(8);
	});

	test("converge across two concurrently edited replicas", () => {
		const a = setup();
		const b = { doc: new Y.Doc() };
		Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
		const bText = b.doc.getMap<Y.Text>("files").get("main.typ") as Y.Text;
		const anchor = comment(a.text, QUOTE);

		a.text.insert(0, "// draft 2\n");
		const at = bText.toString().indexOf("Typst is");
		bText.insert(at, "In short, ");

		Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
		Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));

		expect(resolveAnchor(a.doc, a.text, anchor).current).toBe(QUOTE);
		expect(resolveAnchor(b.doc, bText, anchor).current).toBe(QUOTE);
	});
});

describe("changes pushed from outside annomate", () => {
	function push(text: Y.Text, base: string, theirs: string) {
		applyMinimalDiff(text, merge3(base, text.toString(), theirs).text);
	}

	test("keep anchors when sections are reordered upstream", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		const results = PAPER.slice(PAPER.indexOf("= Results"));
		const theirs = PAPER.replace(results, "").replace("= Method", `${results}\n= Method`);
		push(text, PAPER, theirs);
		const r = resolveAnchor(doc, text, anchor);
		expect(["ok", "moved"]).toContain(r.status);
		expect(text.toString().slice(r.from, r.to)).toBe(QUOTE);
	});

	test("show a rewritten quote as edited, still pointing at the right sentence", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		const theirs = PAPER.replace(QUOTE, "We recruited 412 people across three cities");
		push(text, PAPER, theirs);
		const r = resolveAnchor(doc, text, anchor);
		expect(r.status).toBe("edited");
		expect(r.current).toContain("412 people");
		expect(anchor.quote).toBe(QUOTE);
	});

	test("merge local edits with upstream edits in other places", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		text.insert(text.toString().indexOf("Participants finished"), "Overall, ");
		const theirs = PAPER.replace("= Introduction", "= Background");
		push(text, PAPER, theirs);
		expect(text.toString()).toContain("= Background");
		expect(text.toString()).toContain("Overall, Participants");
		expect(resolveAnchor(doc, text, anchor).status).toBe("ok");
	});

	test("re-find a quote after a wholesale file replacement", () => {
		const { doc, text } = setup();
		const anchor = comment(text, QUOTE);
		text.delete(0, text.length);
		text.insert(0, `#import "@preview/cetz:0.3.4"\n\n${PAPER}`);
		const r = resolveAnchor(doc, text, anchor);
		expect(r.status).toBe("moved");
		const fixed = reattach(text, anchor, r);
		text.insert(0, "// header\n");
		const again = resolveAnchor(doc, text, fixed);
		expect(again.status).toBe("ok");
		expect(again.searched).toBe(false);
	});

	test("fuzzy match a lightly reworded quote with no intact context", () => {
		const { doc, text } = setup();
		const anchor = comment(
			text,
			"Participants finished the Typst task 2.3 times faster on average.",
		);
		text.delete(0, text.length);
		text.insert(
			0,
			"= Results\n\nParticipants finished the Typst task 2.4 times faster, on average.\n",
		);
		const r = resolveAnchor(doc, text, anchor);
		expect(r.status).toBe("edited");
		expect(r.current).toContain("2.4 times faster");
	});
});

describe("inline diff", () => {
	test("never splits a word", () => {
		const diff = inlineDiff(
			"We sampled 400 participants from three cities",
			"We recruited 412 participants across three cities",
		);
		expect(diff).toEqual([
			[0, "We "],
			[-1, "sampled 400"],
			[1, "recruited 412"],
			[0, " participants "],
			[-1, "from"],
			[1, "across"],
			[0, " three cities"],
		]);
	});
});

describe("point anchors", () => {
	const AT = "= Results";

	function point(text: Y.Text) {
		const at = text.toString().indexOf(AT);
		return { at, anchor: createAnchor(text, "main.typ", at, at, "abc123") };
	}

	test("follow edits before them", () => {
		const { doc, text } = setup();
		const { at, anchor } = point(text);
		text.insert(0, "#outline()\n");
		const r = resolveAnchor(doc, text, anchor);
		expect(r).toMatchObject({ status: "ok", from: at + 11, to: at + 11 });
	});

	test("move ahead of text typed at them", () => {
		const { doc, text } = setup();
		const { at, anchor } = point(text);
		text.insert(at, '#figure(image("a.png"))\n\n');
		const r = resolveAnchor(doc, text, anchor);
		expect(text.toString().slice(r.from, r.from + AT.length)).toBe(AT);
	});

	test("are found by their context once the live position is lost", () => {
		const { doc, text } = setup();
		const { anchor } = point(text);
		const rewritten = new Y.Doc().getText();
		rewritten.insert(0, `#outline()\n${PAPER}`);
		const r = resolveAnchor(doc, rewritten, anchor);
		expect(r.status).toBe("moved");
		expect(rewritten.toString().slice(r.from, r.from + AT.length)).toBe(AT);
		expect(r.to).toBe(r.from);
	});

	test("reattach as a point", () => {
		const { doc, text } = setup();
		const { anchor } = point(text);
		const r = resolveAnchor(doc, text, anchor);
		const fixed = reattach(text, anchor, r);
		expect(fixed.start).toBe(fixed.end);
	});
});
