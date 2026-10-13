import {
	ChevronRight,
	File,
	FileCode2,
	FileImage,
	FileJson,
	FilePlus,
	FileText,
	Folder,
	FolderOpen,
	FolderPlus,
	Trash2,
} from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { formatOf } from "../../shared/formats";
import type { Presence } from "../../shared/protocol";
import { DRAG_TYPE } from "../editor/references";

/** Git keeps no empty folders, so a new folder holds this until it has files. The tree hides it. */
export const KEEP = ".gitkeep";

export interface Upload {
	path: string;
	file: File;
}

interface TreeNode {
	name: string;
	path: string;
	children?: TreeNode[];
	binary?: boolean;
}

export const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const baseName = (path: string) => path.split("/").pop() ?? path;
export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

function buildTree(text: string[], binary: string[]): TreeNode[] {
	const root: TreeNode = { name: "", path: "", children: [] };
	const add = (path: string, isBinary: boolean) => {
		const parts = path.split("/");
		const hidden = parts[parts.length - 1] === KEEP;
		let node = root;
		parts.forEach((part, i) => {
			const leaf = i === parts.length - 1;
			if (leaf && hidden) return;
			const sub = parts.slice(0, i + 1).join("/");
			let child = node.children?.find((c) => c.name === part && !!c.children === !leaf);
			if (!child) {
				child = leaf
					? { name: part, path: sub, binary: isBinary }
					: { name: part, path: sub, children: [] };
				node.children?.push(child);
			}
			node = child;
		});
	};
	for (const p of text) add(p, false);
	for (const p of binary) add(p, true);
	const sort = (nodes: TreeNode[]) => {
		nodes.sort((a, b) =>
			!!b.children !== !!a.children ? (b.children ? 1 : -1) : a.name.localeCompare(b.name),
		);
		for (const n of nodes) if (n.children) sort(n.children);
	};
	sort(root.children ?? []);
	return root.children ?? [];
}

function iconFor(path: string, binary?: boolean) {
	if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return <FileImage size={14} />;
	if (formatOf(path)) return <FileText size={14} />;
	if (/\.(json|ya?ml|toml)$/i.test(path)) return <FileJson size={14} />;
	if (/\.(bib|csv|csl|xml)$/i.test(path)) return <FileCode2 size={14} />;
	return <File size={14} style={binary ? { opacity: 0.6 } : undefined} />;
}

/** Read dropped files and folders from Finder. Entries must be taken before the first await. */
async function collectDropped(dt: DataTransfer): Promise<Upload[]> {
	const entries = [...dt.items]
		.map((item) => item.webkitGetAsEntry?.())
		.filter((e): e is FileSystemEntry => !!e);
	if (!entries.length) return [...dt.files].map((file) => ({ path: file.name, file }));
	const out: Upload[] = [];
	const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
		if (entry.name.startsWith(".") && entry.name !== KEEP) return;
		if (entry.isFile) {
			const file = await new Promise<File>((res, rej) =>
				(entry as FileSystemFileEntry).file(res, rej),
			);
			out.push({ path: prefix + entry.name, file });
		} else if (entry.isDirectory) {
			const reader = (entry as FileSystemDirectoryEntry).createReader();
			for (;;) {
				const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
					reader.readEntries(res, rej),
				);
				if (!batch.length) break;
				for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
			}
		}
	};
	for (const e of entries) await walk(e, "");
	return out;
}

type Editing =
	| { mode: "create"; parent: string; kind: "file" | "folder" }
	| { mode: "rename"; path: string; folder: boolean };

interface Props {
	files: string[];
	assets: string[];
	current: string;
	mainFile: string;
	changed: Set<string>;
	/** Who has each file open. */
	who: Map<string, Presence["user"][]>;
	onOpen(path: string): void;
	onCreate(path: string, kind: "file" | "folder"): void;
	onMove(from: string, to: string): void;
	onDelete(path: string, folder: boolean): void;
	onUpload(folder: string, items: Upload[]): void;
}

export function FileTree({
	files,
	assets,
	current,
	mainFile,
	changed,
	who,
	onOpen,
	onCreate,
	onMove,
	onDelete,
	onUpload,
}: Props) {
	const tree = useMemo(() => buildTree(files, assets), [files, assets]);
	const [closed, setClosed] = useState<Set<string>>(new Set());
	const [editing, setEditing] = useState<Editing | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	const openTimer = useRef<{ path: string; timer: number } | null>(null);

	// Folders without document source (figures, data, fonts) start collapsed, once the files arrive.
	const seeded = useRef(false);
	useEffect(() => {
		if (seeded.current || !files.length) return;
		seeded.current = true;
		const folders = new Set<string>();
		for (const p of [...files, ...assets]) {
			const parts = p.split("/");
			for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
		}
		const sources = files.filter((p) => formatOf(p));
		setClosed(new Set([...folders].filter((f) => !sources.some((p) => p.startsWith(`${f}/`)))));
	}, [files, assets]);

	const setOpen = (path: string, open: boolean) =>
		setClosed((s) => {
			const next = new Set(s);
			if (open) next.delete(path);
			else next.add(path);
			return next;
		});

	const startCreate = (parent: string, kind: "file" | "folder") => {
		if (parent) setOpen(parent, true);
		setEditing({ mode: "create", parent, kind });
	};

	// Drag and drop: moves within the tree, uploads from outside.
	const accepts = (e: DragEvent) =>
		e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes("Files");
	const over = (e: DragEvent, folder: string, closedFolder?: boolean) => {
		if (!accepts(e)) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_TYPE) ? "move" : "copy";
		if (dropTarget !== folder) setDropTarget(folder);
		if (closedFolder && openTimer.current?.path !== folder) {
			if (openTimer.current) clearTimeout(openTimer.current.timer);
			openTimer.current = {
				path: folder,
				timer: window.setTimeout(() => setOpen(folder, true), 600),
			};
		}
	};
	const endDrag = () => {
		setDropTarget(null);
		setDragging(null);
		if (openTimer.current) clearTimeout(openTimer.current.timer);
		openTimer.current = null;
	};
	const drop = (e: DragEvent, folder: string) => {
		if (!accepts(e)) return;
		e.preventDefault();
		e.stopPropagation();
		const from = e.dataTransfer.getData(DRAG_TYPE);
		endDrag();
		if (from) {
			if (parentOf(from) === folder || folder === from || folder.startsWith(`${from}/`)) return;
			onMove(from, joinPath(folder, baseName(from)));
			if (folder) setOpen(folder, true);
			return;
		}
		void collectDropped(e.dataTransfer).then((items) => {
			if (items.length) onUpload(folder, items);
			if (folder) setOpen(folder, true);
		});
	};
	const dragProps = (path: string) => ({
		draggable: editing === null,
		onDragStart: (e: DragEvent) => {
			e.dataTransfer.setData(DRAG_TYPE, path);
			// Copy lets the editor take the drop as a reference to the file.
			e.dataTransfer.effectAllowed = "copyMove";
			setDragging(path);
		},
		onDragEnd: endDrag,
	});

	const nameInput = (
		key: string,
		depth: number,
		icon: ReactNode,
		initial: string,
		done: (name: string) => void,
	) => (
		<li key={key}>
			<NameInput
				depth={depth}
				icon={icon}
				initial={initial}
				onDone={done}
				onCancel={() => setEditing(null)}
			/>
		</li>
	);

	const createRow = (parent: string, depth: number) =>
		editing?.mode === "create" && editing.parent === parent
			? nameInput(
					`new:${parent}`,
					depth,
					editing.kind === "folder" ? <Folder size={14} /> : <FileText size={14} />,
					"",
					(name) => {
						setEditing(null);
						if (name) onCreate(joinPath(parent, name), editing.kind);
					},
				)
			: null;

	const render = (nodes: TreeNode[], parent: string, depth: number): ReactNode => (
		<ul className="tree">
			{createRow(parent, depth)}
			{nodes.map((n) => {
				const renaming = editing?.mode === "rename" && editing.path === n.path;
				if (renaming) {
					return nameInput(
						`rename:${n.path}`,
						depth,
						n.children ? <Folder size={14} /> : iconFor(n.path, n.binary),
						n.name,
						(name) => {
							setEditing(null);
							if (name && name !== n.name) onMove(n.path, joinPath(parentOf(n.path), name));
						},
					);
				}
				if (n.children) {
					const isOpen = !closed.has(n.path);
					return (
						<li
							key={n.path}
							className={dropTarget === n.path ? "drop-target" : undefined}
							onDragOver={(e) => over(e, n.path, !isOpen)}
							onDrop={(e) => drop(e, n.path)}
						>
							<div
								className={`file-row${dragging === n.path ? " dragging" : ""}`}
								{...dragProps(n.path)}
							>
								<button
									type="button"
									className="nav"
									aria-expanded={isOpen}
									style={{ paddingLeft: 8 + depth * 12 }}
									onClick={() => setOpen(n.path, !isOpen)}
									onDoubleClick={() => setEditing({ mode: "rename", path: n.path, folder: true })}
								>
									<ChevronRight size={12} className="chev" />
									{isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
									<span className="grow">{n.name}</span>
									{!isOpen && [...changed].some((c) => c.startsWith(`${n.path}/`)) && (
										<span className="dot" />
									)}
								</button>
								<span className="row-actions">
									<button
										type="button"
										aria-label={`New file in ${n.name}`}
										title="New file"
										onClick={() => startCreate(n.path, "file")}
									>
										<FilePlus size={13} />
									</button>
									<button
										type="button"
										aria-label={`New folder in ${n.name}`}
										title="New folder"
										onClick={() => startCreate(n.path, "folder")}
									>
										<FolderPlus size={13} />
									</button>
									<button
										type="button"
										className="danger"
										aria-label={`Delete ${n.name}`}
										title="Delete folder"
										onClick={() => onDelete(n.path, true)}
									>
										<Trash2 size={13} />
									</button>
								</span>
							</div>
							{isOpen && render(n.children, n.path, depth + 1)}
						</li>
					);
				}
				const here = who.get(n.path) ?? [];
				return (
					<li
						key={n.path}
						onDragOver={(e) => over(e, parentOf(n.path))}
						onDrop={(e) => drop(e, parentOf(n.path))}
					>
						<div
							className={`file-row${dragging === n.path ? " dragging" : ""}`}
							{...dragProps(n.path)}
						>
							<button
								type="button"
								className={`nav${n.binary ? " dim" : ""}`}
								aria-current={n.path === current}
								style={{ paddingLeft: 20 + depth * 12 }}
								onClick={() => onOpen(n.path)}
								onDoubleClick={() => setEditing({ mode: "rename", path: n.path, folder: false })}
							>
								{iconFor(n.path, n.binary)}
								<span
									className="grow"
									style={n.path === mainFile ? { fontWeight: 600 } : undefined}
								>
									{n.name}
								</span>
								<span className="trail">
									{here.length > 0 && (
										<span className="mini-avatars">
											{here.map((u) => (
												<img
													key={u.id}
													src={u.avatar}
													alt={u.name}
													style={{ borderColor: u.color }}
												/>
											))}
										</span>
									)}
									{changed.has(n.path) && <span className="dot" />}
								</span>
							</button>
							{n.path !== mainFile && (
								<span className="row-actions">
									<button
										type="button"
										className="danger"
										aria-label={`Delete ${n.name}`}
										title="Delete"
										onClick={() => onDelete(n.path, false)}
									>
										<Trash2 size={13} />
									</button>
								</span>
							)}
						</div>
					</li>
				);
			})}
		</ul>
	);

	return (
		<section
			aria-label="Files"
			className={`side-section file-tree${dropTarget === "" ? " drop-root" : ""}`}
			onDragOver={(e) => over(e, "")}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) endDrag();
			}}
			onDrop={(e) => drop(e, "")}
		>
			<div className="side-label">
				Files
				<span className="label-actions">
					<button
						type="button"
						className="btn ghost icon small"
						aria-label="New file"
						title="New file"
						onClick={() => startCreate("", "file")}
					>
						<FilePlus size={14} />
					</button>
					<button
						type="button"
						className="btn ghost icon small"
						aria-label="New folder"
						title="New folder"
						onClick={() => startCreate("", "folder")}
					>
						<FolderPlus size={14} />
					</button>
				</span>
			</div>
			{render(tree, "", 0)}
		</section>
	);
}

function NameInput({
	depth,
	icon,
	initial,
	onDone,
	onCancel,
}: {
	depth: number;
	icon: ReactNode;
	initial: string;
	onDone(name: string): void;
	onCancel(): void;
}) {
	const [value, setValue] = useState(initial);
	const ref = useRef<HTMLInputElement>(null);
	const finished = useRef(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.focus();
		// Select the name without its extension, as Finder does.
		const dot = initial.lastIndexOf(".");
		el.setSelectionRange(0, dot > 0 ? dot : initial.length);
	}, [initial]);
	const finish = (commit: boolean) => {
		if (finished.current) return;
		finished.current = true;
		const name = value.trim().replace(/^\/+|\/+$/g, "");
		if (commit && name) onDone(name);
		else onCancel();
	};
	return (
		<div className="nav name-input" style={{ paddingLeft: 20 + depth * 12 }}>
			{icon}
			<input
				ref={ref}
				value={value}
				spellCheck={false}
				aria-label="Name"
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") finish(true);
					if (e.key === "Escape") finish(false);
				}}
				onBlur={() => finish(true)}
			/>
		</div>
	);
}
