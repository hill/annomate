import { Download, File as FileIcon } from "lucide-react";
import { useEffect, useState } from "react";

const TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
	pdf: "application/pdf",
};

const typeOf = (path: string) => TYPES[path.split(".").pop()?.toLowerCase() ?? ""];

function bytes(n: number) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * A binary file in the project. Images and PDFs show in place, anything else offers a download.
 * The blob route serves every file as plain bytes, so the type comes from the extension here:
 * an SVG or a PDF only renders with its real type.
 */
export function AssetView({
	projectId,
	path,
	asset,
}: {
	projectId: string;
	path: string;
	asset: { sha: string; size: number };
}) {
	const type = typeOf(path);
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
	const [actual, setActual] = useState(false);

	useEffect(() => {
		let live = true;
		let made: string | null = null;
		setUrl(null);
		setError(false);
		setNatural(null);
		setActual(false);
		fetch(`/api/projects/${projectId}/blob/${asset.sha}`)
			.then((res) => {
				if (!res.ok) throw new Error(String(res.status));
				return res.blob();
			})
			.then((blob) => {
				made = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
				if (live) setUrl(made);
				else URL.revokeObjectURL(made);
			})
			.catch(() => live && setError(true));
		return () => {
			live = false;
			if (made) URL.revokeObjectURL(made);
		};
	}, [projectId, asset.sha, type]);

	const name = path.split("/").pop() ?? path;
	const download = url && (
		<a className="btn ghost small" href={url} download={name}>
			<Download size={13} />
			Download
		</a>
	);
	const meta = [natural && `${natural.w} × ${natural.h}`, bytes(asset.size)].filter(Boolean);

	if (error) {
		return <div className="empty">This file could not be loaded</div>;
	}
	if (!url) {
		return (
			<div className="empty">
				<div className="loader" />
			</div>
		);
	}
	if (type === "application/pdf") {
		return (
			<div className="asset-view pdf">
				<iframe src={url} title={path} />
			</div>
		);
	}
	if (type) {
		return (
			<div className="asset-view">
				<div className={`asset-stage${actual ? " actual" : ""}`}>
					<button
						type="button"
						className="asset-image"
						aria-label={actual ? "Fit to pane" : "Show at full size"}
						onClick={() => setActual((a) => !a)}
					>
						<img
							src={url}
							alt={path}
							onLoad={(e) =>
								setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
							}
						/>
					</button>
				</div>
				<div className="asset-meta">
					<span>{meta.join(" · ")}</span>
					{download}
				</div>
			</div>
		);
	}
	return (
		<div className="empty">
			<div>
				<div className="icon-tile">
					<FileIcon size={18} />
				</div>
				<h3>{name}</h3>
				<p className="muted small" style={{ margin: "4px 0 12px" }}>
					{bytes(asset.size)}
				</p>
				{download}
			</div>
		</div>
	);
}
