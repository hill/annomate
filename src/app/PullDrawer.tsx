import { ArrowDownToLine, CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { PullFile, PullPreview } from "../../shared/protocol";
import { ago } from "../api";
import { useDiffMode } from "../history/CommitDiff";
import { Counts, FileDiff } from "../history/FileDiff";
import { type Room, useRoom } from "../room/provider";
import { Drawer } from "../ui/Drawer";

const LOCAL: Record<Exclude<PullFile["local"], "none">, { label: string; tone: string }> = {
	merges: { label: "Merges with edits made here", tone: "ok" },
	overlaps: {
		label: "Overlaps edits made here. Those parts keep this project's version",
		tone: "warn",
	},
	kept: { label: "Deleted on the branch. Kept here because it has edits", tone: "warn" },
};

const EFFECT: Record<PullPreview["comments"][number]["effect"], string> = {
	kept: "Stays put",
	changed: "Text changes",
	lost: "Loses its place",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Shows what pulling the branch would do before anyone does it: the commits, each file's diff
 * and how it meets the edits made here, and which comments move or lose their text.
 */
export function PullDrawer({
	room,
	projectId,
	repo,
	branch,
	onClose,
}: {
	room: Room;
	projectId: string;
	repo: string;
	branch: string;
	onClose(): void;
}) {
	const { pullPreview, git } = useRoom(room);
	const [mode, setMode] = useDiffMode();
	useEffect(() => room.previewPull(), [room]);

	// Look again when the branch moves while the drawer is open.
	const upstream = git?.upstream?.sha;
	const [seen, setSeen] = useState(upstream);
	useEffect(() => {
		if (upstream && upstream !== seen) {
			setSeen(upstream);
			room.previewPull();
		}
	}, [room, upstream, seen]);

	const preview = pullPreview?.preview;
	const behind = preview ? preview.commits.length + preview.more : 0;
	const overlaps = preview?.files.filter((f) => f.local === "overlaps").length ?? 0;

	return (
		<Drawer
			title="Pull changes"
			width={980}
			onClose={onClose}
			footer={
				<>
					<span className="small muted" style={{ marginRight: "auto" }}>
						{overlaps > 0 &&
							`${plural(overlaps, "file")} overlap edits made here. Those parts of the incoming changes will not apply.`}
					</span>
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="btn primary"
						disabled={!preview || !behind || !!git?.busy}
						onClick={() => {
							if (!preview) return;
							room.send({ t: "git.pull", head: preview.head });
							onClose();
						}}
					>
						<ArrowDownToLine size={14} />
						{behind ? `Pull ${plural(behind, "commit")}` : "Pull"}
					</button>
				</>
			}
		>
			{pullPreview === undefined ? (
				<div className="empty" style={{ height: 200 }}>
					<div className="loader" />
				</div>
			) : !preview ? (
				<div className="empty" style={{ height: 200 }}>
					{pullPreview?.error ?? "Could not check the branch"}
				</div>
			) : !behind ? (
				<div className="empty" style={{ height: 200 }}>
					<div>
						<div className="icon-tile">
							<CircleCheck size={18} />
						</div>
						<h3>Up to date with {branch}</h3>
					</div>
				</div>
			) : (
				<div className="pull">
					{preview.diverged && (
						<p className="pull-note warn">
							{branch}'s history was rewritten since this project last synced. Pulling takes its
							current files and merges them with the edits made here.
						</p>
					)}

					<section>
						<h3>{plural(behind, "new commit")}</h3>
						<ul className="pull-commits">
							{preview.commits.map((c) => (
								<li key={c.sha}>
									{c.author.avatar && <img className="avatar" src={c.author.avatar} alt="" />}
									<span className="subject">{c.message.split("\n")[0]}</span>
									<span className="meta">
										{c.author.login ?? c.author.name} · {ago(Date.parse(c.date))}
									</span>
									<a
										className="sha mono"
										href={`https://github.com/${repo}/commit/${c.sha}`}
										target="_blank"
										rel="noreferrer"
									>
										{c.sha.slice(0, 7)}
									</a>
								</li>
							))}
							{preview.more > 0 && <li className="more">{plural(preview.more, "older commit")}</li>}
						</ul>
					</section>

					{preview.comments.length > 0 && <Comments comments={preview.comments} />}

					<section>
						<div className="commit-summary">
							<h3>{plural(preview.files.length, "file")}</h3>
							<Counts
								additions={preview.files.reduce((n, f) => n + f.additions, 0)}
								deletions={preview.files.reduce((n, f) => n + f.deletions, 0)}
							/>
							<span className="spacer" />
							<div className="seg" role="tablist" aria-label="Layout">
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
							{preview.files.map((f) => (
								<div key={f.path}>
									{f.local !== "none" && (
										<div className={`pull-local ${LOCAL[f.local].tone}`}>
											{LOCAL[f.local].label}
										</div>
									)}
									<FileDiff
										file={f}
										mode={mode}
										projectId={projectId}
										githubUrl={`https://github.com/${repo}/blob/${preview.head}/${f.path}`}
									/>
								</div>
							))}
						</div>
					</section>
				</div>
			)}
		</Drawer>
	);
}

function Comments({ comments }: { comments: PullPreview["comments"] }) {
	const moved = comments.filter((c) => c.effect !== "kept");
	const kept = comments.length - moved.length;
	return (
		<section>
			<h3>{plural(comments.length, "open comment")} on changed files</h3>
			<ul className="pull-comments">
				{moved.map((c) => (
					<li key={c.id}>
						<span className={`effect ${c.effect}`}>{EFFECT[c.effect]}</span>
						<span className="excerpt">{c.quote || "A point in the text"}</span>
						<span className="file mono">{c.file}</span>
					</li>
				))}
				{kept > 0 && (
					<li className="more">
						{moved.length
							? `${kept} other${kept === 1 ? " stays" : "s stay"} put`
							: kept === 1
								? "It stays put"
								: "All stay put"}
					</li>
				)}
			</ul>
		</section>
	);
}
