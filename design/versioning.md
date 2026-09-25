# Team Versioning Lifecycle

Design document for semantic versioning, publishing, and updating across cliq (CLI) and CliqHub (web UI).

## Overview

Teams use semantic versioning (semver). Versions are immutable once published. The registry (CliqHub DB) is the version authority. `team.yml` carries the version as read-only metadata managed by `cliq team version`, not edited manually.

Two publishing paths:
- **CLI path** — version lives in `team.yml`, author bumps it locally, git commit + tag, then publishes
- **Builder path** — author picks a bump type in the UI, server computes next version atomically

Both converge on the same API and `team_versions` table.

## Command Summary

| Command | What it does |
|---|---|
| `cliq team version patch\|minor\|major @scope/name` | Bump local team.yml + git commit + tag |
| `cliq hub publish @scope/name` | Ship to registry (reads version from team.yml) |
| `cliq hub publish @scope/name -m "message"` | Ship with changelog |
| `cliq hub install @scope/name` | First-time install (latest) |
| `cliq hub install @scope/name@1.2.0` | Install specific version |
| `cliq hub update` | Update all installed teams |
| `cliq hub update @scope/name` | Update one team to latest |
| `cliq hub update @scope/name@2.0.0` | Update to specific version |
| `cliq hub info @scope/name` | Show versions, installed status |

## Semantic Meaning

- **patch** — Role prompt tweaks, command updates, bug fixes. No structural changes to the DAG.
- **minor** — New phases, new inputs, new agents. Backward-compatible additions.
- **major** — Removed/renamed inputs, restructured phases, removed agents. Breaking changes.

---

## Phase 1: Data Model & API Foundation (CliqHub)

Ensure the DB and API support version bumping, changelogs, and version queries.

### `lib/db/migrate.ts`
- Add `changelog` column to `team_versions` if not already present (TEXT, nullable)
- Ensure `version` column has a unique constraint per team: `UNIQUE(team_id, version)`

### `lib/handlers/teams.ts`
- Add `compute_next_version(team_id, bump)` helper:
  - Query `SELECT version FROM team_versions WHERE team_id = ? ORDER BY published_at DESC LIMIT 1`
  - Parse as semver, apply bump (patch/minor/major)
  - If no existing version, return `1.0.0`
- Update `publish` handler:
  - Accept `bump?: 'patch' | 'minor' | 'major'` in params
  - If `bump` is provided (builder path), compute version server-side
  - If `version` is provided (CLI path), use it directly
  - If neither, error
  - Store `changelog` from params
- Add `get_versions(name, scope)` handler:
  - Returns all versions for a team with changelog and publish date
  - Marks which is latest
- Add `get_latest_version(name, scope)` handler:
  - Returns just the latest version string (used by CLI for pre-publish checks)

### New API routes
- `POST /api/teams/versions` → calls `get_versions`
- `POST /api/teams/latest-version` → calls `get_latest_version`

### Tests
- `compute_next_version` unit tests: patch/minor/major from various starting versions, first publish → 1.0.0
- Publish with `bump` param: verify correct version computed
- Publish with explicit `version` that already exists: verify conflict error
- `get_versions` returns correct ordering and changelog

---

## Phase 2: CLI `cliq team version` Command (Cliq)

Bump version in `team.yml`, git commit, git tag.

### `src/commands/team_command.ts` (new or extend existing)
- `cliq team version patch|minor|major <teamref>`
- Resolves team directory from `<teamref>`
- Reads `team.yml`, parses current `version` field
- If no version field exists, initialize to `0.0.0` then apply bump (so `patch` → `0.0.1`, `minor` → `0.1.0`, `major` → `1.0.0`)
- Writes new version back to `team.yml`
- If inside a git repo:
  - `git add team.yml`
  - `git commit -m "v{new_version}"`
  - `git tag v{new_version}`
  - Print: `Bumped @scope/name to v{new_version} (git commit + tag created)`
- If not in a git repo:
  - Just update the file
  - Print: `Bumped @scope/name to v{new_version}`
- `--no-git` flag to skip git operations even inside a repo

### `src/cli.ts`
- Register the `team version` subcommand under the `team` command group

### `src/core/workflow_parser.ts`
- Ensure `version` field is read from and written to `team.yml` as top-level metadata
- Add `get_version()` and `set_version(version)` methods

### Tests
- Bump from `1.2.3`: patch → `1.2.4`, minor → `1.3.0`, major → `2.0.0`
- No version field: initialize correctly
- Git operations: verify commit message and tag name
- `--no-git`: verify file updated, no git calls

---

## Phase 3: CLI Publish Updates (Cliq)

`cliq hub publish` reads version from `team.yml` and ships it.

### `src/commands/hub_command.ts`
- Update `publish` method:
  - Read `version` from `team.yml` — if missing, error: "No version found. Run `cliq team version patch` first, or use `--init` to auto-initialize to v1.0.0."
  - `--init` flag: if no version exists, set to `1.0.0` automatically before publishing
  - Send `version` to the API (existing behavior, but now reading from `team.yml`)
  - On conflict (version already exists): error with "Version {v} already published. Run `cliq team version patch` to bump."
  - Accept `-m "changelog message"` flag, sent as `changelog` in the publish payload
  - Print version in success message: `Published @cliq/feature-dev-js v1.3.0`

### Tests
- Publish reads version from `team.yml`
- Missing version without `--init`: error
- Missing version with `--init`: publishes as `1.0.0`
- Conflict error message is correct
- Changelog is passed through

---

## Phase 4: CLI Update Command (Cliq)

`cliq hub update` updates installed teams to latest versions.

### `src/commands/hub_command.ts`
- Add `update` subcommand:
  - `cliq hub update` — update all installed teams
  - `cliq hub update @scope/name` — update one team
  - `cliq hub update @scope/name@2.0.0` — update to specific version
  - `--force` — skip confirmation prompt

#### Update all flow
1. Scan `~/.cliqrc/teams/` for installed teams (skip `@local`)
2. For each team, read `version` from `team.yml`
3. Batch-query registry for latest versions (new API endpoint)
4. Compute diff: up-to-date vs updatable
5. Print summary:
   ```
   @cliq/feature-dev-js    1.2.0 → 1.3.0  (minor)
   @cliq/hug-example       1.0.0 → 2.0.0  (MAJOR)
   @cliq/hello-world       1.1.0           (up to date)
   ```
6. If no updates: "All teams are up to date."
7. If updates available, list paths:
   ```
   The following will be overwritten:
     ~/.cliqrc/teams/@cliq/feature-dev-js
     ~/.cliqrc/teams/@cliq/hug-example      ⚠ major version bump

   Any local modifications will be lost.
   Proceed? (y/n)
   ```
8. On confirm: download and overwrite each
9. On decline: abort

#### Skips
- `@local` scoped teams are never updated (not registry-managed)
- Teams with no `version` in `team.yml` treated as `0.0.0`
- Teams removed from registry: warn and skip

### New API route (CliqHub)
- `POST /api/teams/batch-latest` — accepts list of `{ name, scope }`, returns latest version for each. Single query instead of N round trips.

### Tests
- Detects newer version available
- Skips up-to-date teams
- Major bump requires confirmation
- `--force` skips confirmation
- `@local` teams are skipped
- Specific version update downloads correct version
- Atomic overwrite via temp dir

---

## Phase 5: CLI Info Enhancement (Cliq)

`cliq hub info` shows version history and installed status.

### `src/commands/hub_command.ts`
- Update `info` output:
  ```
  @cliq/feature-dev-js
    Description:  A feature development team...
    Domain:       engineering
    Installs:     42

    Versions:
      v1.3.0  (latest)  Apr 15, 2026  "Added security audit phase"
      v1.2.0            Apr 10, 2026  "Fixed lint commands"
      v1.1.0            Apr 5, 2026
      v1.0.0            Mar 28, 2026  "Initial release"

    Installed: v1.2.0 (~/.cliqrc/teams/@cliq/feature-dev-js)
               Update available: v1.3.0 — run `cliq hub update @cliq/feature-dev-js`

    Install:
      cliq hub install @cliq/feature-dev-js
      cliq hub install @cliq/feature-dev-js@1.2.0
  ```
- Read local installed version from `team.yml` in the installed directory
- Compare with registry latest and show update hint if behind

---

## Phase 6: CliqHub Publish Dialog

Builder users can publish with version bumping from the UI.

### `components/builder/publish-dialog.tsx` (new)
- Modal triggered by "Publish" button in builder toolbar
- Content:
  - Team name with scope
  - Current published version (queried from API) or "Initial release"
  - Bump type selector: patch / minor / major (disabled for first publish)
  - Computed next version preview (updates live as bump type changes)
  - Changelog textarea (optional)
  - Cancel / Publish buttons
- On publish:
  - Sends team data + `bump` type + `changelog` to `/api/teams/publish`
  - Shows success with new version number
  - Clears dirty state
- First publish: shows "Version: 1.0.0 (initial release)", no bump selector

### `components/builder/canvas-view.tsx`
- Add "Publish" button in toolbar
- Only shown when team has a name and at least one phase
- Opens the publish dialog

---

## Phase 7: CliqHub Version History UI

Team detail page shows version history with per-version actions.

### `app/teams/[scope]/[name]/page.tsx`
- Query all versions from `team_versions`
- Add "Version History" section below team metadata
- Each version row:
  - Version number (latest gets green "latest" badge)
  - Publish date
  - Changelog (if present)
  - Download button (for that version)
  - View in Builder button (loads that version)
- Version selector dropdown near top: switches displayed workflow/roles/metadata to selected version

### `components/version-history.tsx` (new)
- Reusable version list component
- Accepts versions array, current selection, callbacks

### Existing component updates
- `DownloadTeamButton` — accept `version` prop
- `ViewInBuilderButton` — accept `version` prop

---

## Phase 8: CliqHub Account Page & Browse Updates

### `app/account/teams/page.tsx`
- Show version number on each published team card
- Add "Publish Update" button:
  - Loads latest version into builder
  - Opens publish dialog pre-filled

### `app/teams/page.tsx` and `app/page.tsx` (browse/home)
- Show version + last updated date on team cards:
  ```
  @cliq/feature-dev-js  v1.3.0  •  Updated Apr 15
  ```

### Install instructions on team detail page
- Show version options:
  ```
  cliq hub install @cliq/feature-dev-js           # latest (v1.3.0)
  cliq hub install @cliq/feature-dev-js@1.2.0     # specific version
  ```

---

## Phase 9: Validation & Doctor (Cliq)

### `src/commands/doctor_command.ts`
- Add check: "version field present in team.yml" (warning if missing)
- Add check: "version is valid semver" (error if malformed)

### `src/core/workflow_parser.ts`
- Validate `version` field is valid semver when present
- Reject non-semver strings during publish

### `lib/handlers/builder.ts` (CliqHub)
- Builder validation: if team was loaded from a published version, warn if version field was manually changed in YAML editor

---

## Phase 10: Install Command Updates (Cliq)

### `src/commands/hub_command.ts`
- Parse `@scope/name@version` syntax:
  - `cliq hub install @cliq/feature-dev-js` → latest
  - `cliq hub install @cliq/feature-dev-js@1.2.0` → specific version
- Pass version to download API
- After install, print: `Installed @cliq/feature-dev-js v1.3.0 → ~/.cliqrc/teams/@cliq/feature-dev-js`
- If already installed at same version: "Already installed at v1.3.0. Use `--force` to reinstall."

---

## Phase 11: Documentation (Cliq — Redocly)

### `redocly/docs/versioning.md` (new)
- **Overview** — semver, immutable versions
- **Version field** — lives in `team.yml` as read-only metadata
- **Bumping versions** — `cliq team version patch|minor|major`, git behavior, `--no-git`
- **First publish** — starts at `1.0.0`, `--init` flag
- **Changelogs** — `-m "message"` on publish
- **Version immutability** — cannot overwrite a published version

### `redocly/docs/publishing.md` (new or update)
- **Publishing from CLI** — edit → version bump → publish workflow
- **Publishing from Builder** — publish dialog, bump selector
- **Conflict resolution** — version already exists
- **Visibility** — public/private/draft

### `redocly/docs/installing.md` (new or update)
- **Installing** — `cliq hub install`, version pinning
- **Where teams live** — `~/.cliqrc/teams/@scope/name`
- **Updating** — `cliq hub update`, update-all, confirmation flow
- **Update warnings** — overwrite paths, major version, `--force`
- **Customizing** — fork to `@local` or own scope
- **Checking for updates** — `cliq hub info`

### `redocly/docs/cli-reference.md` (update)
- Add `cliq team version` reference
- Add `cliq hub update` reference
- Update `cliq hub publish` with `-m` and `--init`
- Update `cliq hub install` with `@version` syntax
- Update `cliq hub info` with version history

### `redocly/docs/teams.md` (update)
- Add `version` to team.yml schema
- Note: managed by `cliq team version`, not manually edited

### Navigation
- Add new pages to `sidebars.yaml` under appropriate sections

---

## Dependency Order

```
Phase 1  (DB + API foundation)
  ├── Phase 2  (CLI team version)
  │     └── Phase 3  (CLI publish updates)
  ├── Phase 4  (CLI update command)
  ├── Phase 5  (CLI info enhancement)
  ├── Phase 6  (Builder publish dialog)
  ├── Phase 7  (Version history UI)
  └── Phase 8  (Account/browse updates)

Phase 9   (Validation/doctor) — after Phase 2
Phase 10  (Install updates) — independent
Phase 11  (Documentation) — after all feature phases
```

Phases 2-8 can run in parallel once Phase 1 is done.
