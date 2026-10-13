// Distinct at a glance, readable with white text, and none of them the highlighter yellow.
const PALETTE = [
	"#e5484d",
	"#3e63dd",
	"#12a594",
	"#8e4ec6",
	"#f76b15",
	"#0090ff",
	"#d6409f",
	"#46a758",
];

export function colorFor(id: number) {
	const color = PALETTE[Math.abs(id) % PALETTE.length];
	return { color, colorLight: `${color}33` };
}
