import { GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ago, api, type History } from "../api";
import { Drawer } from "../ui/Drawer";
import { CommitDiff } from "./CommitDiff";
import { CommitPeek, usePeek } from "./CommitPeek";
import { loadCommit } from "./commits";
import { type GraphRow, layout } from "./graph";

const LANE = 14;
const ROW = 40;
const PALETTE = [
	"#3a6cf4",
	"#e5484d",
	"#12a594",
	"#8e4ec6",
	"#f76b15",
	"#d6409f",
	"#46a758",
	"#0090ff",
];
const WIDTH = 620;
// Narrower while a commit's diff is open beside it, so the diff gets the room.
const WIDTH_BESIDE_DIFF = 460;
const laneX = (lane: number) => 14 + lane * LANE;
const colorOf = (c: number) => PALETTE[c % PALETTE.length];

interface Props {
	projectId: string;
	repo: string;
	branch: string;
	baseSha: string;
	uncommitted: number;
	onClose(): void;
}

export function HistoryDrawer({ projectId, repo, branch, baseSha, uncommitted, onClose }: Props) {
	const [history, setHistory] = useState<History | null>(null);
	const [error, setError] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const list = useRef<HTMLDivElement>(null);

	useEffect(() => {
		api
			.history(projectId)
			.then(setHistory, (e) => setError(e instanceof Error ? e.message : String(e)));
	}, [projectId]);

	const graph = useMemo(() => (history ? layout(history.commits) : null), [history]);
	const refs = useMemo(() => {
		const out = new Map<string, string[]>();
		for (const b of history?.branches ?? []) out.set(b.sha, [...(out.get(b.sha) ?? []), b.name]);
		return out;
	}, [history]);

	const commits = history?.commits;
	const index = commits?.findIndex((c) => c.sha === selected) ?? -1;
	const current = index >= 0 ? commits?.[index] : undefined;

	useEffect(() => {
		if (!commits || index < 0) return;
		for (const near of [commits[index + 1], commits[index - 1]]) {
			if (near) loadCommit(projectId, near.sha).catch(() => {});
		}
		list.current
			?.querySelector(`[data-sha="${commits[index].sha}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [commits, index, projectId]);

	useEffect(() => {
		if (!commits || index < 0) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
			const next = step && commits[index + step];
			if (!next) return;
			e.preventDefault();
			setSelected(next.sha);
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [commits, index]);

	const { peek, rowProps, dismiss } = usePeek(selected);
	const closeDiff = useCallback(() => setSelected(null), []);
	const width = current ? WIDTH_BESIDE_DIFF : WIDTH;
	const graphWidth = graph ? laneX(graph.width - 1) + 14 : 28;

	return (
		<Drawer title="History" width={width} onClose={onClose}>
			{peek && <CommitPeek projectId={projectId} peek={peek} />}
			{current && (
				<CommitDiff
					projectId={projectId}
					repo={repo}
					commit={current}
					besideWidth={width}
					onClose={closeDiff}
				/>
			)}
			{!history ? (
				<div className="empty" style={{ height: 200 }}>
					{error || <div className="loader" />}
				</div>
			) : (
				<div
					ref={list}
					className="history"
					style={{ "--graph-w": `${graphWidth}px` } as React.CSSProperties}
				>
					{uncommitted > 0 && (
						<div className="commit">
							<svg className="graph" width={graphWidth} height={ROW} aria-hidden="true">
								<line
									x1={laneX(0)}
									y1={ROW / 2}
									x2={laneX(0)}
									y2={ROW}
									stroke="var(--line-strong)"
									strokeDasharray="3 3"
									strokeWidth="1.5"
								/>
								<circle
									cx={laneX(0)}
									cy={ROW / 2}
									r={4}
									fill="var(--bg)"
									stroke="var(--faint)"
									strokeWidth="1.5"
									strokeDasharray="2 2"
								/>
							</svg>
							<div className="msg muted">
								<span className="text">
									Uncommitted changes in {uncommitted} file{uncommitted === 1 ? "" : "s"}
								</span>
							</div>
							<div />
						</div>
					)}
					{history.commits.map((c, i) => {
						const row = graph?.rows[i] as GraphRow;
						const names = refs.get(c.sha) ?? [];
						const [subject] = c.message.split("\n");
						const isOpen = selected === c.sha;
						return (
							<button
								key={c.sha}
								type="button"
								data-sha={c.sha}
								className={`commit${isOpen ? " open" : ""}`}
								aria-pressed={isOpen}
								{...rowProps(c.sha)}
								onClick={() => {
									dismiss();
									setSelected(isOpen ? null : c.sha);
								}}
							>
								<Lanes row={row} width={graphWidth} />
								<span className="msg">
									{names.map((n) => (
										<span key={n} className={`ref${n === branch ? " current" : ""}`}>
											<GitBranch size={10} />
											{n}
										</span>
									))}
									{c.sha === baseSha && <span className="ref base">annomate</span>}
									<span className="text">{subject}</span>
								</span>
								<span className="meta">
									{c.author.avatar && <img className="avatar" src={c.author.avatar} alt="" />}
									<span>{c.author.login ?? c.author.name}</span>
									<span>{ago(Date.parse(c.date))}</span>
									<span className="mono">{c.sha.slice(0, 7)}</span>
								</span>
							</button>
						);
					})}
				</div>
			)}
		</Drawer>
	);
}

function Lanes({ row, width }: { row: GraphRow; width: number }) {
	const mid = ROW / 2;
	const node = laneX(row.lane);
	const curve = (x1: number, y1: number, x2: number, y2: number) =>
		x1 === x2
			? `M${x1} ${y1}V${y2}`
			: `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
	return (
		<svg className="graph" width={width} height={ROW} aria-hidden="true">
			{row.segments.map((s, i) => {
				const d =
					s.kind === "in"
						? curve(laneX(s.from), 0, node, mid)
						: s.kind === "out"
							? curve(node, mid, laneX(s.to), ROW)
							: curve(laneX(s.from), 0, laneX(s.to), ROW);
				// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional within a row
				return <path key={i} d={d} fill="none" stroke={colorOf(s.color)} strokeWidth="1.5" />;
			})}
			<circle
				cx={node}
				cy={mid}
				r={row.merge ? 3.5 : 4}
				fill={row.merge ? "var(--bg)" : colorOf(row.color)}
				stroke={colorOf(row.color)}
				strokeWidth="1.5"
			/>
		</svg>
	);
}
