export function navigate(to: string) {
	history.pushState(null, "", to);
	dispatchEvent(new PopStateEvent("popstate"));
}
