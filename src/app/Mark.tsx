import { navigate } from "../router";

/** A page with a folded corner and a comment tail. Black on light, light on black. */
export function Mark({ size = 22 }: { size?: number }) {
	return (
		<svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
			<rect width="32" height="32" rx="7" className="mark-bg" />
			<g
				fill="none"
				className="mark-ink"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M9 7.5h9.5l4.5 4.5v12.5H9z" />
				<path d="M18.5 7.5V12H23" />
				<path d="M12 15.5h8M12 19h5" />
				<path d="M15.5 24.5l2.5-3.2 2.5 3.2" />
			</g>
		</svg>
	);
}

export function Wordmark() {
	return (
		<a
			className="wordmark"
			href="/"
			onClick={(e) => {
				e.preventDefault();
				navigate("/");
			}}
		>
			<Mark />
			<span>annomate</span>
		</a>
	);
}
