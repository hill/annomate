import {
	ArrowDownToLine,
	BookOpen,
	CircleAlert,
	CircleCheck,
	Code,
	Columns2,
	Download,
	FileText,
	Maximize2,
	MessageSquare,
	MessageSquarePlus,
	Minimize2,
	PanelLeft,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { applyMinimalDiff, createAnchor, type Resolved, resolveAnchor } from "../../shared/anchor";
import { isSource, pdfName } from "../../shared/formats";
import { isTextPath, type Presence, type User } from "../../shared/protocol";
import { ApiError, api, type CommitFile, type Member, type Project, signIn } from "../api";
import { type Draft, Rail } from "../comments/Rail";
import { Editor, type EditorHandle } from "../editor/Editor";
import { references } from "../editor/references";
import { useDiffMode } from "../history/CommitDiff";
import { Counts, FileDiff } from "../history/FileDiff";
import { HistoryDrawer } from "../history/HistoryDrawer";
import { colorFor } from "../presence/colors";
import { createEngine } from "../preview";
import { Preview, type PreviewHandle } from "../preview/Preview";
import type { Engine } from "../preview/types";
import { Room, usePresence, useRoom } from "../room/provider";
import { navigate } from "../router";
import { Drawer } from "../ui/Drawer";
import { GithubMark, githubUrl } from "../ui/GithubMark";
import { FileTree, joinPath, KEEP, parentOf, type Upload } from "./FileTree";
import { localPatch } from "./localPatch";
import { Wordmark } from "./Mark";
import { GeneratedIcon, iconFromFile, ProjectIcon } from "./ProjectIcon";
import { GitSection, PeopleSection, SidebarFrame, SideFoot, SideHead } from "./Sidebar";

type ProjectWithMembers = Project & { members: Member[] };

export function ProjectView({ id }: { id: string }) {
	const [room, setRoom] = useState<Room | null>(null);
	const [project, setProject] = useState<ProjectWithMembers | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api
			.project(id)
			.then((p) => {
				setProject(p);
				const r = new Room(id);
				if (import.meta.env.DEV) Object.assign(window, { room: r });
				setRoom(r);
			})
			.catch((e) => {
				if (e instanceof ApiError && e.status === 401) signIn();
				else setError(e instanceof Error ? e.message : String(e));
			});
	}, [id]);

	useEffect(() => () => room?.destroy(), [room]);

	const repoName = project?.repo.split("/")[1];
	useEffect(() => {
		if (!repoName) return;
		document.title = `${repoName} | annomate`;
		return () => {
			document.title = "annomate";
		};
	}, [repoName]);

	if (error) {
		return (
			<div className="signin">
				<div className="signin-card">
					<Wordmark />
					<div className="muted">{error}</div>
				</div>
			</div>
		);
	}
	if (!room || !project) return null;
	return (
		<Workspace room={room} project={project} reload={() => api.project(id).then(setProject)} />
	);
}

/** Bumps whenever the shared document changes, for derived values that read it. */
function useDocVersion(doc: Y.Doc) {
	const version = useRef(0);
	return useSyncExternalStore(
		(cb) => {
			const handler = () => {
				version.current++;
				cb();
			};
			doc.on("update", handler);
			return () => doc.off("update", handler);
		},
		() => version.current,
	);
}

function useStored<T>(key: string, initial: T) {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			return raw === null ? initial : (JSON.parse(raw) as T);
		} catch {
			return initial;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
	}, [key, value]);
	return [value, setValue] as const;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** Folder names that, beside the open file, take its dropped and pasted images. */
const IMAGE_DIRS = ["images", "figures", "img", "assets"];

const EXTENSION: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

/** Browsers name every pasted screenshot `image.png`, so those get a timestamp instead. */
function imageName(file: File) {
	if (file.name && !/^image\.\w+$/.test(file.name)) return file.name;
	const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
	return `pasted-${stamp}.${EXTENSION[file.type] ?? "png"}`;
}

/** `name` in `folder`, numbered `name-2`, `name-3` and so on until it is free. */
function freePath(folder: string, name: string, taken: (path: string) => boolean) {
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	let path = joinPath(folder, name);
	for (let n = 2; taken(path); n++) path = joinPath(folder, `${stem}-${n}${ext}`);
	return path;
}

function Workspace({
	room,
	project,
	reload,
}: {
	room: Room;
	project: ProjectWithMembers;
	reload(): void;
}) {
	const { status, me, threads, git, toasts } = useRoom(room);
	const presence = usePresence(room);
	const version = useDocVersion(room.doc);
	const editor = useRef<EditorHandle>(null);
	const preview = useRef<PreviewHandle>(null);

	const [file, setFile] = useState<string | null>(null);
	const [active, setActive] = useState<string | null>(null);
	const [draft, setDraft] = useState<(Draft & { from: number; to: number }) | null>(null);
	const [following, setFollowing] = useState<number | null>(null);
	const [drawer, setDrawer] = useState<"commit" | "share" | "history" | "settings" | null>(null);
	const [collapsed, setCollapsed] = useStored("am:sidebar-collapsed", false);
	const [railOpen, setRailOpen] = useStored("am:rail-open", false);
	const [left, setLeft] = useStored("am:left-pane", 560);
	const [layout, setLayout] = useStored<Layout>("am:layout", "split");
	const [dragging, setDragging] = useState(false);
	const panes = useRef<HTMLDivElement>(null);

	const mainFile = git?.mainFile ?? project.mainFile;
	const format = git?.format ?? project.format;
	const currentFile = file ?? mainFile;
	const [owner, repoName] = project.repo.split("/");

	const files = useMemo(() => {
		void version;
		return [...room.files.keys()];
	}, [room, version]);
	const assets = useMemo(() => {
		void version;
		return [...room.assets.keys()];
	}, [room, version]);

	const changed = useMemo(() => {
		void version;
		const out = new Set<string>();
		for (const [path, text] of room.files)
			if (text.toString() !== room.base.get(path)) out.add(path);
		for (const path of room.base.keys()) if (!room.files.has(path)) out.add(path);
		for (const [path, a] of room.assets)
			if (room.baseAssets.get(path)?.sha !== a.sha) out.add(path);
		for (const path of room.baseAssets.keys()) if (!room.assets.has(path)) out.add(path);
		return out;
	}, [room, version]);

	// What a commit would contain, counting a move as one change as git and the commit drawer do.
	const changeCount = useMemo(() => pairRenames(room, [...changed]).paths.length, [room, changed]);

	const resolved = useMemo(() => {
		void version;
		const out = new Map<string, Resolved>();
		for (const t of threads)
			out.set(t.id, resolveAnchor(room.doc, room.files.get(t.anchor.file), t.anchor));
		return out;
	}, [room, threads, version]);

	const mainRef = useRef(mainFile);
	mainRef.current = mainFile;
	const [engine, setEngine] = useState<Engine | null>(null);
	useEffect(() => {
		const e = createEngine(format, room, () => mainRef.current);
		setEngine(e);
		return () => e.destroy();
	}, [room, format]);
	useEffect(() => {
		if (status === "live") void engine?.start();
	}, [status, engine]);

	// Keep the project grid's first-page thumbnail fresh: once soon after opening, then at most every two minutes.
	useEffect(() => {
		if (!engine) return;
		let lastVersion = 0;
		let lastSaved = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = engine.subscribe(() => {
			const { version, phase } = engine.getState();
			if (phase !== "ready" || !version || version === lastVersion) return;
			lastVersion = version;
			clearTimeout(timer);
			const wait = Math.max(4000, lastSaved + 120_000 - Date.now());
			timer = setTimeout(async () => {
				const image = await engine.thumbnail().catch(() => null);
				if (!image) return;
				lastSaved = Date.now();
				await api.saveThumb(project.id, image).catch(() => {});
			}, wait);
		});
		return () => {
			clearTimeout(timer);
			unsubscribe();
		};
	}, [engine, project.id]);

	useEffect(() => {
		if (!me) return;
		room.setPresence({ user: { ...me, ...colorFor(me.id) }, file: currentFile });
	}, [room, me, currentFile]);

	const leader = following !== null ? presence.get(following) : undefined;
	useEffect(() => {
		if (following !== null && !leader) setFollowing(null);
		else if (leader?.file && leader.file !== currentFile) setFile(leader.file);
	}, [following, leader, currentFile]);

	const people = useMemo(() => {
		const seen = new Map<number, { clientId: number; presence: Presence }>();
		for (const [clientId, p] of presence) {
			if (clientId === room.doc.clientID || !p.user || p.user.id === me?.id) continue;
			if (!seen.has(p.user.id)) seen.set(p.user.id, { clientId, presence: p });
		}
		return [...seen.values()];
	}, [presence, room, me]);

	const who = useMemo(() => {
		const out = new Map<string, Presence["user"][]>();
		for (const { presence: p } of people)
			if (p.file) out.set(p.file, [...(out.get(p.file) ?? []), p.user]);
		return out;
	}, [people]);

	const online = useMemo(() => {
		const out = new Set(people.map((p) => p.presence.user.login.toLowerCase()));
		if (me) out.add(me.login.toLowerCase());
		return out;
	}, [people, me]);

	const openFile = useCallback((path: string) => {
		setFile(path);
		setFollowing(null);
	}, []);

	const selectThread = useCallback(
		(id: string | null) => {
			setActive(id);
			if (!id) return;
			const t = threads.find((x) => x.id === id);
			if (!t) return;
			const r = resolved.get(id);
			if (t.anchor.file !== currentFile && room.files.has(t.anchor.file)) setFile(t.anchor.file);
			setRailOpen(true);
			if (r && r.status !== "detached") requestAnimationFrame(() => editor.current?.reveal(r.from));
		},
		[threads, resolved, currentFile, room, setRailOpen],
	);

	const startComment = useCallback(
		(from: number, to: number) => {
			const text = room.files.get(currentFile);
			if (!text) return;
			setActive(null);
			setRailOpen(true);
			const source = text.toString();
			setDraft({
				file: currentFile,
				quote: source.slice(from, to),
				prefix: source.slice(Math.max(0, from - 40), from),
				suffix: source.slice(to, to + 40),
				from,
				to,
			});
		},
		[room, currentFile, setRailOpen],
	);

	function createThread(body: string) {
		const text = draft && room.files.get(draft.file);
		if (!draft || !text) return;
		const id = crypto.randomUUID();
		room.send({
			t: "thread.create",
			id,
			body,
			anchor: createAnchor(text, draft.file, draft.from, draft.to, git?.baseSha ?? ""),
		});
		setDraft(null);
		setActive(id);
	}

	const exists = (path: string) => room.files.has(path) || room.assets.has(path);
	const inFolder = (folder: string) =>
		[...room.files.keys(), ...room.assets.keys()].some((p) => p.startsWith(`${folder}/`));

	/** A folder's placeholder goes once the folder has a real file. */
	function dropPlaceholder(folder: string) {
		if (folder && room.files.has(joinPath(folder, KEEP))) room.files.delete(joinPath(folder, KEEP));
	}

	function createEntry(path: string, kind: "file" | "folder") {
		if (kind === "folder") {
			if (!inFolder(path) && !exists(path)) room.files.set(joinPath(path, KEEP), new Y.Text(""));
			return;
		}
		if (exists(path)) return openFile(path);
		room.doc.transact(() => {
			room.files.set(path, new Y.Text(""));
			dropPlaceholder(path.split("/").slice(0, -1).join("/"));
		});
		openFile(path);
	}

	function moveEntry(from: string, to: string) {
		if (exists(to) || inFolder(to)) {
			room.toast(`${to} already exists`, "error");
			return;
		}
		room.send({ t: "file.move", from, to });
		if (currentFile === from || currentFile.startsWith(`${from}/`))
			setFile(to + currentFile.slice(from.length));
	}

	function deleteEntry(path: string, folder: boolean) {
		const doomed = folder
			? [...room.files.keys(), ...room.assets.keys()].filter((p) => p.startsWith(`${path}/`))
			: [path];
		const what = folder ? `${path} and the ${doomed.length} files in it` : path;
		if (!confirm(`Delete ${what}? It goes away for everyone once you commit.`)) return;
		room.doc.transact(() => {
			for (const p of doomed) {
				room.files.delete(p);
				room.assets.delete(p);
			}
			// Deleting a folder's last file leaves the folder in place.
			const parent = path.split("/").slice(0, -1).join("/");
			if (!folder && parent && !inFolder(parent))
				room.files.set(joinPath(parent, KEEP), new Y.Text(""));
		});
		if (doomed.includes(currentFile)) setFile(null);
	}

	/** Write one file into the room, as text if it is text and as a blob otherwise. */
	async function store(path: string, file: File) {
		if (isTextPath(path) && file.size < 2_000_000) {
			const text = await file.text();
			const existing = room.files.get(path);
			// Diff into an existing file so comments in unchanged text keep their place.
			if (existing) applyMinimalDiff(existing, text);
			else room.files.set(path, new Y.Text(text));
		} else {
			room.assets.set(path, await api.upload(project.id, file));
		}
		dropPlaceholder(parentOf(path));
	}

	async function upload(folder: string, items: Upload[]) {
		const label = items.length === 1 ? items[0].path : `${items.length} files`;
		room.toast(`Uploading ${label}`);
		let failed = 0;
		for (const item of items) {
			try {
				await store(joinPath(folder, item.path), item.file);
			} catch (e) {
				failed++;
				room.toast(`${item.path}: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		}
		if (failed < items.length)
			room.toast(
				`Uploaded ${failed ? `${items.length - failed} of ${items.length} files` : label}`,
			);
		if (items.length === 1 && !failed) openFile(joinPath(folder, items[0].path));
	}

	/** Upload images next to the open file, or into its image folder, and reference them at `at`. */
	async function insertImages(files: File[], at: number, code: boolean) {
		const file = currentFile;
		const text = room.files.get(file);
		if (!text) return null;
		// Edits by others while the upload runs move the drop point, so track it in the document.
		const anchor = Y.createRelativePositionFromTypeIndex(text, at);
		const dir = parentOf(file);
		const sub = IMAGE_DIRS.find((d) => inFolder(joinPath(dir, d)));
		const folder = sub ? joinPath(dir, sub) : dir;

		const taken = new Set<string>();
		const paths: string[] = [];
		room.toast(files.length === 1 ? "Uploading image" : `Uploading ${files.length} images`);
		for (const f of files) {
			const path = freePath(folder, imageName(f), (p) => exists(p) || taken.has(p));
			taken.add(path);
			try {
				await store(path, f);
				paths.push(path);
			} catch (e) {
				room.toast(`${f.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		}
		if (!paths.length) return null;

		const snippet = references(file, paths, code, mainFile);
		const from = Y.createAbsolutePositionFromRelativePosition(anchor, room.doc)?.index ?? at;
		text.insert(from, snippet);
		return { from, to: from + snippet.length };
	}

	async function exportPdf() {
		if (!engine) return;
		const { pdf, diagnostics } = await engine.pdf();
		if (!pdf) {
			room.toast(diagnostics[0]?.message ?? "The document did not compile", "error");
			return;
		}
		const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: "application/pdf" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = pdfName(project.repo, mainFile);
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}

	const sourceFiles = useCallback(() => {
		const out: { path: string; text: string }[] = [];
		const current = room.files.get(currentFile);
		if (current && isSource(format, currentFile))
			out.push({ path: currentFile, text: current.toString() });
		for (const [path, text] of room.files) {
			if (path !== currentFile && isSource(format, path)) out.push({ path, text: text.toString() });
		}
		return out;
	}, [room, currentFile, format]);

	const jumpToSource = useCallback(
		(path: string, offset: number) => {
			if (path !== currentFile) setFile(path);
			requestAnimationFrame(() => editor.current?.reveal(offset));
		},
		[currentFile],
	);

	const syncPreview = useCallback(
		(offset: number) => {
			const text = room.files.get(currentFile);
			if (text && isSource(format, currentFile)) preview.current?.reveal(text.toString(), offset);
		},
		[room, currentFile, format],
	);

	useEffect(() => {
		if (!railOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || drawer) return;
			const t = e.target as HTMLElement;
			if (t.closest(".cm-editor") || t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
			setRailOpen(false);
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [railOpen, drawer, setRailOpen]);

	const fileThreads = useMemo(
		() => threads.filter((t) => t.anchor.file === currentFile),
		[threads, currentFile],
	);
	const openCount = threads.filter((t) => !t.resolved).length;
	const leaderUser = leader?.user;
	const asset = room.assets.get(currentFile);
	const crumbs = currentFile.split("/");

	return (
		<SidebarFrame
			collapsed={collapsed}
			sidebar={
				<>
					<SideHead
						project={project}
						onCollapse={() => setCollapsed(true)}
						onSettings={() => setDrawer("settings")}
					/>
					<div className="side-scroll">
						<FileTree
							files={files}
							assets={assets}
							current={currentFile}
							mainFile={mainFile}
							changed={changed}
							who={who}
							onOpen={openFile}
							onCreate={createEntry}
							onMove={moveEntry}
							onDelete={deleteEntry}
							onUpload={upload}
						/>
					</div>
					<div className="side-pinned">
						<GitSection
							repo={project.repo}
							branch={git?.branch ?? project.branch}
							baseSha={git?.baseSha ?? ""}
							changed={changeCount}
							busy={git?.busy ?? null}
							onCommit={() => setDrawer("commit")}
							onHistory={() => setDrawer("history")}
						/>
						<PeopleSection
							members={project.members}
							online={online}
							onInvite={() => setDrawer("share")}
						/>
					</div>
					<SideFoot me={me} />
				</>
			}
		>
			<div className="main">
				<header className="topbar">
					{collapsed && (
						<button
							type="button"
							className="btn ghost icon"
							aria-label="Show sidebar"
							onClick={() => setCollapsed(false)}
						>
							<PanelLeft size={16} />
						</button>
					)}
					<div className="crumbs">
						<a
							className="dim"
							href={`https://github.com/${owner}`}
							target="_blank"
							rel="noreferrer"
						>
							{owner}
						</a>
						<span className="sep">/</span>
						<a className="dim" href={githubUrl.repo(project.repo)} target="_blank" rel="noreferrer">
							{repoName}
						</a>
						{crumbs.map((c, i) => (
							<span key={crumbs.slice(0, i + 1).join("/")} style={{ display: "contents" }}>
								<span className="sep">/</span>
								{i === crumbs.length - 1 ? (
									<a
										className="here"
										href={githubUrl.file(project.repo, git?.branch ?? project.branch, currentFile)}
										target="_blank"
										rel="noreferrer"
									>
										{c}
									</a>
								) : (
									<span className="dim">{c}</span>
								)}
							</span>
						))}
						<a
							className="btn ghost icon small"
							href={githubUrl.repo(project.repo)}
							target="_blank"
							rel="noreferrer"
							aria-label="Open on GitHub"
							title="Open on GitHub"
						>
							<GithubMark size={14} />
						</a>
					</div>
					{status !== "live" && (
						<span className="status" data-status={status}>
							<i />
							{status === "offline" ? "Reconnecting" : "Connecting"}
						</span>
					)}
					<span className="spacer" />
					<div className="avatars">
						{people.map(({ clientId, presence: p }) => (
							<button
								key={p.user.id}
								type="button"
								aria-pressed={following === clientId}
								title={
									following === clientId ? `Following ${p.user.name}` : `Follow ${p.user.name}`
								}
								style={{ "--ring": p.user.color } as React.CSSProperties}
								onClick={() => setFollowing((f) => (f === clientId ? null : clientId))}
							>
								<img className="avatar" src={p.user.avatar} alt={p.user.name} />
							</button>
						))}
					</div>
					<div className="seg layout-switch">
						{LAYOUTS.map(([value, label, Icon]) => (
							<button
								key={value}
								type="button"
								aria-pressed={layout === value}
								aria-label={label}
								title={label}
								onClick={() => setLayout(value)}
							>
								<Icon size={14} />
							</button>
						))}
					</div>
					<button
						type="button"
						className="btn"
						disabled={!!git?.busy}
						onClick={() => room.send({ t: "git.pull" })}
					>
						<ArrowDownToLine size={14} />
						{git?.busy === "pull" ? "Pulling…" : "Pull"}
					</button>
					<button type="button" className="btn" onClick={exportPdf}>
						<Download size={14} />
						PDF
					</button>
					<button
						type="button"
						className="btn primary"
						disabled={!!git?.busy}
						onClick={() => setDrawer("commit")}
					>
						{git?.busy === "commit" ? "Committing…" : "Commit"}
						{changeCount > 0 && <Count n={changeCount} />}
					</button>
					<span className="vsep" />
					<button
						type="button"
						className="btn ghost"
						aria-pressed={railOpen}
						aria-label={railOpen ? "Hide comments" : "Show comments"}
						onClick={() => setRailOpen((o) => !o)}
					>
						<MessageSquare size={15} />
						{openCount > 0 && <span className="small">{openCount}</span>}
					</button>
				</header>

				{leaderUser && (
					<div className="following" style={{ background: leaderUser.color }}>
						Following {leaderUser.name}
						<button type="button" onClick={() => setFollowing(null)}>
							Stop
						</button>
					</div>
				)}

				<div
					ref={panes}
					className={`panes${dragging ? " dragging" : ""}`}
					data-layout={layout}
					style={{ "--left": `${left}px` } as React.CSSProperties}
				>
					<section className="pane source">
						<div className="pane-head">
							<FileText size={13} />
							<span className="title mono" style={{ fontSize: 12 }}>
								{currentFile}
							</span>
							{changed.has(currentFile) && <span className="dot" />}
							<span className="spacer" />
							{room.files.has(currentFile) && (
								<button
									type="button"
									className="btn ghost icon small"
									aria-label="Comment"
									title={`Comment (${navigator.platform.includes("Mac") ? "⌘⌥M" : "Ctrl+Alt+M"})`}
									// Keeps focus, and so the selection, in the editor.
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => editor.current?.comment()}
								>
									<MessageSquarePlus size={13} />
								</button>
							)}
							<FocusButton pane="source" layout={layout} onChange={setLayout} />
						</div>
						{room.files.has(currentFile) ? (
							<Editor
								ref={editor}
								room={room}
								path={currentFile}
								mainFile={mainFile}
								threads={fileThreads}
								activeThread={active}
								onSelectThread={selectThread}
								onComment={startComment}
								onCursor={syncPreview}
								onImages={insertImages}
								draftPoint={
									draft && draft.file === currentFile && draft.from === draft.to ? draft.from : null
								}
								me={me}
							/>
						) : asset && IMAGE.test(currentFile) ? (
							<div className="asset-view">
								<img src={`/api/projects/${project.id}/blob/${asset.sha}`} alt={currentFile} />
							</div>
						) : (
							<div className="empty">
								{status === "live" ? (
									<div>
										<div className="icon-tile">
											<FileText size={18} />
										</div>
										<h3>{asset ? "Binary file" : "No such file"}</h3>
									</div>
								) : (
									<div className="loader" />
								)}
							</div>
						)}
					</section>
					<Gutter
						width={left}
						onDragging={(d) => {
							// Lock the editor and preview to their current widths so a drag only clips them.
							const el = panes.current;
							if (el && d) {
								const ed = el.querySelector<HTMLElement>(".source .editor");
								const pv = el.querySelector<HTMLElement>(".preview-scroll");
								el.style.setProperty("--lock-src", `${ed?.offsetWidth ?? 0}px`);
								el.style.setProperty("--lock-prev", `${pv?.offsetWidth ?? 0}px`);
							}
							setDragging(d);
						}}
						onMove={(w) => panes.current?.style.setProperty("--left", `${w}px`)}
						onDone={setLeft}
					/>
					<section className="pane preview">
						{engine && (
							<Preview
								ref={preview}
								room={room}
								engine={engine}
								presence={presence}
								following={following}
								frozen={dragging}
								sourceFiles={sourceFiles}
								mainFile={mainFile}
								actions={<FocusButton pane="preview" layout={layout} onChange={setLayout} />}
								onJump={jumpToSource}
								onDiagnostic={(path, line) => {
									if (path && room.files.has(path)) setFile(path);
									requestAnimationFrame(() => editor.current?.gotoLine(line));
								}}
							/>
						)}
					</section>
				</div>
				{railOpen && (
					<section className="rail">
						<Rail
							threads={threads}
							resolved={resolved}
							active={active}
							draft={draft}
							me={me}
							git={git}
							doc={room.doc}
							currentFile={currentFile}
							onSelect={selectThread}
							onCreate={createThread}
							onCancelDraft={() => setDraft(null)}
							onReply={(threadId, body) =>
								room.send({ t: "comment.add", threadId, id: crypto.randomUUID(), body })
							}
							onEdit={(id, body) => room.send({ t: "comment.edit", id, body })}
							onDelete={(id) => room.send({ t: "comment.delete", id })}
							onResolve={(id, isResolved) =>
								room.send({ t: "thread.resolve", id, resolved: isResolved })
							}
							onClose={() => setRailOpen(false)}
						/>
					</section>
				)}
			</div>

			{drawer === "commit" && (
				<CommitDrawer
					room={room}
					projectId={project.id}
					changed={changed}
					repo={project.repo}
					branch={git?.branch ?? project.branch}
					onClose={() => setDrawer(null)}
					onCommit={(message) => {
						room.send({ t: "git.commit", message });
						setDrawer(null);
					}}
				/>
			)}
			{drawer === "settings" && (
				<SettingsDrawer project={project} onChange={reload} onClose={() => setDrawer(null)} />
			)}
			{drawer === "share" && (
				<ShareDrawer project={project} me={me} onChange={reload} onClose={() => setDrawer(null)} />
			)}
			{drawer === "history" && (
				<HistoryDrawer
					projectId={project.id}
					repo={project.repo}
					branch={git?.branch ?? project.branch}
					baseSha={git?.baseSha ?? ""}
					uncommitted={changeCount}
					onClose={() => setDrawer(null)}
				/>
			)}

			<div className="toasts">
				{toasts.map((t) => (
					<div key={t.id} className={`toast ${t.tone}`}>
						{t.tone === "ok" ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
						{t.text}
					</div>
				))}
			</div>
		</SidebarFrame>
	);
}

type Layout = "split" | "source" | "preview";

const LAYOUTS = [
	["source", "Editor only", Code],
	["split", "Editor and preview", Columns2],
	["preview", "Preview only", BookOpen],
] as const;

function FocusButton({
	pane,
	layout,
	onChange,
}: {
	pane: "source" | "preview";
	layout: Layout;
	onChange(layout: Layout): void;
}) {
	const focused = layout === pane;
	const label = focused ? "Show both panes" : pane === "source" ? "Editor only" : "Preview only";
	return (
		<button
			type="button"
			className="btn ghost icon small"
			aria-label={label}
			title={label}
			onClick={() => onChange(focused ? "split" : pane)}
		>
			{focused ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
		</button>
	);
}

function Count({ n }: { n: number }) {
	const [bump, setBump] = useState(false);
	const prev = useRef(n);
	useEffect(() => {
		if (n === prev.current) return;
		prev.current = n;
		setBump(true);
		const t = setTimeout(() => setBump(false), 300);
		return () => clearTimeout(t);
	}, [n]);
	return <span className={`count${bump ? " bump" : ""}`}>{n}</span>;
}

/**
 * Dragging writes the width straight to a CSS variable on the panes, so a
 * drag costs no React renders. The width is committed once on release.
 */
function Gutter({
	width,
	onMove,
	onDone,
	onDragging,
}: {
	width: number;
	onMove(width: number): void;
	onDone(width: number): void;
	onDragging(dragging: boolean): void;
}) {
	const drag = useRef<{ startX: number; startW: number; w: number } | null>(null);
	const [active, setActive] = useState(false);
	const clampW = (w: number) => Math.max(260, Math.min(window.innerWidth - 420, w));
	return (
		<div
			className={`gutter${active ? " dragging" : ""}`}
			onPointerDown={(e) => {
				e.currentTarget.setPointerCapture(e.pointerId);
				drag.current = { startX: e.clientX, startW: width, w: width };
				setActive(true);
				onDragging(true);
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				if (!d) return;
				d.w = clampW(d.startW + e.clientX - d.startX);
				onMove(d.w);
			}}
			onPointerUp={() => {
				const d = drag.current;
				drag.current = null;
				setActive(false);
				onDragging(false);
				if (d) onDone(d.w);
			}}
		/>
	);
}

function CommitDrawer({
	room,
	projectId,
	changed,
	repo,
	branch,
	onCommit,
	onClose,
}: {
	room: Room;
	projectId: string;
	changed: Set<string>;
	repo: string;
	branch: string;
	onCommit(message: string): void;
	onClose(): void;
}) {
	const [message, setMessage] = useState("");
	const [mode, setMode] = useDiffMode();
	// Files start folded into an overview. The counter remounts them all when expanding or collapsing every file.
	const [allOpen, setAllOpen] = useState(false);
	const [generation, setGeneration] = useState(0);
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => input.current?.focus(), []);

	// Uncommitted changes as diffs in the shape GitHub returns, so they render in the history viewer.
	const files = useMemo<CommitFile[]>(() => {
		const { paths, renames } = pairRenames(room, [...changed].sort());
		return paths.map((path): CommitFile => {
			const from = renames.get(path);
			if (from) {
				const blob = room.assets.get(path);
				return {
					path,
					previousPath: from,
					status: "renamed",
					additions: 0,
					deletions: 0,
					patch: blob ? null : "",
					sha: blob?.sha ?? null,
					binary: !!blob,
				};
			}
			const asset = room.assets.get(path);
			const baseAsset = room.baseAssets.get(path);
			if (asset || baseAsset) {
				return {
					path,
					previousPath: null,
					status: !asset ? "removed" : baseAsset ? "modified" : "added",
					additions: 0,
					deletions: 0,
					patch: null,
					sha: (asset ?? baseAsset)?.sha ?? null,
					binary: true,
				};
			}
			const now = room.files.get(path)?.toString();
			const base = room.base.get(path);
			const diff = localPatch(base ?? "", now ?? "");
			return {
				path,
				previousPath: null,
				status: now === undefined ? "removed" : base === undefined ? "added" : "modified",
				additions: diff.additions,
				deletions: diff.deletions,
				patch: diff.patch ?? "",
				sha: null,
				binary: false,
			};
		});
	}, [changed, room]);
	const additions = files.reduce((n, f) => n + f.additions, 0);
	const deletions = files.reduce((n, f) => n + f.deletions, 0);

	return (
		<Drawer
			title="Commit changes"
			width={980}
			onClose={onClose}
			footer={
				<>
					<span className="small muted" style={{ marginRight: "auto" }}>
						Pushes to <span className="mono">{branch}</span> on {repo}. Changes pushed by others are
						merged in first.
					</span>
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="btn primary"
						disabled={!changed.size}
						onClick={() => onCommit(message)}
					>
						Commit and push
					</button>
				</>
			}
		>
			{changed.size === 0 ? (
				<div className="empty" style={{ height: 200 }}>
					<div>
						<div className="icon-tile">
							<CircleCheck size={18} />
						</div>
						<h3>No changes</h3>
					</div>
				</div>
			) : (
				<>
					<div className="form-row">
						<label className="label" htmlFor="commit-message">
							Message
						</label>
						<textarea
							id="commit-message"
							ref={input}
							className="field"
							rows={2}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onCommit(message);
							}}
						/>
					</div>
					<div className="form-row commit-summary">
						<span className="diff-total">
							{files.length} file{files.length === 1 ? "" : "s"}
							<Counts additions={additions} deletions={deletions} />
						</span>
						<span className="spacer" />
						<button
							type="button"
							className="btn ghost small"
							onClick={() => {
								setAllOpen((o) => !o);
								setGeneration((g) => g + 1);
							}}
						>
							{allOpen ? "Collapse all" : "Expand all"}
						</button>
						<div className="seg" role="tablist" aria-label="Diff layout">
							{(["unified", "split"] as const).map((m) => (
								<button
									key={m}
									type="button"
									role="tab"
									aria-selected={mode === m}
									onClick={() => setMode(m)}
								>
									{m === "unified" ? "Unified" : "Split"}
								</button>
							))}
						</div>
					</div>
					<div className="commit-diffs">
						{files.map((f) => (
							<FileDiff
								key={`${f.path}:${generation}`}
								file={f}
								defaultOpen={allOpen}
								mode={mode}
								projectId={projectId}
								githubUrl={`https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${f.path}`}
							/>
						))}
					</div>
				</>
			)}
		</Drawer>
	);
}

/**
 * A file removed at one path and added unchanged at another is a move. Show it
 * as one rename, as git will record it, instead of a deletion plus an addition.
 */
function pairRenames(
	room: Room,
	paths: string[],
): { paths: string[]; renames: Map<string, string> } {
	const key = (path: string, side: "now" | "base") => {
		const asset = side === "now" ? room.assets.get(path) : room.baseAssets.get(path);
		if (asset) return `blob:${asset.sha}`;
		const text = side === "now" ? room.files.get(path)?.toString() : room.base.get(path);
		return text === undefined ? null : `text:${text}`;
	};
	const removed = new Map<string, string>();
	for (const p of paths) {
		const gone = !room.files.has(p) && !room.assets.has(p);
		const k = gone ? key(p, "base") : null;
		if (k && !removed.has(k)) removed.set(k, p);
	}
	const renames = new Map<string, string>();
	for (const p of paths) {
		const added = !room.base.has(p) && !room.baseAssets.has(p);
		const k = added ? key(p, "now") : null;
		const from = k ? removed.get(k) : undefined;
		if (from) {
			renames.set(p, from);
			removed.delete(k as string);
		}
	}
	const moved = new Set(renames.values());
	return { paths: paths.filter((p) => !moved.has(p)), renames };
}

function ShareDrawer({
	project,
	me,
	onChange,
	onClose,
}: {
	project: ProjectWithMembers;
	me: User | null;
	onChange(): void;
	onClose(): void;
}) {
	const [login, setLogin] = useState("");
	const [error, setError] = useState("");
	const isOwner = project.role === "owner";

	async function invite() {
		setError("");
		try {
			await api.invite(project.id, login);
			setLogin("");
			onChange();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	return (
		<Drawer title="People" onClose={onClose}>
			{isOwner && (
				<form
					className="form-row"
					onSubmit={(e) => {
						e.preventDefault();
						void invite();
					}}
				>
					<label className="label" htmlFor="invite-login">
						Invite by GitHub username
					</label>
					<div className="row">
						<input
							id="invite-login"
							className="field"
							value={login}
							onChange={(e) => setLogin(e.target.value)}
							spellCheck={false}
						/>
						<button
							type="submit"
							className="btn primary"
							style={{ height: 30 }}
							disabled={!login.trim()}
						>
							Invite
						</button>
					</div>
					{error && <div className="form-error">{error}</div>}
				</form>
			)}
			<div className="form-row">
				{project.members.map((m) => (
					<div key={m.login} className="member">
						{m.avatar ? (
							<img className="avatar" src={m.avatar} alt="" />
						) : (
							<span className="avatar" />
						)}
						<div className="who">
							<div style={{ fontWeight: 500 }}>{m.name ?? m.login}</div>
							<div className="small muted">
								@{m.login}
								{m.role === "owner" ? " · owner" : !m.name ? " · not signed in yet" : ""}
							</div>
						</div>
						{isOwner && m.role !== "owner" && m.login !== me?.login && (
							<button
								type="button"
								className="btn small"
								onClick={() => api.removeMember(project.id, m.login).then(onChange)}
							>
								Remove
							</button>
						)}
					</div>
				))}
			</div>
			<p className="small muted" style={{ margin: "16px 0 0" }}>
				Committing needs push access to {project.repo} on GitHub.
			</p>
		</Drawer>
	);
}

function SettingsDrawer({
	project,
	onChange,
	onClose,
}: {
	project: ProjectWithMembers;
	onChange(): void;
	onClose(): void;
}) {
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const file = useRef<HTMLInputElement>(null);
	const isOwner = project.role === "owner";

	async function save(icon: string | null) {
		setBusy(true);
		setError("");
		try {
			await api.updateProject(project.id, { icon });
			onChange();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Drawer title="Project settings" onClose={onClose}>
			<div className="form-row">
				<span className="label">Icon</span>
				<div className="row" style={{ alignItems: "center", gap: 14 }}>
					<ProjectIcon project={project} size={56} />
					{isOwner && (
						<div className="row">
							<button
								type="button"
								className="btn"
								disabled={busy}
								onClick={() => file.current?.click()}
							>
								Upload image
							</button>
							{project.icon && (
								<button
									type="button"
									className="btn ghost"
									disabled={busy}
									onClick={() => save(null)}
								>
									<GeneratedIcon seed={project.repo} size={16} />
									Use generated
								</button>
							)}
						</div>
					)}
				</div>
				<input
					ref={file}
					type="file"
					accept="image/*"
					hidden
					onChange={async (e) => {
						const f = e.target.files?.[0];
						e.target.value = "";
						if (f) await save(await iconFromFile(f));
					}}
				/>
				{error && <div className="form-error">{error}</div>}
			</div>
			<div className="form-row">
				<span className="label">Repository</span>
				<div className="mono small">
					{project.repo} · {project.branch} · {project.mainFile}
				</div>
			</div>
			{isOwner && (
				<div className="form-row" style={{ marginTop: 32 }}>
					<span className="label">Delete project</span>
					<p className="small muted" style={{ margin: "0 0 10px" }}>
						Removes the project and its comments from annomate. The GitHub repo is not touched.
					</p>
					<button
						type="button"
						className="btn"
						style={{ color: "var(--danger)" }}
						disabled={busy}
						onClick={async () => {
							if (!confirm(`Delete ${project.repo} from annomate? Comments cannot be recovered.`))
								return;
							await api.deleteProject(project.id);
							navigate("/");
						}}
					>
						Delete project
					</button>
				</div>
			)}
		</Drawer>
	);
}
