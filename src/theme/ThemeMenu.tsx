import { Check, Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEscape } from "../ui/escape";
import { setThemePreference, useTheme } from "./store";
import { THEMES, type ThemePreference } from "./themes";

const OPTIONS: { id: ThemePreference; label: string; icon: typeof Monitor }[] = [
	{ id: "system", label: "System", icon: Monitor },
	...THEMES,
];

export function ThemeMenu() {
	const { preference } = useTheme();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const Current = OPTIONS.find((o) => o.id === preference)?.icon ?? Monitor;

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
		addEventListener("pointerdown", onDown);
		return () => removeEventListener("pointerdown", onDown);
	}, [open]);
	useEscape(() => setOpen(false), open);

	return (
		<div ref={ref} className="theme-menu">
			<button
				type="button"
				className="btn ghost icon small"
				aria-label="Theme"
				title="Theme"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<Current size={14} />
			</button>
			{open && (
				<div className="menu" role="menu">
					{OPTIONS.map(({ id, label, icon: Icon }) => (
						<button
							key={id}
							type="button"
							role="menuitemradio"
							aria-checked={id === preference}
							className="nav"
							onClick={() => {
								setOpen(false);
								setThemePreference(id);
							}}
						>
							<Icon size={14} />
							<span className="grow">{label}</span>
							{id === preference && <Check size={14} />}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
