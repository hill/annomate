import { GithubMark } from "../ui/GithubMark";
import { Mark } from "./Mark";

/** A screenshot in the visitor's theme. Both versions ship, and CSS shows the one that matches. */
function Shot({
	name,
	alt,
	width,
	height,
}: {
	name: string;
	alt: string;
	width: number;
	height: number;
}) {
	return (
		<>
			<img
				className="shot light"
				src={`/marketing/${name}.webp`}
				alt={alt}
				width={width}
				height={height}
			/>
			<img
				className="shot dark"
				src={`/marketing/${name}-dark.webp`}
				alt={alt}
				width={width}
				height={height}
				loading="lazy"
			/>
		</>
	);
}

export function Landing() {
	return (
		<div className="landing">
			<aside className="landing-side">
				<a className="landing-brand" href="/">
					<Mark size={24} />
					annomate
				</a>
				<nav className="landing-nav">
					<a href="/auth/login">Sign in</a>
					<a href="https://github.com/hill/annomate">GitHub</a>
				</nav>
				<a className="landing-credit" href="https://hill.xyz">
					Made by Tom Hill
				</a>
			</aside>

			<main className="landing-main">
				<h1>A simple, free Typst editor for annotating with mates</h1>
				<p>Edit a Typst project from GitHub together, comment on it, and commit back.</p>
				<a className="btn primary landing-cta" href="/auth/login">
					<GithubMark size={16} />
					Sign in with GitHub
				</a>

				<figure className="landing-hero">
					<Shot
						name="workspace"
						alt="annomate with a Typst paper open: source on the left, the rendered page in the middle, and comment threads on the right"
						width={3200}
						height={1920}
					/>
				</figure>

				<div className="landing-features">
					<figure>
						<div className="landing-crop">
							<Shot
								name="comment"
								alt="A comment whose passage was rewritten, showing the old and new words"
								width={684}
								height={526}
							/>
						</div>
						<figcaption>
							<strong>Comments follow the text.</strong> Rewrite a sentence and its comment shows
							exactly what changed.
						</figcaption>
					</figure>
					<figure>
						<div className="landing-crop">
							<Shot
								name="presence"
								alt="A collaborator's cursor in the source and their pointer over the page"
								width={1768}
								height={600}
							/>
						</div>
						<figcaption>
							<strong>Review side by side.</strong> See where everyone is typing and pointing, on
							the source and the page.
						</figcaption>
					</figure>
				</div>
			</main>
		</div>
	);
}
