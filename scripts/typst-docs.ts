// Builds src/editor/typst-docs.json from the Typst reference at typst.app.
// Run with `just typst-docs`. The output is committed, so the app never fetches docs at runtime.

import type { TypstDoc, TypstParam } from "../src/editor/typstDocs";

const ORIGIN = "https://typst.app";
const OUT = new URL("../src/editor/typst-docs.json", import.meta.url);
// The symbol tables are thousands of rows of glyphs, which nobody hovers for.
const SKIP = new Set(["/docs/reference/symbols/sym/", "/docs/reference/symbols/emoji/"]);

const entities: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#39": "'",
	nbsp: " ",
};

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, "")
		.replace(/&(#?\w+);/g, (m, e) => entities[e] ?? m)
		.replace(/\s+/g, " ")
		.trim();

const firstParagraph = (html: string) => {
	const m = html.match(/^\s*<P>([\s\S]*?)<\/P>/i);
	return m ? text(m[1]) : "";
};

const pills = (html: string) =>
	[...html.matchAll(/class="pill[^"]*">([^<]+)<\/A>/gi)].map((m) => m[1]);

async function fetchPage(path: string) {
	const res = await fetch(ORIGIN + path);
	if (!res.ok) throw new Error(`${path}: ${res.status}`);
	return res.text();
}

/** Every H3 or H4 whose id is `prefix-` plus one more segment is one parameter. */
function params(html: string, prefix: string): TypstParam[] {
	const out: TypstParam[] = [];
	const re = new RegExp(`<H([34]) id="${prefix}-([a-z0-9]+)"[^>]*>([\\s\\S]*?)</H\\1>`, "gi");
	for (const m of html.matchAll(re)) {
		const [, , name, head] = m;
		const after = html.slice((m.index ?? 0) + m[0].length);
		const info = head.match(/class="additional-info"><DIV>([\s\S]*?)<\/DIV>/i)?.[1] ?? "";
		const def = head.match(/class="default">Default: ([\s\S]*?)<\/SMALL>/i)?.[1];
		const p: TypstParam = { name, types: pills(info) };
		if (/class="mod">Required/i.test(head)) p.required = true;
		if (/>Positional</i.test(head)) p.positional = true;
		if (/>Variadic</i.test(head)) p.variadic = true;
		if (def) p.default = text(def);
		const summary = firstParagraph(after);
		if (summary) p.summary = summary;
		out.push(p);
	}
	return out;
}

const returns = (html: string) =>
	html.match(/<\/DIV>\) → ([\s\S]*?)<\/DIV>/i)?.[1]?.match(/>([^<]+)<\/A>/)?.[1];

/** The name a module or group page's definitions live under, as in `calc.abs` or `html.div`. */
function scopeOf(path: string) {
	const [, , , category, page] = path.split("/");
	if (category === "math") return "math";
	if (category === "html") return "html";
	return page;
}

function parsePage(path: string, html: string): Record<string, TypstDoc> {
	const main = html.slice(html.indexOf("<MAIN>"));
	const url = ORIGIN + path;
	const docs: Record<string, TypstDoc> = {};
	const h1 = main.match(
		/<H1 id="summary"><(?:CODE|SPAN[^>]*)>([^<]+)<\/(?:CODE|SPAN)>([\s\S]*?)<\/H1>/i,
	);
	const body = h1 ? main.slice((h1.index ?? 0) + h1[0].length) : main;
	let scope = scopeOf(path);

	if (h1) {
		scope = path.startsWith("/docs/reference/math/") ? `math.${h1[1]}` : h1[1];
		const scopedStart = body.search(/<H3 id="[a-z]+-[a-z0-9]+" class="scoped-definition"/i);
		const own = scopedStart === -1 ? body : body.slice(0, scopedStart);
		const entry: TypstDoc = {
			url,
			summary: firstParagraph(body),
			params: params(own, "parameters"),
		};
		// Types document their constructor's parameters under a separate anchor.
		if (!entry.params.length) {
			entry.params = params(own, "constructor");
			if (entry.params.length) entry.paramAnchor = "constructor";
		}
		const kind = h1[2].match(/<SMALL><SPAN[^>]*>([^<]+)</)?.[1];
		if (kind) entry.kind = kind;
		const ret = returns(own);
		if (ret) entry.returns = ret;
		docs[scope] = entry;
	}

	const scoped = /<H3 id="([a-z]+)-([a-z0-9]+)" class="scoped-definition"><CODE>([^<]+)<\/CODE>/gi;
	const heads = [...body.matchAll(scoped)];
	heads.forEach((m, i) => {
		const [, group, slug, def] = m;
		const start = (m.index ?? 0) + m[0].length;
		const section = body.slice(start, heads[i + 1]?.index ?? body.length);
		const afterHead = section.slice(section.indexOf("</H3>") + 5);
		const d: TypstDoc = {
			url: `${url}#${group}-${slug}`,
			summary: firstParagraph(afterHead),
			params: params(section, `${group}-${slug}`),
		};
		const r = returns(section);
		if (r) d.returns = r;
		docs[`${scope}.${def}`] = d;
	});
	return docs;
}

const index = await fetchPage("/docs/reference/");
const paths = [
	...new Set(
		[...index.matchAll(/href="(\/docs\/reference\/[a-z-]+\/[a-z-]+\/)"/g)].map((m) => m[1]),
	),
].filter((p) => !SKIP.has(p));

const docs: Record<string, TypstDoc> = {};
const queue = [...paths];
await Promise.all(
	Array.from({ length: 8 }, async () => {
		for (let path = queue.shift(); path; path = queue.shift()) {
			Object.assign(docs, parsePage(path, await fetchPage(path)));
		}
	}),
);

const sorted = Object.fromEntries(Object.entries(docs).sort(([a], [b]) => a.localeCompare(b)));
await Bun.write(OUT, `${JSON.stringify(sorted)}\n`);
console.log(`${Object.keys(sorted).length} entries from ${paths.length} pages`);
