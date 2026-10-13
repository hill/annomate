import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { useRef, useSyncExternalStore } from "react";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
	type ClientMessage,
	type GitState,
	MSG_AWARENESS,
	MSG_SYNC,
	type Presence,
	type ServerMessage,
	type TexResult,
	type Thread,
	type User,
} from "../../shared/protocol";

export type Status = "connecting" | "syncing" | "live" | "offline";

export interface Toast {
	id: number;
	text: string;
	tone: "ok" | "error";
}

interface Snapshot {
	status: Status;
	me: User | null;
	threads: Thread[];
	git: GitState | null;
	/** The latest server-side compile of a LaTeX project. */
	tex: TexResult | null;
	texBusy: boolean;
	toasts: Toast[];
}

/**
 * One connection to a project room. Speaks the y-websocket binary protocol for
 * the document and presence, and JSON for comments and git.
 */
export class Room {
	readonly doc = new Y.Doc();
	readonly awareness = new awarenessProtocol.Awareness(this.doc);
	readonly files = this.doc.getMap<Y.Text>("files");
	readonly base = this.doc.getMap<string>("base");
	readonly assets = this.doc.getMap<{ sha: string; size: number }>("assets");
	readonly baseAssets = this.doc.getMap<{ sha: string; size: number }>("baseAssets");

	private ws: WebSocket | null = null;
	private retry = 0;
	private closed = false;
	private listeners = new Set<() => void>();
	private toastId = 0;
	private state: Snapshot = {
		status: "connecting",
		me: null,
		threads: [],
		git: null,
		tex: null,
		texBusy: false,
		toasts: [],
	};
	/** Copied on every change, because awareness mutates one Map in place. */
	private presence = new Map<number, Presence>();

	constructor(readonly projectId: string) {
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === this) return;
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, MSG_SYNC);
			syncProtocol.writeUpdate(encoder, update);
			this.sendBinary(encoding.toUint8Array(encoder));
		});
		this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
			if (origin === "remote") return;
			const changed = [...added, ...updated, ...removed];
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, MSG_AWARENESS);
			encoding.writeVarUint8Array(
				encoder,
				awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
			);
			this.sendBinary(encoding.toUint8Array(encoder));
		});
		this.awareness.on("change", () => {
			this.presence = new Map(this.awareness.getStates() as Map<number, Presence>);
		});
		window.addEventListener("beforeunload", this.leave);
		this.connect();
	}

	private connect() {
		const url = new URL(`/ws/${this.projectId}`, location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		this.set({ status: this.retry ? "connecting" : this.state.status });

		ws.onopen = () => {
			this.retry = 0;
			this.set({ status: "syncing" });
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, MSG_SYNC);
			syncProtocol.writeSyncStep1(encoder, this.doc);
			ws.send(encoding.toUint8Array(encoder));
			if (this.awareness.getLocalState()) {
				const aw = encoding.createEncoder();
				encoding.writeVarUint(aw, MSG_AWARENESS);
				encoding.writeVarUint8Array(
					aw,
					awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
				);
				ws.send(encoding.toUint8Array(aw));
			}
		};

		ws.onmessage = (event) => {
			if (typeof event.data === "string") this.onJson(JSON.parse(event.data));
			else this.onBinary(new Uint8Array(event.data));
		};

		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			// Others vanish from view while we are away, so their stale cursors do not linger.
			const others = [...this.awareness.getStates().keys()].filter(
				(id) => id !== this.doc.clientID,
			);
			awarenessProtocol.removeAwarenessStates(this.awareness, others, "remote");
			if (this.closed) return;
			this.set({ status: "offline" });
			const delay = Math.min(10_000, 400 * 2 ** this.retry++);
			setTimeout(() => !this.closed && this.connect(), delay);
		};
	}

	private onBinary(bytes: Uint8Array) {
		const decoder = decoding.createDecoder(bytes);
		const type = decoding.readVarUint(decoder);
		if (type === MSG_SYNC) {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, MSG_SYNC);
			const kind = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
			if (encoding.length(encoder) > 1) this.sendBinary(encoding.toUint8Array(encoder));
			if (kind === syncProtocol.messageYjsSyncStep2 && this.state.status === "syncing") {
				this.set({ status: "live" });
			}
		} else if (type === MSG_AWARENESS) {
			awarenessProtocol.applyAwarenessUpdate(
				this.awareness,
				decoding.readVarUint8Array(decoder),
				"remote",
			);
		}
	}

	private onJson(msg: ServerMessage) {
		switch (msg.t) {
			case "hello":
				return this.set({ me: msg.me, threads: msg.threads, git: msg.git });
			case "thread.upsert": {
				const rest = this.state.threads.filter((t) => t.id !== msg.thread.id);
				return this.set({
					threads: [...rest, msg.thread].sort((a, b) => a.createdAt - b.createdAt),
				});
			}
			case "thread.remove":
				return this.set({ threads: this.state.threads.filter((t) => t.id !== msg.id) });
			case "git.state":
				return this.set({ git: msg.git });
			case "tex.result":
				return this.set({ tex: msg.result });
			case "tex.state":
				return this.set({ texBusy: msg.busy });
			case "git.result": {
				const who = msg.by.id === this.state.me?.id ? "" : `${msg.by.name}: `;
				return this.toast(`${who}${msg.message}`, msg.ok ? "ok" : "error");
			}
			case "error":
				return this.toast(msg.message, "error");
		}
	}

	toast(text: string, tone: Toast["tone"] = "ok") {
		const toast = { id: ++this.toastId, text, tone };
		this.set({ toasts: [...this.state.toasts, toast] });
		setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t !== toast) }), 5000);
	}

	private sendBinary(data: Uint8Array) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data as Uint8Array<ArrayBuffer>);
	}

	send(msg: ClientMessage) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
		else this.toast("Offline. Reconnecting first", "error");
	}

	setPresence(patch: Partial<Presence>) {
		const current = (this.awareness.getLocalState() ?? {}) as Partial<Presence>;
		this.awareness.setLocalState({ ...current, ...patch });
	}

	private leave = () => {
		awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "leave");
	};

	destroy() {
		this.closed = true;
		this.leave();
		window.removeEventListener("beforeunload", this.leave);
		this.ws?.close();
		this.awareness.destroy();
		this.doc.destroy();
	}

	// React glue

	private set(patch: Partial<Snapshot>) {
		this.state = { ...this.state, ...patch };
		for (const l of this.listeners) l();
	}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = () => this.state;

	subscribePresence = (listener: () => void) => {
		this.awareness.on("change", listener);
		return () => this.awareness.off("change", listener);
	};

	getPresence = () => this.presence;
}

interface AwarenessChange {
	added: number[];
	updated: number[];
	removed: number[];
}

export function useRoom(room: Room) {
	return useSyncExternalStore(room.subscribe, room.getSnapshot);
}

/** Re-render whenever a Yjs type changes, deeply. */
export function useY<T>(type: Y.AbstractType<unknown>, read: () => T): T {
	const cache = useRef<{ value: T } | null>(null);
	return useSyncExternalStore(
		(cb) => {
			const handler = () => cb();
			type.observeDeep(handler);
			return () => type.unobserveDeep(handler);
		},
		() => {
			const next = read();
			if (!cache.current || !shallowEqual(next, cache.current.value))
				cache.current = { value: next };
			return cache.current.value;
		},
	);
}

export function usePresence(room: Room): Map<number, Presence> {
	return useSyncExternalStore(room.subscribePresence, room.getPresence);
}

function shallowEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
	return false;
}
