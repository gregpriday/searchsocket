# CI / CD Workflows

## 1. Main Branch Indexing (GitHub Actions)

```yaml
name: sitescribe-index-main

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
      - run: pnpm sitescribe index --changed-only
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          MILVUS_URI: ${{ secrets.MILVUS_URI }}
          MILVUS_TOKEN: ${{ secrets.MILVUS_TOKEN }}
```

## 2. PR Cost Preview (Dry Run)

```yaml
name: sitescribe-dry-run

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
      - run: pnpm sitescribe index --dry-run --changed-only
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## 3. Preview Branch Scope Indexing

If using `scope.mode = "git"` or `scope.mode = "env"`, index each preview branch into its own scope.

Example with `scope.mode = "env"`:

```yaml
- run: pnpm sitescribe index --changed-only
  env:
    SITESCRIBE_SCOPE: ${{ github.head_ref || github.ref_name }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    MILVUS_URI: ${{ secrets.MILVUS_URI }}
    MILVUS_TOKEN: ${{ secrets.MILVUS_TOKEN }}
```

## 4. Scheduled Prune Job

> **Important:** The prune command uses `git branch -r` to identify active scopes.
> You must set `fetch-depth: 0` in the checkout step so that remote branch refs are
> available. Without this, a shallow clone may only see the current branch and prune
> could incorrectly delete scopes for active feature branches.

```yaml
name: sitescribe-prune

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
      - run: pnpm sitescribe prune --older-than 30d --apply
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          MILVUS_URI: ${{ secrets.MILVUS_URI }}
          MILVUS_TOKEN: ${{ secrets.MILVUS_TOKEN }}
```

## 5. Vercel Build-Triggered Indexing

Use the build plugin + env flags:

- Set `SITESCRIBE_AUTO_INDEX=1` in Vercel project env
- Set provider credentials (`OPENAI_API_KEY` + vector backend env vars)

Your Vite plugin setup:

```ts
import { sitescribeVitePlugin } from "sitescribe/sveltekit";

export default {
  plugins: [sitescribeVitePlugin({ changedOnly: true })]
};
```

Disable temporarily:

- set `SITESCRIBE_DISABLE_AUTO_INDEX=1`

## 6. Committing Markdown Mirror (Content Projects)

If you want deterministic indexed content tracked in git:

- keep `.sitescribe/pages/**` committed
- ensure `.sitescribe/*.sqlite` remains ignored (recommended)
- review markdown mirror diffs in PRs to validate indexing input changes
