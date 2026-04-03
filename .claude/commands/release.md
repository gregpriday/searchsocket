---
description: Automated NPM release via GitHub Actions with version detection
argument-hint: [patch|minor|major] (optional - auto-detected if omitted)
allowed-tools:
  - Bash(pnpm run:*)
  - Bash(pnpm typecheck:*)
  - Bash(pnpm test:*)
  - Bash(pnpm build:*)
  - Bash(npm pack:*)
  - Bash(npm view:*)
  - Bash(git status:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git tag:*)
  - Bash(git push:*)
  - Bash(git branch:*)
  - Bash(git log:*)
  - Bash(git describe:*)
  - Bash(git diff:*)
  - Bash(node:*)
  - Read
  - Edit
  - Write
---

# Automated NPM Release for searchsocket

Publishing is handled by GitHub Actions (NPM Trusted Publishing / OIDC) when a `v*` tag is pushed. This command prepares the release, tags it, and pushes — the workflow does the actual `npm publish`.

## Current State
- Git status: !`git status`
- Current branch: !`git branch --show-current`
- Latest tag: !`git describe --tags --abbrev=0 2>/dev/null || echo "none"`
- Current version: !`node -p "require('./package.json').version"`
- Changes since last tag: !`git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD")..HEAD --oneline 2>/dev/null || echo "No previous tags"`

## Automated Release Process

**IMPORTANT:** This command will automatically:
1. Analyze commit history to determine version bump type
2. Run typecheck, build, and tests (STOP if any fail)
3. Update package.json version
4. Update CHANGELOG.md
5. Commit changes
6. Create git tag
7. Push to origin (GitHub Actions publishes to NPM)

### Step 1: Analyze Changes & Determine Version

Version bump override: $ARGUMENTS

**If $ARGUMENTS is empty, auto-detect version bump:**

Read all commits since the last git tag. Analyze commit messages following Conventional Commits:
- **MAJOR** (breaking): Look for "BREAKING CHANGE:", "!" after type (e.g., "feat!:"), or "major:" prefix
- **MINOR** (feature): Look for "feat:", "feature:", new functionality
- **PATCH** (fix): Look for "fix:", "bugfix:", "chore:", "docs:", "refactor:", "test:", "style:", improvements

Rules:
- If any BREAKING CHANGE found → MAJOR bump
- If any feat/feature found (no breaking) → MINOR bump
- Otherwise → PATCH bump
- If no commits since last tag → Ask user if they want to proceed with PATCH

Calculate new version based on current package.json version and bump type.

### Step 2: Pre-Release Validation

1. **Check for Uncommitted Changes**
   - Run `git status --porcelain`
   - If ANY uncommitted changes exist (modified, untracked, or staged files):
     - List all uncommitted changes
     - STOP release process
     - Tell user: "Please commit or stash all changes before running release. The release process will only commit the version bump and changelog update."
     - Do NOT proceed with any release steps

2. **Verify Prerequisites**
   - Must be on `main` branch (STOP if not)
   - Run `pnpm run typecheck` - must pass (STOP if fails)
   - Run `pnpm run build` - must succeed (STOP if fails)
   - Run `pnpm run test` - all tests must pass (STOP if any fail)
   - Run `npm pack --dry-run` to preview package

### Step 3: Update Files Automatically

1. **Update package.json**
   - Read current package.json
   - Update `version` field to new calculated version
   - Write back to file

2. **Update CHANGELOG.md**
   - Read current CHANGELOG.md
   - Add new version entry at the top (after the heading) with today's date
   - Format: `## [NEW_VERSION] - YYYY-MM-DD`
   - Include key changes from commit history as bullet points
   - Group by type: features, fixes, other changes

### Step 4: Commit & Tag

Execute these commands sequentially:

```bash
git add package.json CHANGELOG.md
git commit -m "chore: prepare for v[NEW_VERSION] release"
git tag -a v[NEW_VERSION] -m "Release version [NEW_VERSION]

[First 3-5 key changes from commit history]"
```

### Step 5: Push to Git (Triggers NPM Publish)

```bash
git push origin main
git push origin v[NEW_VERSION]
```

The `v*` tag push triggers the GitHub Actions publish workflow which:
- Installs dependencies, typechecks, builds, tests
- Publishes to NPM with provenance via OIDC (no token needed)

### Step 6: Verify & Report

After pushing, report to user:

- Version: [NEW_VERSION]
- Tag `v[NEW_VERSION]` pushed — GitHub Actions will publish to NPM
- NPM (after workflow completes): https://www.npmjs.com/package/searchsocket
- Install: `npm install searchsocket` or `pnpm add searchsocket`
- GitHub Actions: check the Actions tab for publish status
- **Key changes in this release:**
  [List 5-7 main changes from commit history since last tag]

## Error Handling

**If typecheck/build/tests fail:**
- Report what failed
- STOP release process
- Tell user to fix the issue first

**If git has uncommitted changes:**
- List all uncommitted files
- Tell user: "Please commit or stash all changes before running release"
- STOP release process

**If git push fails:**
- Check remote access
- Verify branch is up to date
- Note: No package has been published yet (that happens in CI)
- User may need to pull/rebase and retry

## Package Details

- Package: `searchsocket`
- Binary: `searchsocket`
- License: MIT
- Minimum Node: >=20
- Package Manager: pnpm
- Publish method: GitHub Actions OIDC (NPM Trusted Publishing)
