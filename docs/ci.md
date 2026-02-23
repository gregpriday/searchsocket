# CI / CD Workflows

## 1. Main Branch Indexing (GitHub Actions)

```yaml
name: searchsocket-index-main

on:
  push:
    branches: [main]

jobs:
  index:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm searchsocket index --changed-only
        env:
          JINA_API_KEY: ${{ secrets.JINA_API_KEY }}
          TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}
```

## 2. PR Cost Preview (Dry Run)

```yaml
name: searchsocket-dry-run

on:
  pull_request:

jobs:
  dry-run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm searchsocket index --dry-run --changed-only
        env:
          JINA_API_KEY: ${{ secrets.JINA_API_KEY }}
```

## 3. Preview Branch Scope Indexing

If using `scope.mode = "git"` or `scope.mode = "env"`, index each preview branch into its own scope.

Example with `scope.mode = "env"`:

```yaml
- run: pnpm searchsocket index --changed-only
  env:
    SEARCHSOCKET_SCOPE: ${{ github.head_ref || github.ref_name }}
    JINA_API_KEY: ${{ secrets.JINA_API_KEY }}
    TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
    TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}
```

## 4. Scheduled Prune Job

> **Important:** The prune command uses `git branch -r` to identify active scopes.
> You must set `fetch-depth: 0` in the checkout step so that remote branch refs are
> available. Without this, a shallow clone may only see the current branch and prune
> could incorrectly delete scopes for active feature branches.

```yaml
name: searchsocket-prune

on:
  schedule:
    - cron: "0 4 * * *"
  workflow_dispatch:

jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm searchsocket prune --older-than 30d --apply
        env:
          JINA_API_KEY: ${{ secrets.JINA_API_KEY }}
          TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}
```

## 5. Vercel Build-Triggered Indexing

Use the build plugin + env flags:

- Set `SEARCHSOCKET_AUTO_INDEX=1` in Vercel project env
- Set provider credentials (`JINA_API_KEY` + vector backend env vars)

Your Vite plugin setup:

```ts
import { searchsocketVitePlugin } from "searchsocket/sveltekit";

export default {
  plugins: [searchsocketVitePlugin({ changedOnly: true })]
};
```

Disable temporarily:

- set `SEARCHSOCKET_DISABLE_AUTO_INDEX=1`

## 6. Committing Markdown Mirror (Content Projects)

If you want deterministic indexed content tracked in git:

- keep `.searchsocket/pages/**` committed
- ensure `.searchsocket/*.json` remains ignored (recommended)
- review markdown mirror diffs in PRs to validate indexing input changes
