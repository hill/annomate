import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxTree } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
	EditorState,
	type Extension,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	drawSelection,
	dropCursor,
	EditorView,
	GutterMarker,
	gutter,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	showTooltip,
	type Tooltip,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { typst_lezer } from "codemirror-lang-typst/lezer";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { isPoint, resolveAnchor } from "../../shared/anchor";
import type { Thread, User } from "../../shared/protocol";
import type { Room } from "../room/provider";
import { DRAG_TYPE, references } from "./references";
import { highlighting } from "./theme";
import { typstHover } from "./typstDocs";

export interface EditorHandle {
	reveal(pos: number): void;
	gotoLine(line: number): void;
	/** Comment on the selection, or at the cursor when nothing is selected. */
	comment(): void;
}

interface Props {
	room: Room;
	path: string;
	threads: Thread[];
	activeThread: string | null;
	/** Where a comment on a point is being written, shown as a pin with your avatar. */
	draftPoint?: number | null;
	me?: User | null;
	onSelectThread(id: string): void;
	onComment(from: number, to: number): void;
	/** A plain click that placed the cursor, for syncing the preview. */
	onCursor?(offset: number): void;
	/** Upload images dropped or pasted at `at`, then insert them. Resolves to the inserted range. */
	onImages?(files: File[], at: number, code: boolean): Promise<{ from: number; to: number } | null>;
}

// The raster and vector formats Typst's image function reads.
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;

const imagesIn = (dt: DataTransfer | null) =>
	[...(dt?.files ?? [])].filter((f) => IMAGE_TYPE.test(f.type));

/** Whether `pos` sits in code, where a call takes no leading `#`, rather than in markup. */
function inCode(state: EditorState, pos: number) {
	for (let n = syntaxTree(state).resolveInner(pos, -1); n.parent; n = n.parent) {
		if (n.name === "Markup" || n.name === "ContentBlock") return false;
		if (n.name === "Args" || n.name === "CodeBlock" || n.name === "Code") return true;
	}
	return false;
}

interface CommentState {
	threads: Thread[];
	active: string | null;
}

const setComments = StateEffect.define<CommentState>();

const commentState = StateField.define<CommentState>({
	create: () => ({ threads: [], active: null }),
	update: (value, tr) => tr.effects.find((e) => e.is(setComments))?.value ?? value,
});

interface DraftPin {
	at: number;
	user: User;
}

const setDraftPin = StateEffect.define<DraftPin | null>();

/** Follows edits so the pin stays put while the comment is written. */
const draftPin = StateField.define<DraftPin | null>({
	create: () => null,
	update(pin, tr) {
		for (const e of tr.effects) if (e.is(setDraftPin)) return e.value;
		return pin && { ...pin, at: tr.changes.mapPos(pin.at) };
	},
});

/** An inline chip with the author's avatar and the reply count, which opens the thread. */
class PointPin extends WidgetType {
	constructor(
		readonly id: string | null,
		readonly user: User,
		readonly count: number,
		readonly active: boolean,
	) {
		super();
	}
	eq(other: PointPin) {
		return (
			other.id === this.id &&
			other.user.id === this.user.id &&
			other.count === this.count &&
			other.active === this.active
		);
	}
	toDOM() {
		const pin = document.createElement("span");
		pin.className = `cm-point-pin${this.active ? " active" : ""}${this.id ? "" : " draft"}`;
		if (this.id) pin.dataset.thread = this.id;
		pin.title = this.user.name || this.user.login;
		const img = document.createElement("img");
		img.src = this.user.avatar;
		img.alt = "";
		img.draggable = false;
		pin.append(img);
		if (this.count) {
			const n = document.createElement("span");
			n.textContent = String(this.count);
			pin.append(n);
		}
		return pin;
	}
	// Clicks reach the editor so the mousedown handler can open the thread.
	ignoreEvent() {
		return false;
	}
}

const setFlash = StateEffect.define<number | null>();

/** Briefly tints the line the preview just jumped to. */
const flashField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		for (const e of tr.effects) {
			if (!e.is(setFlash)) continue;
			return e.value === null
				? Decoration.none
				: Decoration.set([Decoration.line({ class: "cm-flash" }).range(e.value)]);
		}
		return deco.map(tr.changes);
	},
	provide: (f) => EditorView.decorations.from(f),
});

class PinMarker extends GutterMarker {
	constructor(readonly id: string) {
		super();
	}
	eq(other: PinMarker) {
		return other.id === this.id;
	}
	toDOM() {
		const el = document.createElement("span");
		el.className = "cm-comment-pin";
		el.dataset.thread = this.id;
		return el;
	}
}

interface Ranges {
	marks: DecorationSet;
	pins: { from: number; id: string }[];
}

/** Resolve every thread's anchor against the live document on each change. */
function commentDecorations(doc: Y.Doc, text: Y.Text, path: string) {
	const compute = (state: EditorState): Ranges => {
		const { threads, active } = state.field(commentState);
		const decos = [];
		const pins: Ranges["pins"] = [];
		for (const t of threads) {
			if (t.resolved || t.anchor.file !== path) continue;
			const r = resolveAnchor(doc, text, t.anchor);
			if (r.status === "detached" || r.to > state.doc.length) continue;
			if (isPoint(t.anchor)) {
				const pin = new PointPin(t.id, t.author, t.comments.length, t.id === active);
				decos.push(Decoration.widget({ widget: pin, side: 1 }).range(r.from));
			} else if (r.to > r.from) {
				const mark = Decoration.mark({
					class: t.id === active ? "cm-comment-mark active" : "cm-comment-mark",
					attributes: { "data-thread": t.id },
				});
				decos.push(mark.range(r.from, r.to));
			} else continue;
			pins.push({ from: r.from, id: t.id });
		}
		const draft = state.field(draftPin);
		if (draft && draft.at <= state.doc.length) {
			const pin = new PointPin(null, draft.user, 0, true);
			decos.push(Decoration.widget({ widget: pin, side: 1 }).range(draft.at));
		}
		pins.sort((a, b) => a.from - b.from);
		return { marks: Decoration.set(decos, true), pins };
	};

	const plugin = ViewPlugin.fromClass(
		class {
			ranges: Ranges;
			constructor(view: EditorView) {
				this.ranges = compute(view.state);
			}
			update(u: ViewUpdate) {
				const changedComments =
					u.startState.field(commentState) !== u.state.field(commentState) ||
					u.startState.field(draftPin) !== u.state.field(draftPin);
				if (u.docChanged || changedComments) this.ranges = compute(u.state);
			}
		},
		{ decorations: (v) => v.ranges.marks },
	);

	const pins = gutter({
		class: "cm-comment-gutter",
		lineMarkerChange: (u) =>
			u.docChanged || u.startState.field(commentState) !== u.state.field(commentState),
		markers: (view) => {
			const builder = new RangeSetBuilder<GutterMarker>();
			const seen = new Set<number>();
			for (const p of view.plugin(plugin)?.ranges.pins ?? []) {
				const line = view.state.doc.lineAt(p.from).from;
				if (seen.has(line)) continue;
				seen.add(line);
				builder.add(line, line, new PinMarker(p.id));
			}
			return builder.finish();
		},
	});

	return [plugin, pins];
}

function commentTooltip(onComment: (from: number, to: number) => void): Extension {
	const field = StateField.define<readonly Tooltip[]>({
		create: () => [],
		update(tips, tr) {
			if (!tr.docChanged && !tr.selection) return tips;
			const sel = tr.state.selection.main;
			if (sel.empty) return [];
			return [
				{
					pos: sel.head,
					above: sel.head < sel.anchor,
					strictSide: false,
					arrow: false,
					create: () => {
						const dom = document.createElement("div");
						dom.className = "comment-tip";
						const button = document.createElement("button");
						button.type = "button";
						button.innerHTML = `Comment <kbd>${navigator.platform.includes("Mac") ? "⌘⌥M" : "Ctrl+Alt+M"}</kbd>`;
						button.onmousedown = (e) => e.preventDefault();
						button.onclick = () => onComment(sel.from, sel.to);
						dom.append(button);
						return { dom, offset: { x: 0, y: 6 } };
					},
				},
			];
		},
		provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
	});
	return field;
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(
	{
		room,
		path,
		threads,
		activeThread,
		draftPoint,
		me,
		onSelectThread,
		onComment,
		onCursor,
		onImages,
	},
	ref,
) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const callbacks = useRef({ onSelectThread, onComment, onCursor, onImages });
	callbacks.current = { onSelectThread, onComment, onCursor, onImages };
	const comments = useRef<CommentState>({ threads, active: activeThread });
	comments.current = { threads, active: activeThread };

	useEffect(() => {
		const text = room.files.get(path);
		if (!host.current || !text) return;
		const undoManager = new Y.UndoManager(text);
		const comment = (from: number, to: number) => callbacks.current.onComment(from, to);
		const insertImages = (v: EditorView, files: File[], at: number) => {
			const done = callbacks.current.onImages?.(files, at, inCode(v.state, at));
			void done?.then((r) => {
				if (r && view.current === v) v.dispatch({ selection: { anchor: r.to } });
			});
		};
		const images = path.endsWith(".typ")
			? [
					dropCursor(),
					EditorView.domEventHandlers({
						dragover: (e) => {
							if (e.dataTransfer?.types.includes(DRAG_TYPE)) {
								e.preventDefault();
								e.dataTransfer.dropEffect = "copy";
							}
							return false;
						},
						drop: (e, v) => {
							const dragged = e.dataTransfer?.getData(DRAG_TYPE);
							if (dragged) {
								e.preventDefault();
								// Folders have no reference to insert.
								if (!room.files.has(dragged) && !room.assets.has(dragged)) return true;
								const at =
									v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
								const insert = references(path, [dragged], inCode(v.state, at));
								v.dispatch({
									changes: { from: at, insert },
									selection: { anchor: at + insert.length },
								});
								v.focus();
								return true;
							}
							const files = imagesIn(e.dataTransfer);
							if (!files.length) return false;
							e.preventDefault();
							const at =
								v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
							insertImages(v, files, at);
							return true;
						},
						paste: (e, v) => {
							const files = imagesIn(e.clipboardData);
							if (!files.length) return false;
							e.preventDefault();
							const { from, to } = v.state.selection.main;
							if (to > from) v.dispatch({ changes: { from, to } });
							insertImages(v, files, from);
							return true;
						},
					}),
				]
			: [];

		const state = EditorState.create({
			doc: text.toString(),
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				drawSelection(),
				indentOnInput(),
				bracketMatching(),
				closeBrackets(),
				autocompletion(),
				highlightActiveLine(),
				highlightSelectionMatches(),
				EditorView.lineWrapping,
				path.endsWith(".typ") ? [typst_lezer(), typstHover] : [],
				highlighting,
				commentState,
				draftPin,
				commentDecorations(room.doc, text, path),
				commentTooltip(comment),
				images,
				keymap.of([
					{
						key: "Mod-Alt-m",
						run: (v) => {
							const sel = v.state.selection.main;
							comment(sel.from, sel.to);
							return true;
						},
					},
					...closeBracketsKeymap,
					...defaultKeymap,
					...searchKeymap,
					...completionKeymap,
					indentWithTab,
				]),
				yCollab(text, room.awareness, { undoManager }),
				EditorView.domEventHandlers({
					mousedown: (e) => {
						const el = (e.target as HTMLElement).closest<HTMLElement>("[data-thread]");
						if (el?.dataset.thread) callbacks.current.onSelectThread(el.dataset.thread);
						return false;
					},
					mouseup: (_e, v) => {
						// Wait for CodeMirror to place the selection from this click.
						requestAnimationFrame(() => {
							const sel = v.state.selection.main;
							if (sel.empty) callbacks.current.onCursor?.(sel.head);
						});
						return false;
					},
				}),
				flashField,
			],
		});
		const v = new EditorView({ state, parent: host.current });
		v.dispatch({ effects: setComments.of(comments.current) });
		view.current = v;
		return () => {
			v.destroy();
			undoManager.destroy();
			view.current = null;
		};
	}, [room, path]);

	useEffect(() => {
		view.current?.dispatch({ effects: setComments.of({ threads, active: activeThread }) });
	}, [threads, activeThread]);

	useEffect(() => {
		const pin = draftPoint != null && me ? { at: draftPoint, user: me } : null;
		view.current?.dispatch({ effects: setDraftPin.of(pin) });
	}, [draftPoint, me]);

	useImperativeHandle(ref, () => ({
		reveal(pos) {
			const v = view.current;
			if (!v) return;
			const at = Math.min(pos, v.state.doc.length);
			const line = v.state.doc.lineAt(at).from;
			v.dispatch({
				selection: { anchor: at },
				effects: [EditorView.scrollIntoView(at, { y: "center" }), setFlash.of(line)],
			});
			setTimeout(() => view.current === v && v.dispatch({ effects: setFlash.of(null) }), 1200);
		},
		comment() {
			const v = view.current;
			if (!v) return;
			const sel = v.state.selection.main;
			callbacks.current.onComment(sel.from, sel.to);
		},
		gotoLine(line) {
			const v = view.current;
			if (!v) return;
			const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
			v.dispatch({
				selection: { anchor: l.from },
				effects: EditorView.scrollIntoView(l.from, { y: "center" }),
			});
			v.focus();
		},
	}));

	return <div className="editor" ref={host} />;
});

// An open view keeps the state fields it was built with, and a hot-swapped copy of this module
// dispatches effects those fields do not recognise, so reload rather than patch in place.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
