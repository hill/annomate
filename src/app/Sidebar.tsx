import {
	ChevronsUpDown,
	ExternalLink,
	GitBranch,
	GitCommitHorizontal,
	History,
	LayoutGrid,
	LogOut,
	PanelLeft,
	Settings,
	UserPlus,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { User } from "../../shared/protocol";
import { api, type Member, type Project } from "../api";
import { navigate } from "../router";
import { ThemeMenu } from "../theme/ThemeMenu";
import { GithubMark, githubUrl } from "../ui/GithubMark";
import { ProjectIcon } from "./ProjectIcon";

export function SidebarFrame({
	collapsed,
	sidebar,
	children,
}: {
	collapsed: boolean;
	sidebar: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className={`frame${collapsed ? " collapsed" : ""}`}>
			<nav className="sidebar" aria-hidden={collapsed}>
				{sidebar}
			</nav>
			{children}
		</div>
	);
}

export function SideHead({
	project,
	onCollapse,
	onSettings,
}: {
	project: Project;
	onCollapse(): void;
	onSettings(): void;
}) {
	const [menu, setMenu] = useState(false);
	const [projects, setProjects] = useState<Project[] | null>(null);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menu) return;
		api.projects().then(setProjects, () => setProjects([]));
		const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
		addEventListener("pointerdown", onDown);
		return () => removeEventListener("pointerdown", onDown);
	}, [menu]);

	return (
		<div className="side-head" ref={ref} style={{ position: "relative" }}>
			<button type="button" className="switcher" onClick={() => setMenu((m) => !m)}>
				<ProjectIcon project={project} size={22} />
				<span className="name">{project.repo.split("/")[1]}</span>
				<ChevronsUpDown size={14} />
			</button>
			<button
				type="button"
				className="btn ghost icon"
				aria-label="Hide sidebar"
				onClick={onCollapse}
			>
				<PanelLeft size={16} />
			</button>
			{menu && (
				<div className="menu" style={{ top: 44, left: 8, right: 8 }}>
					{(projects ?? []).map((p) => (
						<button
							key={p.id}
							type="button"
							className="nav"
							onClick={() => {
								setMenu(false);
								navigate(`/p/${p.id}`);
							}}
						>
							<ProjectIcon project={p} size={16} />
							<span className="grow">{p.repo}</span>
							<span className="trail">{p.branch}</span>
						</button>
					))}
					{projects === null && <div className="nav dim">Loading…</div>}
					<hr />
					<button
						type="button"
						className="nav"
						onClick={() => {
							setMenu(false);
							onSettings();
						}}
					>
						<Settings size={14} />
						Project settings
					</button>
					<button type="button" className="nav" onClick={() => navigate("/")}>
						<LayoutGrid size={14} />
						All projects
					</button>
				</div>
			)}
		</div>
	);
}

export function SideFoot({ me }: { me: User | null }) {
	if (!me) return null;
	return (
		<div className="side-foot">
			<img className="avatar" src={me.avatar} alt="" />
			<span className="who">{me.name}</span>
			<ThemeMenu />
			<a
				className="btn ghost icon small"
				href="/auth/logout"
				aria-label="Sign out"
				title="Sign out"
			>
				<LogOut size={14} />
			</a>
		</div>
	);
}

export function GitSection({
	repo,
	branch,
	baseSha,
	changed,
	busy,
	onHistory,
	onCommit,
}: {
	repo: string;
	branch: string;
	baseSha: string;
	changed: number;
	busy: string | null;
	onHistory(): void;
	onCommit(): void;
}) {
	return (
		<div className="side-section">
			<div className="side-label">Git</div>
			<a
				className="nav"
				href={githubUrl.tree(repo, branch)}
				target="_blank"
				rel="noreferrer"
				title="Open branch on GitHub"
			>
				<GitBranch size={14} />
				<span className="grow mono" style={{ fontSize: 12 }}>
					{branch}
				</span>
				<span className="trail mono">{busy ? `${busy}…` : baseSha.slice(0, 7)}</span>
			</a>
			<a className="nav" href={githubUrl.repo(repo)} target="_blank" rel="noreferrer">
				<GithubMark size={14} />
				<span className="grow">Open on GitHub</span>
				<ExternalLink size={12} className="trail" />
			</a>
			<button type="button" className="nav" onClick={onCommit}>
				<GitCommitHorizontal size={14} />
				<span className="grow">Changes</span>
				{changed > 0 && <span className="trail">{changed}</span>}
			</button>
			<button type="button" className="nav" onClick={onHistory}>
				<History size={14} />
				<span className="grow">History</span>
			</button>
		</div>
	);
}

export function PeopleSection({
	members,
	online,
	onInvite,
}: {
	members: Member[];
	online: Set<string>;
	onInvite(): void;
}) {
	return (
		<div className="side-section">
			<div className="side-label">
				People
				<button
					type="button"
					className="btn ghost icon small"
					aria-label="Invite"
					onClick={onInvite}
				>
					<UserPlus size={14} />
				</button>
			</div>
			{members.map((m) => (
				<div key={m.login} className="nav" style={{ cursor: "default" }}>
					{m.avatar ? (
						<img className="avatar" src={m.avatar} alt="" style={{ width: 16, height: 16 }} />
					) : (
						<span className="avatar" style={{ width: 16, height: 16 }} />
					)}
					<span className={`grow${online.has(m.login.toLowerCase()) ? "" : " muted"}`}>
						{m.name ?? m.login}
					</span>
					{online.has(m.login.toLowerCase()) && (
						<span className="dot" style={{ background: "var(--ok)" }} />
					)}
				</div>
			))}
		</div>
	);
}
