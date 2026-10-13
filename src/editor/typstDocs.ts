import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { hoverTooltip } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

export interface TypstParam {
	name: string;
	types: string[];
	required?: true;
	positional?: true;
	variadic?: true;
	default?: string;
	summary?: string;
}

export interface TypstDoc {
	url: string;
	kind?: string;
	summary: string;
	params: TypstParam[];
	returns?: string;
	/** The anchor prefix of the parameter headings when it is not `parameters`. */
	paramAnchor?: string;
}

type Docs = Record<string, TypstDoc>;

let docs: Promise<Docs> | null = null;
// The index is about 230 KB, so it stays out of the main bundle until the first hover.
const loadDocs = () => {
	docs ??= import("./typst-docs.json").then((m) => m.default as Docs);
	return docs;
};

const IDENT = new Set(["Ident", "MathIdent"]);
const CALLS = new Set(["FuncCall", "SetRule", "ShowRule", "MathCall"]);

const inMath = (node: SyntaxNode) => {
	for (let n: SyntaxNode | null = node; n; n = n.parent) if (n.name === "Equation") return true;
	return false;
};

/** The dotted path up to and including `node`, so hovering `abs` in `calc.abs` reads `calc.abs`. */
function path(state: EditorState, node: SyntaxNode) {
	let from = node.from;
	for (let p = node.parent; p?.name === "FieldAccess"; p = p.parent) from = p.from;
	return state.sliceDoc(from, node.to);
}

function lookup(all: Docs, name: string, math: boolean) {
	return (math && all[`math.${name}`]) || all[name] || all[`math.${name}`];
}

/** For `size` in `text(size: 2pt)`, the callee's name. */
function calleeOfNamed(state: EditorState, ident: SyntaxNode) {
	if (ident.parent?.name !== "Named" || ident.prevSibling) return null;
	const call = ident.parent.parent?.parent;
	if (!call || !CALLS.has(call.name)) return null;
	const callee =
		call.getChild("FieldAccess") ?? call.getChild("Ident") ?? call.getChild("MathIdent");
	return callee ? state.sliceDoc(callee.from, callee.to) : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
	const e = document.createElement(tag);
	e.className = className;
	if (text) e.textContent = text;
	return e;
}

function docsLink(url: string) {
	const a = el("a", "typst-doc-link", "Docs ↗");
	a.href = url;
	a.target = "_blank";
	a.rel = "noopener";
	return a;
}

function renderCall(name: string, doc: TypstDoc) {
	const dom = el("div", "typst-doc");
	const sig = el("code", "typst-doc-sig");
	sig.append(el("span", "fn", name), "(");
	doc.params.forEach((p, i) => {
		if (i) sig.append(", ");
		const label = `${p.variadic ? ".." : ""}${p.name}${p.positional ? "" : ":"}`;
		sig.append(el("span", p.required ? "param required" : "param", label));
	});
	sig.append(")");
	if (doc.returns) sig.append(el("span", "ret", ` → ${doc.returns}`));
	dom.append(sig);
	if (doc.summary) dom.append(el("p", "typst-doc-summary", doc.summary));
	dom.append(docsLink(doc.url));
	return dom;
}

function renderParam(doc: TypstDoc, param: TypstParam) {
	const dom = el("div", "typst-doc");
	const sig = el("code", "typst-doc-sig");
	sig.append(el("span", "param required", param.name), `: ${param.types.join(" | ")}`);
	if (param.default) sig.append(el("span", "ret", ` = ${param.default}`));
	dom.append(sig);
	if (param.summary) dom.append(el("p", "typst-doc-summary", param.summary));
	// Scoped definitions anchor their parameters under their own id.
	const anchor = doc.url.includes("#")
		? `${doc.url}-${param.name}`
		: `${doc.url}#${doc.paramAnchor ?? "parameters"}-${param.name}`;
	dom.append(docsLink(anchor));
	return dom;
}

/** Hover a built-in function, or one of its named arguments, to see its signature and a docs link. */
export const typstHover = hoverTooltip(
	async (view, pos, side) => {
		const node = syntaxTree(view.state).resolveInner(pos, side);
		if (!IDENT.has(node.name)) return null;
		const all = await loadDocs();
		const math = inMath(node);

		const callee = calleeOfNamed(view.state, node);
		if (callee) {
			const doc = lookup(all, callee, math);
			const param = doc?.params.find((p) => p.name === view.state.sliceDoc(node.from, node.to));
			if (!doc || !param) return null;
			return { pos: node.from, end: node.to, create: () => ({ dom: renderParam(doc, param) }) };
		}

		const name = path(view.state, node);
		const doc = lookup(all, name, math);
		if (!doc) return null;
		return { pos: node.from, end: node.to, create: () => ({ dom: renderCall(name, doc) }) };
	},
	{ hoverTime: 350 },
);
