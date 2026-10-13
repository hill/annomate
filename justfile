default:
    @just --list

# Run the app and Worker together on one dev server
dev:
    bun run dev

test:
    bun run test

e2e:
    bunx playwright test

typecheck:
    bunx tsc -b

lint:
    bun run lint

# Apply D1 migrations locally
db-migrate:
    bunx wrangler d1 migrations apply annomate --local

db-migrate-remote:
    bunx wrangler d1 migrations apply annomate --remote

# Generate the three secrets annomate needs, for .dev.vars or wrangler secret put
secrets:
    @echo "SESSION_SECRET=$(openssl rand -base64 32)"
    @echo "TOKEN_KEY=$(openssl rand -base64 32)"

# Rebuild the editor's hover docs from the Typst reference
typst-docs:
    bun scripts/typst-docs.ts

deploy:
    bun run deploy
