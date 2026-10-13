import { useEffect, useState } from "react";

/** State kept in localStorage, so it survives a reload. */
export function useStored<T>(key: string, initial: T) {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			return raw === null ? initial : (JSON.parse(raw) as T);
		} catch {
			return initial;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
	}, [key, value]);
	return [value, setValue] as const;
}
