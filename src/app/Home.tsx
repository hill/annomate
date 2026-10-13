import { LayoutGrid, Plus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { User } from "../../shared/protocol";
import { ApiError, ago, api, type Project, type Repo } from "../api";
import { navigate } from "../router";
import { Drawer } from "../ui/Drawer";
import { GithubMark, githubUrl } from "../ui/GithubMark";
import { Landing } from "./Landing";
import { Wordmark } from "./Mark";
import { ProjectIcon } from "./ProjectIcon";
import { SidebarFrame, SideFoot } from "./Sidebar";

export function Home() {
	const [me, setMe] = useState<User | null | undefined>(undefined);
	const [projects, setProjects] = useState<Project[] | null>(null);
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		api
			.me()
			.then((user) => {
				setMe(user);
				return api.projects().then(setProjects);
			})
			.catch((e) => setMe(e instanceof ApiError && e.status === 401 ? null : undefined));
	}, []);

	if (me === undefined) return null;

	if (me === null) return <Landing />;

	return (
		<SidebarFrame
			sidebar={
				<>
					<div className="side-head" style={{ paddingLeft: 18 }}>
						<Wordmark />
					</div>
					<div className="side-scroll">
						<button type="button" className="nav" aria-current="true">
							<LayoutGrid size={14} />
							Projects
						</button>
					</div>
					<SideFoot me={me} />
				</>
			}
		>
			<main className="home-main">
				<header className="home-head">
					<div className="crumbs">
						<span className="here">Projects</span>
					</div>
					<span className="spacer" />
					<button type="button" className="btn primary" onClick={() => setCreating(true)}>
						<Plus size={14} />
						New project
					</button>
				</header>
				<div className="home-body">
					{projects === null ? (
						<div className="empty" style={{ height: 320 }}>
							<div className="loader" />
						</div>
					) : (
						<div className="project-grid">
							{projects.map((p) => (
								<ProjectCard key={p.id} project={p} />
							))}
							<div className="project-card new">
								<button type="button" className="card-link" onClick={() => setCreating(true)}>
									<span className="thumb">
										<Plus size={20} />
									</span>
									<span className="card-body">
										<span className="name">New project</span>
									</span>
								</button>
							</div>
						</div>
					)}
				</div>
			</main>
			{creating && <NewProject onClose={() => setCreating(false)} />}
		</SidebarFrame>
	);
}

function ProjectCard({ project: p }: { project: Project }) {
	const [, name] = p.repo.split("/");
	const updated = p.thumbAt ?? p.createdAt;
	return (
		<div className="project-card">
			<a
				className="card-link"
				href={`/p/${p.id}`}
				onClick={(e) => {
					if (e.metaKey || e.ctrlKey) return;
					e.preventDefault();
					navigate(`/p/${p.id}`);
				}}
			>
				<span className="thumb">
					{p.thumbAt ? (
						<img src={`/api/projects/${p.id}/thumb?v=${p.thumbAt}`} alt="" loading="lazy" />
					) : (
						<span className="thumb-fallback">
							<ProjectIcon project={p} size={88} />
						</span>
					)}
				</span>
				<span className="card-body">
					<ProjectIcon project={p} size={20} />
					<span className="card-text">
						<span className="name">{name}</span>
						<span className="meta">
							<span className="mono">{p.branch}</span> · {p.role === "owner" ? "Owner" : "Editor"} ·{" "}
							{ago(updated)}
						</span>
					</span>
				</span>
			</a>
			<a
				className="btn ghost icon small gh"
				href={githubUrl.repo(p.repo)}
				target="_blank"
				rel="noreferrer"
				aria-label={`Open ${p.repo} on GitHub`}
				title="Open on GitHub"
			>
				<GithubMark size={14} />
			</a>
		</div>
	);
}

function NewProject({ onClose }: { onClose(): void }) {
	const [repos, setRepos] = useState<Repo[]>([]);
	const [repo, setRepo] = useState("");
	const [branch, setBranch] = useState("");
	const [mainFile, setMainFile] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		api.repos().then(setRepos, () => {});
	}, []);

	async function submit(e?: FormEvent) {
		e?.preventDefault();
		setBusy(true);
		setError("");
		try {
			const project = await api.createProject({ repo: repo.trim(), branch, mainFile });
			navigate(`/p/${project.id}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	}

	return (
		<Drawer
			title="New project"
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="btn primary"
						disabled={busy || !repo}
						onClick={() => submit()}
					>
						{busy ? "Loading…" : "Create project"}
					</button>
				</>
			}
		>
			<form onSubmit={submit}>
				<div className="form-row">
					<label className="label" htmlFor="np-repo">
						Repository
					</label>
					<input
						id="np-repo"
						className="field"
						list="repos"
						value={repo}
						onChange={(e) => {
							setRepo(e.target.value);
							const match = repos.find((r) => r.repo === e.target.value);
							if (match) setBranch(match.branch);
						}}
						required
						spellCheck={false}
					/>
					<datalist id="repos">
						{repos.map((r) => (
							<option key={r.repo} value={r.repo} />
						))}
					</datalist>
				</div>
				<div className="form-row">
					<label className="label" htmlFor="np-branch">
						Branch <span className="opt">(optional)</span>
					</label>
					<input
						id="np-branch"
						className="field mono"
						value={branch}
						onChange={(e) => setBranch(e.target.value)}
						spellCheck={false}
					/>
				</div>
				<div className="form-row">
					<label className="label" htmlFor="np-main">
						Main file <span className="opt">(optional)</span>
					</label>
					<input
						id="np-main"
						className="field mono"
						value={mainFile}
						onChange={(e) => setMainFile(e.target.value)}
						spellCheck={false}
					/>
				</div>
				{error && <div className="form-error">{error}</div>}
				<button type="submit" hidden />
			</form>
		</Drawer>
	);
}
