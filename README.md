# annomate

A free Typst editor where comments stay put.

Open a Typst project from GitHub, edit it with your co-authors in real time, and comment on any passage. Each comment stays with its words through rewrites, moves and pushes from someone's laptop. Commit back to the repo when you are done.

**[Use it free at annomate.hill.xyz](https://annomate.hill.xyz)**, or run your own copy on Cloudflare's free tier.

![annomate with a Typst paper open, showing the source, the rendered page and comment threads](public/marketing/workspace.webp#gh-light-mode-only)
![annomate with a Typst paper open, showing the source, the rendered page and comment threads](public/marketing/workspace-dark.webp#gh-dark-mode-only)

## Comments that follow the text

Most editors pin a comment to a position, so it slides onto the wrong sentence once the text changes. annomate pins it to the words. Rewrite a sentence and its comment shows exactly what changed. Delete the passage and the comment says so, with a link to the line at the commit it was made on.

![A comment whose passage was rewritten, showing the old and new words](public/marketing/comment.webp#gh-light-mode-only)
![A comment whose passage was rewritten, showing the old and new words](public/marketing/comment-dark.webp#gh-dark-mode-only)

## Review side by side

See where everyone is typing in the source and pointing on the page, and follow a co-author as they move through the document.

![A collaborator's cursor in the source and their pointer over the page](public/marketing/presence.webp#gh-light-mode-only)
![A collaborator's cursor in the source and their pointer over the page](public/marketing/presence-dark.webp#gh-dark-mode-only)

## Also included

- A Typst preview that compiles in your browser, with PDF export, pinch zoom and click-to-jump between source and page.
- Commit and pull from the app, with a diff of what you are about to push and a graph of the repo's history.
- A file tree with folders, drag and drop, and uploads for images and fonts.
- Your project stays in your own GitHub repo. annomate commits as you.

## Coding agents

Claude Code, Codex, Cursor and other MCP clients can read, add, edit, reply to and resolve comments. Ask your agent to work through a review, and it fixes the text in your checkout and answers each thread. For Claude Code:

```sh
claude mcp add --transport http annomate https://annomate.hill.xyz/mcp
```

The agent signs in through annomate's own OAuth. Its replies show under your name, tagged with the agent's, and disconnecting revokes access at once.

## How it works

One Cloudflare Worker serves the app and the API. Each project gets a Durable Object that holds the shared Yjs document, relays presence, keeps comments in its own SQLite and makes the GitHub calls. Typst compiles in the browser with typst.ts 0.7, which bundles Typst 0.14.2.

Each comment keeps two anchors. Yjs relative positions follow edits made in annomate. The quoted text, its context and its commit survive everything else. A pull merges upstream changes three ways as a minimal diff. Any comment that lost its place is then found again by exact quote, by its surrounding context, or by fuzzy match. `shared/anchor.ts` holds the logic and `tests/anchor.test.ts` covers the cases.

## Run it locally

1. Run `bun install`.
2. Copy `.dev.vars.example` to `.dev.vars` and paste in the values `just secrets` prints.
3. Set `DEV_GITHUB_TOKEN` to the output of `gh auth token`.
4. Run `just db-migrate`, then `just dev`.
5. Open `http://localhost:5181/auth/dev?login=yourname`.

The `/auth/dev` route skips GitHub sign-in and only answers on localhost with `DEV_LOGIN=1`.

To deploy your own copy, create a GitHub OAuth app, a D1 database and a KV namespace. Put their IDs in the `production` section of `wrangler.jsonc`, set the secrets with `wrangler secret put`, and run `just deploy`.

`just test` runs the unit tests. `E2E_REPO=owner/name just e2e` runs the browser tests. Add `E2E_SANDBOX=owner/name` for the tests that commit, and point it at a scratch repo.

## Limits

- Pull is manual. A GitHub push webhook could trigger it.
- Projects using a Typst 0.15 feature will not compile until typst.ts ships a 0.15 build.
