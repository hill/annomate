import { BookMarked, ChevronsUpDown, Lock } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ago, type Repo } from "../api";

/** A repository field that suggests the user's repos as they type, in the app's own menu. */
export function RepoPicker({
	id,
	repos,
	value,
	onChange,
	onPick,
}: {
	id: string;
	/** Null while loading. */
	repos: Repo[] | null;
	value: string;
	onChange(value: string): void;
	onPick(repo: Repo): void;
}) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const list = useRef<HTMLDivElement>(null);
	const listId = useId();

	const query = value.trim().toLowerCase();
	const matches = (repos ?? []).filter((r) => r.repo.toLowerCase().includes(query));
	// An exact pick needs no menu, until the user types again.
	const exact = matches.length === 1 && matches[0].repo.toLowerCase() === query;
	const shown = open && !exact && (repos === null || matches.length > 0);

	useEffect(() => {
		list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	function pick(repo: Repo) {
		onPick(repo);
		setOpen(false);
	}

	function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (!shown) return setOpen(true);
			const step = e.key === "ArrowDown" ? 1 : -1;
			setActive((i) => (i + step + matches.length) % Math.max(1, matches.length));
		} else if (e.key === "Enter" && shown && matches[active]) {
			e.preventDefault();
			pick(matches[active]);
		} else if (e.key === "Escape" && shown) {
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		}
	}

	return (
		<div className="combo">
			<input
				id={id}
				className="field"
				role="combobox"
				aria-expanded={shown}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={shown && matches[active] ? `${listId}-${active}` : undefined}
				autoComplete="off"
				value={value}
				onChange={(e) => {
					onChange(e.target.value);
					setActive(0);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onClick={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				onKeyDown={onKeyDown}
				required
				spellCheck={false}
			/>
			<ChevronsUpDown size={14} className="combo-icon" />
			{shown && (
				<div className="menu combo-menu" role="listbox" id={listId} ref={list}>
					{repos === null && <div className="nav dim">Loading…</div>}
					{matches.map((r, i) => {
						const [owner, name] = r.repo.split("/");
						return (
							// biome-ignore lint/a11y/useKeyWithClickEvents: the field owns the keyboard, as a combobox does, and options are never focused
							<div
								key={r.repo}
								id={`${listId}-${i}`}
								data-index={i}
								role="option"
								tabIndex={-1}
								aria-selected={i === active}
								className="nav"
								// Keeps focus in the field, so picking does not blur it first.
								onMouseDown={(e) => e.preventDefault()}
								onMouseMove={() => setActive(i)}
								onClick={() => pick(r)}
							>
								{r.private ? <Lock size={14} /> : <BookMarked size={14} />}
								<span className="grow">
									<span className="dim">{owner}/</span>
									{name}
								</span>
								<span className="trail">{ago(Date.parse(r.pushedAt))}</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
