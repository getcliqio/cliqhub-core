# My Teams & Scope Navigation

## Problem

A user who belongs to multiple scopes (personal + org scopes) has no way to
navigate to teams in those scopes. The current "My Teams" page only queries
the user's personal scope (`@username`). Publishing `@cliq/hello-world`
results in a team that is invisible from the sidebar — the only way to find
it is via the global "Browse Teams" search, and private-scope teams would be
completely unreachable.

### Current state

| Page | What it shows | What's missing |
|------|---------------|----------------|
| My Teams (`/account/teams`) | Teams in `@username` scope + drafts | Teams in org scopes the user belongs to |
| Organizations (`/account/orgs/[id]`) | Members and scopes with member management | No team lists per scope |
| Browse Teams (`/teams`) | Global public search | No access to private-scope teams |

### Data model recap

- Each user has a personal scope (slug = username, `scope_type = 'user'`)
- Orgs have one or more scopes (`scope_type = 'org'`)
- `auth.scopes` on the client contains **all** scopes the user has access to
- `list_my_teams()` on the server takes a single `scope` param and queries
  `WHERE t.scope = ?`

---

## Design

### 1. New server endpoint: `POST /api/teams/mine-all`

**Handler:** `teams.list_all_my_teams(auth)`

Queries teams across **all** scopes the user has access to, grouped by scope.

```sql
SELECT t.id, t.name, t.scope, t.description, u.username AS author,
       (SELECT version FROM team_versions WHERE team_id = t.id
        ORDER BY published_at DESC LIMIT 1) AS latest_version,
       t.install_count, t.listed
FROM teams t
LEFT JOIN users u ON u.id = t.author_id
WHERE t.scope IN (?, ?, ...)     -- all auth.scopes slugs
   OR t.author_id = ?            -- also include unscoped teams they authored
ORDER BY t.scope, t.updated_at DESC
```

Response shape:

```json
{
    "ok": true,
    "data": {
        "scopes": [
            {
                "slug": "elan",
                "display_name": "elan",
                "scope_type": "user",
                "visibility": "public",
                "teams": [
                    { "name": "my-tool", "scope": "elan", "latest_version": "1.0.0", ... }
                ]
            },
            {
                "slug": "cliq",
                "display_name": "Cliq",
                "scope_type": "org",
                "visibility": "public",
                "teams": [
                    { "name": "hello-world", "scope": "cliq", "latest_version": "1.0.0", ... }
                ]
            }
        ]
    }
}
```

This replaces the current `list_my_teams` call on the My Teams page.
The existing `list_my_teams` endpoint stays for per-scope queries
(used by scope detail pages).

### 2. Redesign "My Teams" page (`/account/teams`)

Currently a flat list. Becomes a **scope-grouped** view:

```
My Teams
Manage your drafts and published teams across all your scopes.
                                                    [+ New Team]

─── Drafts ───────────────────────────────────────────
  hello-draft          Last edited Apr 20     [Resume] [Delete]

─── @elan (personal) ─────────────────────── public ──
  @elan/my-tool        v1.0.0   3 installs   [View / Edit]

─── @cliq (Cliq) ─────────────────────────── public ──
  @cliq/hello-world    v1.0.0   0 installs   [View / Edit]

─── @cliq-labs (Cliq Labs) ───────────────── private ─
  (no teams yet)
```

Each scope section:
- Header shows `@slug`, display name if different, visibility badge
- Scope slug is a link to the scope detail page (`/teams/@slug`)
- Teams listed under it with same row layout as today
- Empty scopes shown with "(no teams yet)" to make them discoverable

### 3. New scope detail page: `/teams/@[slug]`

A dedicated page for viewing all teams within a single scope. Accessible to
scope members (and public for public scopes).

```
← My Teams

@cliq · Cliq · public
3 teams · 2 members

  @cliq/hello-world    v1.0.0   0 installs   [View / Edit]
  @cliq/tdd-pipeline   v2.1.0   42 installs  [View / Edit]
  @cliq/code-review    v1.3.0   18 installs  [View / Edit]
```

**Route:** `app/teams/@[slug]/page.tsx` — but since `@` is tricky in
filesystem paths, use `app/teams/s/[slug]/page.tsx` with URL `/teams/s/cliq`.

**Server:** Reuses existing `teams.list_my_teams(auth, { scope })` which
already queries by scope and checks access.

### 4. Update sidebar to show scopes

Add scope links to the sidebar under a "Scopes" section, derived from
`auth.scopes`:

```
  ● Builder
  ○ Browse Teams
  ○ My Teams

  SCOPES
  ○ @elan
  ○ @cliq
  ○ @cliq-labs

  ○ Organizations
  ○ API Tokens
  ○ Account
```

Each scope link goes to `/teams/s/{slug}`. This gives one-click access to
any scope's team list.

### 5. Add team count to org scope expansion

Currently the org detail page (`/account/orgs/[id]`) shows scopes with only
member management when expanded. Add a team list (or at minimum a team count
with a link to `/teams/s/{slug}`) so the user can navigate from org → scope →
teams.

The scope card already shows `member_count` from the API. Add `team_count`
to the `OrgScope` interface (server already has the data via
`SELECT count(*) FROM teams WHERE scope = ?`).

When the scope row is expanded, show:
- Team count with link: "4 teams → View all"
- Member management (existing)

---

## Files changed

### Server

| File | Change |
|------|--------|
| `lib/handlers/teams.ts` | Add `list_all_my_teams()` — query across all user scopes, return grouped |
| `app/api/teams/mine-all/route.ts` | **New** — POST route delegating to `list_all_my_teams` |
| `lib/handlers/orgs.ts` | Add `team_count` to scope query in `get_org()` |

### Frontend

| File | Change |
|------|--------|
| `app/account/teams/page.tsx` | Rewrite to call `/api/teams/mine-all`, render scope-grouped layout |
| `app/teams/s/[slug]/page.tsx` | **New** — scope detail page with team list |
| `app/teams/s/[slug]/layout.tsx` | **New** — layout with `AppSidebar` |
| `components/app-sidebar.tsx` | Add "Scopes" section from `auth.scopes` |
| `app/account/orgs/[id]/page.tsx` | Add `team_count` display and link in scope expansion |

---

## Edge cases

- **User with no scopes**: Shouldn't happen (every user gets a personal scope
  on signup), but handle gracefully with "No scopes" message.
- **Empty scopes**: Show them with "(no teams yet)" — they're still navigable
  and publishable.
- **Many scopes**: If a user belongs to 10+ scopes, the sidebar list could
  get long. Cap at 5 in sidebar with a "Show all" link to My Teams. Not
  likely to be an issue in the near term.
- **Private scope teams**: Correctly gated by scope membership check in
  `list_my_teams` — no change needed.
- **Admin users**: Site admins should see all scopes they're members of, not
  all scopes globally. Same query — admin bypass is not needed here.
