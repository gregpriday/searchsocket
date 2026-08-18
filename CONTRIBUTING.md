# Contributing

## Setup

```bash
pnpm install
pnpm run check     # typecheck, build, test, package check
```

Node 22 or 24. pnpm is required — the lockfile is pnpm's.

## Test tiers

| Command | What it covers |
| --- | --- |
| `pnpm run test` | Unit and integration tests against the source tree |
| `pnpm run check:package` | The packed tarball: every export resolves, nothing unexpected ships |
| `pnpm run test:quality` | Search relevance against a live index (needs Upstash credentials) |
| `pnpm run check` | All of the above except quality |

`pnpm run check:package` matters more than its size suggests. The `./svelte`
subpath ships raw TypeScript rather than bundled output, so adding an import to
`src/svelte/*` breaks the installed package while every source test stays green.
That is how v0.7.1 shipped broken.

## Working on this codebase

**Tests express invariants, not implementation.** The safety-critical suites are
named for the property they protect — `indexing-safety`, `isolation`,
`storage-errors`, `api-security`, `search-contract`. When you change behaviour
those files guard, change the test deliberately and say why in the commit
message. Do not weaken one to make a refactor pass.

**Some rules are release-blocking.** They exist because each one was violated at
some point and cost data or leaked something:

- An indexing run that did not observe the complete source deletes nothing.
- A record from one project or scope is never returned to another.
- A backend failure is never reported as an empty index or zero results.
- Every documented config option affects runtime, is rejected with a migration
  message, or is removed. Nothing is tunable-but-inert.
- Every published export resolves from the packed tarball.

**Error handling.** Use `SearchSocketError` from `src/errors/` with a typed code
rather than a bare `Error`. Never let a raw SDK message reach a caller — it can
contain a credential or an internal URL; wrap it and keep the original as
`cause`.

**Logging.** Use the `Logger` from `src/core/logger.ts`. `console.log` breaks the
MCP stdio transport, which needs a clean stdout for JSON-RPC framing.

**Config.** Every option goes through the Zod schema in `src/config/schema.ts`.
Removing one means adding it to `REMOVED_CONFIG_KEYS` in `src/config/load.ts`
so existing configs get a migration message instead of silent stripping.

**Svelte.** Templates and the runes API use Svelte 5 syntax (`$state`, `$props`,
`$derived`, `$effect`). No `export let`.

## Branching

Git Flow. `develop` is the default branch and where feature PRs land; `main`
carries release tags only. See CLAUDE.md for the full model and the release
process.

## Commits

Conventional Commits. The body should explain why the change was needed —
particularly what went wrong without it — not restate the diff.
