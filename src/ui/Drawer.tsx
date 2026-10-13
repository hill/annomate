import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEscape } from "./escape";

export function Drawer({
	title,
	width,
	onClose,
	children,
	footer,
}: {
	title: ReactNode;
	width?: number;
	onClose(): void;
	children: ReactNode;
	footer?: ReactNode;
}) {
	useEscape(onClose);

	return (
		<>
			<div className="scrim" onPointerDown={onClose} />
			<aside
				className="drawer"
				style={{ "--drawer-w": width ? `${width}px` : undefined } as React.CSSProperties}
			>
				<header className="drawer-head">
					<h2>{title}</h2>
					<button type="button" className="btn ghost icon" aria-label="Close" onClick={onClose}>
						<X size={16} />
					</button>
				</header>
				<div className="drawer-body">{children}</div>
				{footer && <footer className="drawer-foot">{footer}</footer>}
			</aside>
		</>
	);
}
