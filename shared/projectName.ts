/**
 * Accept owner/name, a GitHub URL or an SSH remote as `git remote get-url` prints it, each
 * optionally followed by @branch. Branch names can hold slashes, so the branch is everything
 * after the first @ that follows the repo.
 */
export function parseProject(input: string): { slug: string; branch?: string } {
	const value = input.trim();
	const remote = value.match(/github\.com[:/]([^/\s@]+\/[^/\s@]+?)(?:\.git)?\/?(?:@(.+))?$/i);
	if (remote) return { slug: remote[1].toLowerCase(), branch: remote[2] };
	const at = value.indexOf("@");
	const repo = at === -1 ? value : value.slice(0, at);
	return {
		slug: repo.replace(/\.git$/, "").toLowerCase(),
		branch: at === -1 ? undefined : value.slice(at + 1) || undefined,
	};
}
