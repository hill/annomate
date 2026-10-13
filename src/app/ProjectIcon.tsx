import { useId } from "react";

// Each palette reads well at 20px and at 64px, in light and dark.
const PALETTES = [
	["#1f2a44", "#f2ede3", "#e4572e", "#f3a712", "#4a7bd6"],
	["#0f3d3e", "#e8f1ee", "#2bb39b", "#f2c14e", "#f05d5e"],
	["#2d1e2f", "#f6e8ea", "#ef626c", "#84dccf", "#ffd166"],
	["#14213d", "#e5e5e5", "#fca311", "#3a6cf4", "#ffffff"],
	["#3d2b56", "#f0e6ff", "#a06cd5", "#ff8c61", "#6fd08c"],
	["#1b3a2f", "#f4f1de", "#e07a5f", "#81b29a", "#f2cc8f"],
	["#222222", "#f5f5f0", "#ff4f3a", "#2f6bff", "#ffc933"],
	["#0b2545", "#eef4ed", "#8da9c4", "#e63946", "#f1c40f"],
];

function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function random(seed: number) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A Bauhaus-style mark drawn from the repo name: a ground colour, one large
 * form, one bar and one dot, turned in quarter steps. The same name always
 * draws the same icon.
 */
export function GeneratedIcon({
	seed,
	size = 20,
	radius,
}: {
	seed: string;
	size?: number;
	radius?: number;
}) {
	const clip = useId();
	const rnd = random(hash(seed));
	const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
	const palette = pick(PALETTES);
	const [ground, ...rest] = [...palette].sort(() => rnd() - 0.5);
	const [a, b, c] = rest;
	const turn = Math.floor(rnd() * 4) * 90;
	const form = Math.floor(rnd() * 3);
	const barAngle = pick([0, 45, 90, 135]);
	const barOffset = 20 + rnd() * 40;
	const dot = { x: 18 + rnd() * 44, y: 18 + rnd() * 44, r: 7 + rnd() * 7 };
	const r = radius ?? Math.max(4, size * 0.24);

	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 80 80"
			aria-hidden="true"
			style={{ flexShrink: 0, display: "block" }}
		>
			<defs>
				<clipPath id={clip}>
					<rect width="80" height="80" rx={(r / size) * 80} />
				</clipPath>
			</defs>
			<g clipPath={`url(#${clip})`}>
				<rect width="80" height="80" fill={ground} />
				<g transform={`rotate(${turn} 40 40)`}>
					{form === 0 && <circle cx="0" cy="80" r="56" fill={a} />}
					{form === 1 && <path d="M0 0H80V80Z" fill={a} />}
					{form === 2 && <rect x="0" y="40" width="80" height="40" fill={a} />}
					<rect
						x="-20"
						y={barOffset}
						width="120"
						height="11"
						fill={b}
						transform={`rotate(${barAngle} 40 40)`}
					/>
					<circle cx={dot.x} cy={dot.y} r={dot.r} fill={c} />
				</g>
			</g>
		</svg>
	);
}

export function ProjectIcon({
	project,
	size = 20,
}: {
	project: { repo: string; icon: string | null };
	size?: number;
}) {
	if (project.icon) {
		return (
			<img
				src={project.icon}
				alt=""
				width={size}
				height={size}
				style={{
					flexShrink: 0,
					borderRadius: Math.max(4, size * 0.24),
					objectFit: "cover",
					display: "block",
				}}
			/>
		);
	}
	return <GeneratedIcon seed={project.repo} size={size} />;
}

/** Square-crop and shrink an image file to a small WebP data URL. */
export async function iconFromFile(file: File, size = 128): Promise<string> {
	const bitmap = await createImageBitmap(file);
	const side = Math.min(bitmap.width, bitmap.height);
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas is not available");
	ctx.drawImage(
		bitmap,
		(bitmap.width - side) / 2,
		(bitmap.height - side) / 2,
		side,
		side,
		0,
		0,
		size,
		size,
	);
	return canvas.toDataURL("image/webp", 0.85);
}
