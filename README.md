# annomate

Collaborative review for Typst and Markdown projects that live on GitHub. Edit together in real time, comment on the source, and commit back to the repo. Comments keep their place when the text changes, even when the change was pushed from somewhere else.

## What it does

- Live co-editing with each other's cursors, mouse pointers and a follow mode.
- A preview that compiles in the browser, with pinch zoom, PDF export and click-to-sync between source and page.
- Comment threads that survive edits, moves and outside pushes. A comment whose text changed shows a word diff against the original.
- Commit and pull from the app, with a diff of what you are about to push and a graph of the repo's history.
- A file tree with folders, drag and drop, and uploads for images and fonts.
- Coding agents can read and answer comments over MCP.

## Formats

A new project detects its format from the repo, preferring Typst, then LaTeX, then Markdown. `shared/formats.ts` holds the rules.

Markdown is typeset through Typst with the [cmarker](https://typst.app/universe/package/cmarker) package and mitex for maths, so it gets the same preview, sync and PDF export. To restyle it, add an `annomate.typ` at the repo root that defines `#let template(body) = …`. A missing image shows as a marked gap rather than stopping the document.

LaTeX projects are detected and editable, with highlighting. Their preview is not built yet.

## How comments stay put

Each comment keeps two anchors. Yjs relative positions follow the text through every edit made in annomate. The quoted text, its surrounding context and the commit it was made on survive everything else.

A pull merges upstream changes three ways and writes them in as a minimal diff, so untouched text keeps its identity. If a comment loses its live position, annomate looks for the exact quote, then the passage between its intact context, then a fuzzy match. If the text is gone, the comment says so and links to the line at its original commit. `shared/anchor.ts` holds the logic and `tests/anchor.test.ts` covers the cases.

## Coding agents

Claude Code, Codex, Cursor and other MCP clients can list, read, reply to and resolve comments. The comments pane has the setup command for each. For Claude Code:

```sh
claude mcp add --transport http annomate https://annomate.hill.xyz/mcp
```

The agent signs in through annomate's own OAuth server, and replies show under your name, tagged with the agent's. Disconnecting revokes access at once.

## Stack

One Cloudflare Worker serves the app and the API. Each project gets a Durable Object that holds the shared document, relays presence, stores comments in its own SQLite and makes the project's GitHub calls. D1 holds users and projects, and KV holds agent grants. Typst compiles in the browser with typst.ts 0.7, which bundles Typst 0.14.2.

## Local development

1. Run `bun install`.
2. Copy `.dev.vars.example` to `.dev.vars` and paste in the values `just secrets` prints.
3. Set `DEV_LOGIN=1` and set `DEV_GITHUB_TOKEN` to the output of `gh auth token`.
4. Run `just db-migrate`, then `just dev`.
5. Open `http://localhost:5181/auth/dev?login=yourname`.

The `/auth/dev` route skips GitHub sign-in. It only answers on localhost with `DEV_LOGIN=1`.

## Tests

- `just test` runs the unit tests.
- `E2E_REPO=owner/name just e2e` runs the browser tests that only read the repo. `E2E_MD_REPO` does the same for a Markdown repo.
- Add `E2E_SANDBOX=owner/name` to include the tests that commit. They push to that repo, so point it at a scratch one.

## Limits

- Pull is manual. A GitHub push webhook could trigger it.
- LaTeX has no preview yet.
- Projects using a Typst 0.15 feature will not compile until typst.ts ships a 0.15 build.
