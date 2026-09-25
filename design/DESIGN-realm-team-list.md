# Realm Team List

> **API hard-cut (2026-09):** Public HTTP no longer exposes `/v1/realms/team-list/*` or
> `/v1/realms/teams/get`. Mutate the desired set with `POST /v1/realms/add_team` /
> `remove_team`. Roster / coverage reads use `POST /v1/teams/get` `{ realm_id, … }`.
> Storage may still be a realm `team_list` JSONB column; only the HTTP surface changed.
> Checklist below for the old multi-path API is **superseded** — treat as historical.

## Problem

Today, installing a team on a daemon is a low-level mechanical action — POST
an install command to a specific daemon. There is no concept of "this realm
should have these teams." Operators must manually install teams on each
daemon individually, and new daemons joining a realm start empty.

We need:
1. A realm-level declaration of desired teams (the "team list").
2. A way to apply the team list to all daemons in the realm.
3. Automatic injection of the team list when a new daemon registers.
4. A dedicated management UI for the team list.
5. Visibility on the existing realm teams page showing which installed
   teams are part of the team list.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | `team_list JSONB` column on `realms` | Simple, no new table; list is small (tens of entries, not thousands). Can promote to a table later if needed. |
| Naming | "Team List" (not "bundle") | "Bundle" is already used for Docker runtime packaging. "Team List" is clear and unambiguous. |
| Team reference format | `{ scope, slug }` | Logical refs are human-readable and stable across daemon ID changes. Matches existing install API contract. |
| Separate page vs. inline | Separate page | Bundle management is a configuration concern; realm teams page is an operational/monitoring view. Keep them distinct. |
| Multiple lists per realm | No (single list) | Multiple lists would require daemon role/group assignment — a different feature. One list per realm covers the use case. |
| Drift reconciliation | Manual "Apply" only | Automatic reconciliation loops are a future enhancement. Operators can see drift on the teams page and re-apply. |

## Data Model

### Schema Migration

Add to `schema_migrations.ts`:

```sql
ALTER TABLE cliq."realms"
  ADD COLUMN IF NOT EXISTS "team_list" JSONB NOT NULL DEFAULT '[]'::jsonb;
```

### Column Schema

```json
[
  { "scope": "cliq", "slug": "hello-world" },
  { "scope": "myorg", "slug": "deploy-pipeline" }
]
```

Array of `{ scope: string, slug: string }` objects. Order is preserved but
not significant. Duplicates are prevented at the API layer.

### Realm Model

Add `team_list` to the `Realm` model attributes in `realm.model.ts`:

```typescript
team_list: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }
```

## API (historical — superseded by hard-cut)

> Use `POST /v1/realms/add_team` / `remove_team` and `POST /v1/teams/get` `{ realm_id }`.
> The `/v1/realms/team-list/*` routes below were removed.

All endpoints require realm membership. Write operations require realm
admin/owner role.

### `POST /v1/realms/team-list/get` (removed)

Read the team list.

**Request:** `{ realm_id: string }`
**Response:** `{ ok: true, team_list: Array<{ scope: string, slug: string }> }`

### `POST /v1/realms/team-list/set`

Replace the full team list.

**Request:** `{ realm_id: string, teams: Array<{ scope: string, slug: string }> }`
**Response:** `{ ok: true, team_list: Array<{ scope: string, slug: string }> }`

Deduplicates entries by `scope + slug` before writing.

### `POST /v1/realms/team-list/add`

Append a single team to the list. Idempotent — no-ops if already present.

**Request:** `{ realm_id: string, scope: string, slug: string }`
**Response:** `{ ok: true, team_list: Array<{ scope: string, slug: string }> }`

### `POST /v1/realms/team-list/remove`

Remove a single team from the list. Idempotent — no-ops if not present.

**Request:** `{ realm_id: string, scope: string, slug: string }`
**Response:** `{ ok: true, team_list: Array<{ scope: string, slug: string }> }`

### `POST /v1/realms/team-list/apply`

Apply the team list to all online daemons in the realm.

**Request:** `{ realm_id: string }`
**Response:**
```json
{
  "ok": true,
  "results": [
    {
      "scope": "cliq",
      "slug": "hello-world",
      "daemon_results": [
        { "daemon_id": "abc", "ok": true },
        { "daemon_id": "def", "ok": false, "error": "timeout" }
      ]
    }
  ]
}
```

Implementation: loops over each `{ scope, slug }` entry, resolves the team
(published registry first, then Hub teams table), and calls
`DispatchService.install_team` with `realm_id` for each. Returns per-team,
per-daemon results.

## Auto-Inject on Daemon Registration

In `DaemonService.register`, after `RealmService.upsert_daemon_member`:

1. Load the realm row, read `team_list`.
2. If non-empty, fire-and-forget install of each team to the newly
   registered daemon via `DispatchService.install_team` with
   `daemon_ids: [daemon_id]`.
3. Best-effort — failures are logged but do not block registration.
4. The daemon's heartbeat will confirm actual install state.

```
register daemon
  → create/refresh daemon row
  → upsert realm membership
  → read realm.team_list
  → for each team: install_team({ daemon_ids: [daemon_id] })  [fire-and-forget]
  → return registration result
```

## Frontend

### Realm Team List Page (new)

**Route:** `/realms/:slug/team-list`

Lazy-loaded component: `src/pages/account/realm_team_list_page.tsx`

**Layout:**
- `PageHeader` with `List` icon, title "Team List", description
  "Teams automatically installed on daemons in this realm."
- **Current list** — table of `scope/slug` entries, each with a remove
  button (X icon).
- **Add team** — input to add a team by `@scope/slug`. Autocomplete from
  known teams (published registry + installed teams across the realm).
- **"Apply to Realm" button** — calls the apply endpoint. Shows a
  progress/result toast with per-daemon outcomes.
- **Empty state** — "No teams in the list. Add teams to automatically
  install them on all daemons in this realm."

### Navigation (realm teams page → team list page)

On the existing realm teams page (`realm_teams_page.tsx`), add a button
in the page header area:

- `List` icon + "Team List" label
- Navigates to `/realms/:slug/team-list`

### Bundle Badge on Realm Teams Page

On the existing realm teams page:

- Fetch the realm's `team_list` alongside existing data loads.
- Build a `Set<string>` of `scope/slug` keys from the team list.
- For each team row in the coverage table, if `scope/slug` is in the set,
  show a small `List` icon or "in list" badge.
- Optional summary line: "3 of 5 listed teams installed on all daemons."

## Implementation Phases

| Phase | Description | Depends on |
|-------|-------------|------------|
| 1 | Schema migration (`team_list` column) | — |
| 2 | Realm model update | 1 |
| 3 | Team list CRUD endpoints (get/set/add/remove) | 1, 2 |
| 4 | Apply endpoint | 3 |
| 5 | Auto-inject on daemon registration | 3 |
| 6 | Team list management page (frontend) | 3, 4 |
| 7 | Team list badge on realm teams page | 3 |

Phases 6 and 7 can run in parallel once the backend is ready.
Phase 5 is independent of the frontend.

## Future Enhancements (out of scope)

- **Scheduled reconciliation** — periodic job that detects drift between
  the team list and actual daemon installs, and auto-applies.
- **Version pinning** — entries specify a required version
  (`{ scope, slug, version }`), not just latest.
- **Multiple lists per realm** — requires daemon role/group assignment
  to decide which daemons get which list.
- **Team list templates** — shareable lists that can be applied across
  multiple realms.
- **Audit log** — track additions/removals to the team list via the
  events system.
