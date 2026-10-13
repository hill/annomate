/**
 * A Markdown project compiles through Typst. This generated entry file reads the Markdown and
 * typesets it with the cmarker package, so the preview, PDF export and source sync all come
 * from the Typst pipeline. It lives only in the compiler's file system, never in the project.
 */
export const ENTRY = "__annomate__/main.typ";

/** A repo can restyle its Markdown with `#let template(body) = …` in this file. */
export const TEMPLATE = "annomate.typ";

// cmarker 0.1.9 and later need Typst 0.15. typst.ts 0.7 bundles 0.14.
const CMARKER = "@preview/cmarker:0.1.8";
const MITEX = "@preview/mitex:0.2.5";

const typstString = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

/**
 * @param paths every file and asset in the project. Images not among them render as a visible
 *   gap, where a failed load would stop the whole document compiling.
 */
export function markdownEntry(main: string, paths: string[]): string {
	const dir = main.split("/").slice(0, -1).join("/");
	const custom = paths.includes(TEMPLATE);
	const images = paths.filter((p) => IMAGE.test(p)).map(typstString);
	return `#import ${typstString(CMARKER)}
#import ${typstString(MITEX)}: mitex
${custom ? `#import ${typstString(`/${TEMPLATE}`)}: template\n` : ""}
#set page(paper: "a4", margin: (x: 2.2cm, y: 2.4cm), numbering: "1")
#set text(size: 10.5pt)
#set par(justify: true)
#set table(stroke: 0.5pt + luma(190), inset: (x: 7pt, y: 5pt))
#show table.cell.where(y: 0): strong
#show heading: set block(above: 1.4em, below: 0.8em)
#show link: set text(fill: rgb("#2c5be0"))
#show raw.where(block: true): block.with(fill: luma(246), inset: 8pt, radius: 4pt, width: 100%)
#show quote.where(block: true): it => block(stroke: (left: 2pt + luma(200)), inset: (left: 10pt, y: 2pt), it.body)

// Markdown resolves images against its own folder. Typst would resolve them against this file.
#let base = ${typstString(dir ? `${dir}/` : "")}
#let present = (${images.join(", ")}${images.length === 1 ? "," : ""})
#let resolve(src) = {
  let parts = ()
  let full = if src.starts-with("/") { src } else { base + src }
  for part in full.replace("%20", " ").split("/") {
    if part == ".." { parts = parts.slice(0, calc.max(0, parts.len() - 1)) }
    else if part != "" and part != "." { parts.push(part) }
  }
  parts.join("/")
}
#let picture(src, alt: none, ..args) = {
  let path = resolve(src)
  if src.starts-with("http://") or src.starts-with("https://") {
    emph(if alt == none { src } else { alt })
  } else if path in present {
    image("/" + path, alt: alt, ..args)
  } else {
    box(stroke: 0.5pt + red, inset: 4pt, text(fill: red, size: 0.9em)[Missing image: #raw(src)])
  }
}

// Front matter is metadata, not text to typeset.
#let source = read(${typstString(`/${main}`)}).replace(regex("^---\\r?\\n(?s:.*?)\\r?\\n---\\r?\\n"), "")

${custom ? "#show: template\n" : ""}#cmarker.render(source, math: mitex, raw-typst: false, scope: (image: picture))
`;
}
