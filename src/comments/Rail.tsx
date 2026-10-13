import { Check, MessageSquare, RotateCcw, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { type InlineDiff, inlineDiff, isPoint, type Resolved } from "../../shared/anchor";
import type { GitState, Thread, User } from "../../shared/protocol";
import { ago } from "../api";
import { ConnectAgent } from "./ConnectAgent";
import { ExportMenu } from "./ExportMenu";

export interface Draft {
	file: string;
	quote: string;
	/** For a comment on a point, the text either side of it. */
	prefix: string;
	suffix: string;
}

/** Shows where a point sits, as the line around it with a caret. */
function PointQuote({ prefix, suffix }: { prefix: string; suffix: string }) {
	const line = prefix.split("\n").pop() ?? "";
	// Start and end on whole words where the line is cut short.
	const before = line.length > 28 ? line.slice(-28).replace(/^\S*\s/, "") : line;
	const rest = suffix.split("\n")[0];
	const after = rest.length > 28 ? rest.slice(0, 28).replace(/\s\S*$/, "") : rest;
	return (
		<span className="point-quote">
			{before}
			<i />
			{after}
		</span>
	);
}

interface Props {
	threads: Thread[];
	resolved: Map<string, Resolved>;
	active: string | null;
	draft: Draft | null;
	me: User | null;
	git: GitState | null;
	/** The shared document, which comment exports read the commented text from. */
	doc: Y.Doc;
	currentFile: string;
	onSelect(id: string | null): void;
	onCreate(body: string): void;
	onCancelDraft(): void;
	onReply(threadId: string, body: string): void;
	onEdit(commentId: string, body: string): void;
	onDelete(commentId: string): void;
	onResolve(threadId: string, resolved: boolean): void;
	onClose(): void;
}

export function Rail(props: Props) {
	const { threads, resolved, active, draft, currentFile } = props;
	const [tab, setTab] = useState<"open" | "resolved">("open");
	const [connecting, setConnecting] = useState(false);
	const visible = threads.filter((t) => t.resolved === (tab === "resolved"));
	const openCount = threads.filter((t) => !t.resolved).length;
	const activeResolved = threads.find((t) => t.id === active)?.resolved;
	useEffect(() => {
		if (activeResolved !== undefined) setTab(activeResolved ? "resolved" : "open");
	}, [activeResolved]);

	// Current file first, in document order. Then other files, grouped.
	const byFile = new Map<string, Thread[]>();
	for (const t of visible) {
		const list = byFile.get(t.anchor.file) ?? [];
		list.push(t);
		byFile.set(t.anchor.file, list);
	}
	const position = (t: Thread) => {
		const r = resolved.get(t.id);
		return r && r.status !== "detached" ? r.from : Number.MAX_SAFE_INTEGER - t.anchor.line;
	};
	const files = [...byFile.keys()].sort((a, b) =>
		a === currentFile ? -1 : b === currentFile ? 1 : a.localeCompare(b),
	);

	return (
		<>
			<div className="pane-head">
				<span className="title">Comments</span>
				<span className="spacer" />
				<div className="seg" role="tablist">
					<button
						type="button"
						role="tab"
						aria-selected={tab === "open"}
						onClick={() => setTab("open")}
					>
						Open{openCount > 0 && ` ${openCount}`}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "resolved"}
						onClick={() => setTab("resolved")}
					>
						Resolved
					</button>
				</div>
				{props.git && (
					<ExportMenu
						doc={props.doc}
						threads={threads}
						git={props.git}
						onConnect={() => setConnecting(true)}
					/>
				)}
				<button
					type="button"
					className="btn ghost icon small"
					aria-label="Hide comments"
					onClick={props.onClose}
				>
					<X size={14} />
				</button>
			</div>
			{connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
			<div className="rail-list">
				{draft && (
					<DraftCard draft={draft} onCreate={props.onCreate} onCancel={props.onCancelDraft} />
				)}
				{files.map((file) => (
					<section key={file}>
						{(files.length > 1 || file !== currentFile) && <div className="rail-group">{file}</div>}
						{(byFile.get(file) ?? [])
							.sort((a, b) => position(a) - position(b))
							.map((t) => (
								<ThreadCard
									key={t.id}
									{...props}
									thread={t}
									resolution={resolved.get(t.id)}
									isActive={t.id === active}
								/>
							))}
					</section>
				))}
				{!visible.length && !draft && (
					<div className="empty" style={{ height: "auto", paddingTop: 48 }}>
						<div>
							<div className="icon-tile">
								<MessageSquare size={18} />
							</div>
							<h3>{tab === "open" ? "No open comments" : "Nothing resolved yet"}</h3>
						</div>
					</div>
				)}
			</div>
		</>
	);
}

function submitOnEnter(
	e: KeyboardEvent<HTMLTextAreaElement>,
	submit: () => void,
	cancel?: () => void,
) {
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		submit();
	} else if (e.key === "Escape" && cancel) {
		e.preventDefault();
		cancel();
	}
}

function DraftCard({
	draft,
	onCreate,
	onCancel,
}: {
	draft: Draft;
	onCreate(body: string): void;
	onCancel(): void;
}) {
	const [body, setBody] = useState("");
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => input.current?.focus(), []);
	const submit = () => body.trim() && onCreate(body.trim());
	return (
		<div className="thread active">
			<div className="quote">
				{draft.quote ? (
					<mark>{draft.quote}</mark>
				) : (
					<PointQuote prefix={draft.prefix} suffix={draft.suffix} />
				)}
			</div>
			<div className="reply" style={{ marginTop: 0 }}>
				<textarea
					ref={input}
					className="field"
					value={body}
					onChange={(e) => setBody(e.target.value)}
					onKeyDown={(e) => submitOnEnter(e, submit, onCancel)}
				/>
				<div className="reply-row">
					<button type="button" className="btn ghost small" onClick={onCancel}>
						Cancel
					</button>
					<button
						type="button"
						className="btn primary small"
						disabled={!body.trim()}
						onClick={submit}
					>
						Comment
					</button>
				</div>
			</div>
		</div>
	);
}

function Diff({ diff }: { diff: InlineDiff }) {
	return (
		<div className="diff">
			{diff.map(([op, text], i) =>
				op === -1 ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff chunks are positional
					<del key={i}>{text}</del>
				) : op === 1 ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff chunks are positional
					<ins key={i}>{text}</ins>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff chunks are positional
					<span key={i}>{text}</span>
				),
			)}
		</div>
	);
}

function ThreadCard({
	thread,
	resolution: resolved,
	isActive,
	me,
	git,
	onSelect,
	onReply,
	onEdit,
	onDelete,
	onResolve,
}: Props & { thread: Thread; resolution?: Resolved; isActive: boolean }) {
	const [reply, setReply] = useState("");
	const [leaving, setLeaving] = useState(false);
	const card = useRef<HTMLElement>(null);
	useEffect(() => {
		if (isActive) revealCard(card.current);
	}, [isActive]);
	const status = resolved?.status ?? "detached";
	// Let the tick pop before the card leaves its list.
	const toggleResolved = () => {
		setLeaving(true);
		setTimeout(() => onResolve(thread.id, !thread.resolved), 220);
	};
	const { anchor } = thread;
	const sendReply = () => {
		if (!reply.trim()) return;
		onReply(thread.id, reply.trim());
		setReply("");
	};
	const githubUrl =
		git && `https://github.com/${git.repo}/blob/${anchor.commit}/${anchor.file}#L${anchor.line}`;

	return (
		<article
			ref={card}
			className={`thread${isActive ? " active" : ""}${thread.resolved ? " resolved" : ""}${leaving ? " leaving" : ""}`}
			onClickCapture={(e) => {
				if ((e.target as Element).closest(".thread-resolve")) return;
				if (!isActive) onSelect(thread.id);
			}}
		>
			<button
				type="button"
				className={`thread-resolve${thread.resolved ? " reopen" : ""}`}
				onClick={toggleResolved}
			>
				{thread.resolved ? (
					<RotateCcw size={12} strokeWidth={2.5} />
				) : (
					<Check size={13} strokeWidth={3} />
				)}
				{thread.resolved ? "Reopen" : "Resolve"}
			</button>
			{status === "detached" && <span className="badge detached">Original text removed</span>}
			{status === "edited" && <span className="badge">Text changed</span>}

			{status === "edited" && isActive && resolved ? (
				<Diff diff={inlineDiff(anchor.quote, resolved.current)} />
			) : (
				<button type="button" className="quote" onClick={() => onSelect(thread.id)}>
					{isPoint(anchor) ? (
						<PointQuote prefix={anchor.prefix} suffix={anchor.suffix} />
					) : (
						<mark>{anchor.quote}</mark>
					)}
				</button>
			)}

			{status === "detached" && isActive && githubUrl && (
				<p className="small" style={{ margin: "0 0 10px" }}>
					<a href={githubUrl} target="_blank" rel="noreferrer">
						{anchor.file}:{anchor.line} at {anchor.commit.slice(0, 7)}
					</a>
				</p>
			)}

			{thread.comments.map((c) => (
				<CommentView
					key={c.id}
					comment={c}
					mine={c.author.id === me?.id}
					onEdit={onEdit}
					onDelete={onDelete}
				/>
			))}

			{isActive && (
				<div className="reply">
					{!thread.resolved && (
						<textarea
							className="field"
							style={{ minHeight: 40 }}
							value={reply}
							onChange={(e) => setReply(e.target.value)}
							onKeyDown={(e) => submitOnEnter(e, sendReply)}
						/>
					)}
					<div className="reply-row">
						{!thread.resolved && (
							<button
								type="button"
								className="btn primary small"
								disabled={!reply.trim()}
								onClick={sendReply}
							>
								Reply
							</button>
						)}
					</div>
					{thread.resolvedBy && thread.resolved && (
						<div className="small muted">Resolved by {thread.resolvedBy.name}</div>
					)}
				</div>
			)}
		</article>
	);
}

function CommentView({
	comment,
	mine,
	onEdit,
	onDelete,
}: {
	comment: Thread["comments"][number];
	mine: boolean;
	onEdit(id: string, body: string): void;
	onDelete(id: string): void;
}) {
	const [editing, setEditing] = useState(false);
	const [body, setBody] = useState(comment.body);
	const save = () => {
		if (body.trim() && body !== comment.body) onEdit(comment.id, body.trim());
		setEditing(false);
	};
	return (
		<div className="comment">
			<div className="comment-head">
				<img className="avatar" src={comment.author.avatar} alt="" />
				<span className="name">{comment.author.name}</span>
				{comment.via && <span className="via">via {comment.via}</span>}
				<span className="time" title={new Date(comment.createdAt).toLocaleString()}>
					{ago(comment.createdAt)}
					{comment.editedAt && " · edited"}
				</span>
				{mine && !editing && (
					<span className="comment-actions">
						<button type="button" className="btn ghost small" onClick={() => setEditing(true)}>
							Edit
						</button>
						<button type="button" className="btn ghost small" onClick={() => onDelete(comment.id)}>
							Delete
						</button>
					</span>
				)}
			</div>
			{editing ? (
				<div className="reply" style={{ marginTop: 4 }}>
					<textarea
						className="field"
						value={body}
						onChange={(e) => setBody(e.target.value)}
						onKeyDown={(e) => submitOnEnter(e, save, () => setEditing(false))}
					/>
					<div className="reply-row">
						<button type="button" className="btn ghost small" onClick={() => setEditing(false)}>
							Cancel
						</button>
						<button type="button" className="btn primary small" onClick={save}>
							Save
						</button>
					</div>
				</div>
			) : (
				<div className="comment-body">{comment.body}</div>
			)}
		</div>
	);
}

/** Bring a card into its list's view, centred when it was out of sight. Selecting a card already in view leaves the list still. */
function revealCard(el: HTMLElement | null) {
	// Wait a frame, since the active card grows its reply box.
	requestAnimationFrame(() => {
		const list = el?.closest(".rail-list");
		if (!el || !list) return;
		const box = el.getBoundingClientRect();
		const view = list.getBoundingClientRect();
		if (box.top >= view.top && box.bottom <= view.bottom) return;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		el.scrollIntoView({
			block: box.height > view.height ? "start" : "center",
			behavior: still ? "auto" : "smooth",
		});
	});
}
