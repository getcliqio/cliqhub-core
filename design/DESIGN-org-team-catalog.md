# Design: Org-Level Team Catalog

**Status:** Draft  
**Author:** Elan / AI  
**Date:** 2026-09-06

---

## Problem

There is no intermediate layer between the public marketplace (`public.teams`) and realm installation (`cliq.realms.team_list`). Today, any authenticated user can install any public team into any realm. This creates several issues:

1. **Marketplace flood** — The `/teams` page cannot show "teams available to me" without either showing only self-published teams (`mine: true`) or showing the entire public marketplace.
2. **No curation** — Org admins have no way to define "this is the approved set of teams for our org." Realm operators pick from the global pool with no guardrails.
3. **Missing link** — A team installed in a realm may not appear in the account-level teams list, creating a logical inconsistency. Built-in teams like `@cliq/hello-world` are invisible until a daemon pushes them.
4. **No audit trail** — No record of when/why a team was adopted by an org vs. simply being public.

## Proposal

Introduce an **org-level team catalog** — the authoritative set of teams available for installation into the org's realms.

```
Marketplace (public.teams)
    ↓  adopt / subscribe
Org Team Catalog (org_team_catalog)
    ↓  install
Realm team_list (cliq.realms.team_list)
    ↓  dispatch
Daemon runtime (cliq.teams)
```

### Core Principle

**Realm `team_list` entries must reference teams in the org's catalog.** The catalog is the org's contract with the platform — what they've intentionally adopted.

---

## Data Model

### `org_team_catalog`

The materialized set of teams available to an org for realm installation.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Row identity |
| `org_id` | INTEGER NOT NULL | Owning org (FK → `orgs.id`) |
| `scope` | TEXT NOT NULL | Team scope (e.g. `cliq`, `acme`) |
| `slug` | TEXT NOT NULL | Team slug (e.g. `hello-world`) |
| `source` | TEXT NOT NULL | How it was added: `subscription`, `manual`, `builtin` |
| `added_by` | INTEGER | User who added it (null for `builtin`) |
| `added_at` | TIMESTAMPTZ NOT NULL | When it was added |

**Unique constraint:** `(org_id, scope, slug)`

### `org_scope_subscriptions`

UX convenience for bulk-adding teams from a scope to the catalog.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Row identity |
| `org_id` | INTEGER NOT NULL | Subscribing org (FK → `orgs.id`) |
| `scope_slug` | TEXT NOT NULL | Subscribed scope (e.g. `cliq`, `acme`) |
| `subscribed_by` | INTEGER | User who subscribed |
| `subscribed_at` | TIMESTAMPTZ NOT NULL | When subscribed |

**Unique constraint:** `(org_id, scope_slug)`

Scope subscriptions are **sugar** — they auto-populate the catalog when:
- A subscription is created (backfill all existing teams in that scope)
- A new team is published under a subscribed scope (webhook/trigger)

The catalog remains the single source of truth. Removing a subscription does NOT remove already-cataloged teams (they were explicitly adopted).

---

## Lifecycle

### Account Creation

1. Create org + default scope + default realm (existing flow).
2. **Auto-subscribe** to the `cliq` scope → backfill `@cliq/hello-world` into catalog as `source: 'builtin'`.
3. Realm `team_list` seeding (existing) references catalog entries.

### Adopting a Team (Manual)

1. User browses marketplace, finds `@acme/data-pipeline`.
2. Clicks "Add to org" → `INSERT INTO org_team_catalog (org_id, scope, slug, source, added_by)`.
3. Team now appears in the `/teams` page and is available for realm installation.

### Subscribing to a Scope

1. User navigates to scope `@acme` → clicks "Subscribe."
2. `INSERT INTO org_scope_subscriptions`.
3. Backfill: all current `public.teams` where `scope = 'acme'` → insert into `org_team_catalog` with `source: 'subscription'`.
4. Future publishes under `@acme` auto-insert into catalog for all subscribed orgs.

### Installing into a Realm

1. Realm admin picks from the catalog (not the marketplace directly).
2. `RealmTeamListService.add` validates the entry exists in `org_team_catalog` for the realm's org.
3. `DispatchService.install_team` proceeds as today.

### Removing from Catalog

1. Admin removes a team from the catalog.
2. **Does not** auto-uninstall from realms — running infrastructure should not be disrupted.
3. A warning surfaces on realm team list: "team not in org catalog."
4. Future installs of this team are blocked until re-added.

---

## API Surface

### Catalog CRUD

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/org/catalog/get` | List catalog entries for the current org |
| POST | `/v1/org/catalog/add` | Add a team to the catalog (manual) |
| POST | `/v1/org/catalog/remove` | Remove a team from the catalog |

### Scope Subscriptions

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/org/subscriptions/get` | List scope subscriptions |
| POST | `/v1/org/subscriptions/add` | Subscribe to a scope |
| POST | `/v1/org/subscriptions/remove` | Unsubscribe from a scope |

### Modified Existing Endpoints

- **`RealmTeamListService.add`** — Validate team is in org catalog before adding to realm.
- **`/v1/teams/get`** — New filter: `catalog: true` returns only teams in the caller's org catalog (replaces `mine: true` for the `/teams` page).

---

## Frontend Changes

### Easy-by-Default Principle

Zero configuration for the common case. Out of the box:

1. **Auto-subscribe to `@cliq`** on org creation → built-in teams appear in catalog immediately.
2. **Auto-subscribe to the org's own scope** on org creation → any team published by an org member automatically appears in the catalog for all members.
3. **Realm team picker reads from catalog** → realm operators see only approved teams, no marketplace noise.

Admins only need to intervene when adopting third-party scopes or curating available teams.

### Org Detail Page → New "Team Catalog" Tab

Add a `catalog` tab to the existing org detail page (`org_detail_page.tsx`, alongside Overview / Members / Scopes / A2A / Settings):

**Scope Subscriptions Section** (top of tab):
- Card per subscribed scope showing: scope name, team count, subscribed date, subscribed by.
- Toggle or "×" to unsubscribe (admin only). Unsubscribing does NOT remove already-cataloged teams.
- **"Subscribe to scope"** button → search/picker modal that queries available scopes and subscribes.
- Default subscriptions (`@cliq`, org's own scope) shown with a `default` badge; cannot be removed.

**Catalog Table** (below subscriptions):
- Columns: Scope, Team Name, Latest Version, Source (`builtin` / `subscription` / `manual`), Added By, Added At.
- Row click → navigates to team detail page.
- **"Add team"** button (admin only) → opens a marketplace search picker. Selecting a team adds it to the catalog with `source: 'manual'`.
- **"Remove"** action per row (admin only) → confirmation dialog, removes from catalog. Does not uninstall from realms.
- Filter/search bar: filter by scope, search by name.
- Sort: alphabetical by scope → name (default), or by added date.
- Empty state: "No teams in your org catalog. Subscribe to a scope or add teams from the marketplace."

### `/teams` Page

Replace `mine: true` with `catalog: true`:

- **Default view**: All teams in the current org's catalog, grouped by scope.
- **Filter**: By scope, search query.
- **Actions**: "Install to realm" (opens realm picker), link to team detail.
- **Empty state**: "No teams in your org catalog. Ask an admin to subscribe to scopes or add teams." (with link to org settings for admins).
- Non-admin members see read-only catalog (no add/remove controls).

### Marketplace / Browse

Existing browse pages remain unchanged. Add context-aware actions:

- **"Add to org"** button on team cards/detail when the team is NOT already in the caller's org catalog (admin only).
- **"In catalog ✓"** badge on team cards/detail when the team IS already in the catalog.
- Clicking "Add to org" immediately inserts into `org_team_catalog` with `source: 'manual'` and shows a toast.

### Realm Team List (`realm_teams_page.tsx`)

- Team picker dropdown/modal now queries from the org catalog (`/v1/org/catalog/get`) instead of the full marketplace.
- Installed teams that are **no longer in the catalog** show a warning badge: "⚠ Not in org catalog" with tooltip: "This team was removed from the org catalog. It will continue to run but cannot be re-installed."
- The "Add team" action on the realm team list validates against the catalog server-side (`RealmTeamListService.add`).

### Run-in-Realm Dialog (`run_in_realm_dialog.tsx`)

- Team selector dropdown should also filter from the org catalog, not the full marketplace.
- Ensures users can only start runs for teams the org has adopted.

### Scope Detail Page (future / stretch)

- When viewing a scope's page (e.g. `@acme`), show a "Subscribe" button if the current org is not subscribed.
- Show subscription status: "Your org is subscribed to this scope" with member count and team count.

---

## Authorization

| Action | Required Role |
|--------|--------------|
| View catalog | Org member |
| Add to catalog / subscribe | Org admin |
| Remove from catalog | Org admin |
| Install to realm (from catalog) | Realm admin or operator |

---

## Migration

Migration must be idempotent, safe to re-run, and must not disrupt running infrastructure. It runs as part of `schema_migrations.ts` on backend boot.

### Step 1 — Create Tables

```sql
CREATE TABLE IF NOT EXISTS public.org_team_catalog (
    id          SERIAL PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES public.orgs(id),
    scope       TEXT NOT NULL,
    slug        TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual',
    added_by    INTEGER,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, scope, slug)
);

CREATE TABLE IF NOT EXISTS public.org_scope_subscriptions (
    id              SERIAL PRIMARY KEY,
    org_id          INTEGER NOT NULL REFERENCES public.orgs(id),
    scope_slug      TEXT NOT NULL,
    subscribed_by   INTEGER,
    subscribed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, scope_slug)
);
```

### Step 2 — Auto-subscribe every org to `@cliq`

Every org gets a subscription to the `cliq` scope so built-in teams are available:

```sql
INSERT INTO public.org_scope_subscriptions (org_id, scope_slug, subscribed_at)
SELECT id, 'cliq', NOW()
FROM public.orgs
ON CONFLICT (org_id, scope_slug) DO NOTHING;
```

### Step 3 — Auto-subscribe every org to its own scope

Each org has a primary scope (typically matching the org slug). Self-subscription ensures all teams published by org members automatically appear in the catalog:

```sql
INSERT INTO public.org_scope_subscriptions (org_id, scope_slug, subscribed_at)
SELECT o.id, s.slug, NOW()
FROM public.orgs o
JOIN public.scopes s ON s.owner_id = o.id AND s.scope_type = 'org'
ON CONFLICT (org_id, scope_slug) DO NOTHING;
```

### Step 4 — Backfill catalog from subscribed scopes

Populate the catalog with all published teams under each org's subscribed scopes:

```sql
INSERT INTO public.org_team_catalog (org_id, scope, slug, source, added_at)
SELECT sub.org_id, t.scope, t.name, 'subscription', NOW()
FROM public.org_scope_subscriptions sub
JOIN public.teams t ON t.scope = sub.scope_slug
ON CONFLICT (org_id, scope, slug) DO NOTHING;
```

### Step 5 — Backfill catalog from existing realm team_list entries

Teams already installed on realms must appear in the catalog so they don't become orphaned:

```sql
INSERT INTO public.org_team_catalog (org_id, scope, slug, source, added_at)
SELECT DISTINCT r.org_id, entry->>'scope', entry->>'slug', 'manual', NOW()
FROM cliq.realms r,
     jsonb_array_elements(r.team_list) AS entry
WHERE r.org_id IS NOT NULL
  AND entry->>'scope' IS NOT NULL
  AND entry->>'slug' IS NOT NULL
ON CONFLICT (org_id, scope, slug) DO NOTHING;
```

### Step 6 — Backfill catalog from teams published by org members

Teams published under scopes owned by org members should be in the org's catalog even if not yet installed on any realm:

```sql
INSERT INTO public.org_team_catalog (org_id, scope, slug, source, added_at)
SELECT om.org_id, t.scope, t.name, 'manual', NOW()
FROM public.teams t
JOIN public.scopes s ON s.slug = t.scope
JOIN public.org_members om ON om.user_id = s.owner_id
WHERE s.scope_type = 'user'
ON CONFLICT (org_id, scope, slug) DO NOTHING;
```

### Step 7 — Mark `@cliq/*` entries as `builtin`

Ensure built-in teams have the correct source label:

```sql
UPDATE public.org_team_catalog
SET source = 'builtin'
WHERE scope = 'cliq' AND source != 'builtin';
```

### Verification Queries

After migration, these invariants should hold:

```sql
-- Every org has at least the @cliq subscription
SELECT o.id FROM public.orgs o
LEFT JOIN public.org_scope_subscriptions s ON s.org_id = o.id AND s.scope_slug = 'cliq'
WHERE s.id IS NULL;  -- should return 0 rows

-- No realm team_list entry is missing from its org's catalog
SELECT r.id, entry->>'scope', entry->>'slug'
FROM cliq.realms r,
     jsonb_array_elements(r.team_list) AS entry
LEFT JOIN public.org_team_catalog c
    ON c.org_id = r.org_id
    AND c.scope = entry->>'scope'
    AND c.slug = entry->>'slug'
WHERE r.org_id IS NOT NULL AND c.id IS NULL;  -- should return 0 rows
```

### Builtin Teams (ongoing)

The `@cliq/hello-world` seed path becomes:
1. `seed_all()` ensures `public.teams` row (existing).
2. On org creation: auto-subscribe to `cliq` + org's own scope → catalog entries with `source: 'builtin'` / `source: 'subscription'`.
3. On realm creation: `seed_builtin_teams` reads from catalog (not hardcoded list).

---

## Scope Subscription Sync

When a new team is published under a scope that has subscribers:

```
publish_team(@acme/new-tool)
  → query org_scope_subscriptions WHERE scope_slug = 'acme'
  → for each org: INSERT INTO org_team_catalog ... ON CONFLICT DO NOTHING
```

This can be async (outbox pattern or post-publish hook). Latency tolerance is high — minutes are fine.

---

## Billing & Metering Boundary

If per-team metering is introduced, the catalog is the natural contract boundary:
- Catalog entry = team is billable to the org.
- Removing from catalog could trigger a grace period for active realm installs.
- Subscription tiers could limit catalog size.

---

## Implementation Phases

---

### Phase 1 — Schema, Migration, Seed

**Goal**: Tables exist, all existing data is backfilled, seed path wires through catalog.

#### 1a. Sequelize Models

Create two new model files:

**`services/backend/src/db/models/org_team_catalog.ts`**

```typescript
export class OrgTeamCatalog extends Model {
    declare id: number;
    declare org_id: number;
    declare scope: string;
    declare slug: string;
    declare source: string;        // 'subscription' | 'manual' | 'builtin'
    declare added_by: number | null;
    declare added_at: Date;
}
```

**`services/backend/src/db/models/org_scope_subscription.ts`**

```typescript
export class OrgScopeSubscription extends Model {
    declare id: number;
    declare org_id: number;
    declare scope_slug: string;
    declare subscribed_by: number | null;
    declare subscribed_at: Date;
}
```

Register both in `services/backend/src/db/models/index.ts`.

#### 1b. Schema Migration

Add to `services/backend/src/core_api/db/schema_migrations.ts`:

1. `CREATE TABLE IF NOT EXISTS public.org_team_catalog` (see Migration §Step 1).
2. `CREATE TABLE IF NOT EXISTS public.org_scope_subscriptions` (see Migration §Step 1).
3. Steps 2–7 as individual idempotent SQL statements.
4. Call `backfill_org_catalogs(sq)` async function for Steps 5–6 (the JSONB + cross-join queries).

Each step wrapped in try/catch so a failure in one step doesn't block the rest. Migration is append-only — new steps at the end of the existing `run_schema_migrations()` function.

#### 1c. Seed Path Update

Modify `services/backend/src/core_api/lib/seed.ts`:

- After `seed_teams()` (which ensures `public.teams` row for `@cliq/hello-world`), call a new `seed_org_catalogs()` function.
- `seed_org_catalogs()`:
  1. For each org without a `cliq` subscription → insert subscription + catalog entries.
  2. For each org without a self-scope subscription → insert subscription.
  3. Idempotent — uses `ON CONFLICT DO NOTHING`.

Modify `services/backend/src/core_api/services/realm_team_list.service.ts`:

- `seed_builtin_teams()` changes: instead of a hardcoded `BUILTIN_TEAMS` list, query `org_team_catalog` where `source = 'builtin'` for the realm's org to determine which teams to seed. Falls back to the hardcoded list if catalog is empty (bootstrap safety).

#### 1d. Org Creation Hook

Modify `services/backend/src/services/orgs_service.ts` (or equivalent org creation flow):

- After org + default scope creation, auto-insert:
  1. `org_scope_subscriptions` row for `cliq`.
  2. `org_scope_subscriptions` row for the org's own scope slug.
  3. `org_team_catalog` entries for all `public.teams` under those scopes.
- This replaces the current implicit behavior where realms get teams but the org doesn't know about them.

#### 1e. Tests

**`services/backend/tests/unit/core_api/org_team_catalog.service.test.ts`**

| Test case | Validates |
|-----------|-----------|
| `seed_org_catalogs populates empty org` | New org gets `@cliq` subscription + hello-world in catalog |
| `seed_org_catalogs is idempotent` | Running twice produces no duplicates |
| `backfill picks up realm team_list entries` | Teams installed on realms appear in catalog |
| `backfill picks up member-published teams` | User-scope teams flow into their org |
| `builtin teams marked correctly` | `source = 'builtin'` for `@cliq/*` entries |

**Acceptance criteria**:
- `npm run build` passes.
- Backend boots cleanly with empty DB → tables created, seed runs, default org has catalog entries.
- Backend boots with existing data → backfill runs, no duplicates, all realm team_list entries accounted for.
- Verification queries (see Migration section) return 0 rows.

---

### Phase 2 — API + Enforcement

**Goal**: CRUD endpoints for catalog and subscriptions. Realm team installation validates against catalog.

#### 2a. Catalog Service

**`services/backend/src/core_api/services/org_team_catalog.service.ts`**

```typescript
export class OrgTeamCatalogService {
    /** List all catalog entries for an org. Supports optional scope filter. */
    static async get(org_id: number, opts?: { scope?: string }): Promise<OrgTeamCatalog[]>;

    /** Add a single team to the catalog. Requires org admin. Idempotent. */
    static async add(org_id: number, user_id: number, entry: { scope: string; slug: string }): Promise<OrgTeamCatalog>;

    /** Remove a team from the catalog. Requires org admin. Does NOT cascade to realms. */
    static async remove(org_id: number, user_id: number, entry: { scope: string; slug: string }): Promise<void>;

    /** Check if a team is in the org's catalog. Used by RealmTeamListService. */
    static async is_in_catalog(org_id: number, scope: string, slug: string): Promise<boolean>;

    /** List scope subscriptions for an org. */
    static async get_subscriptions(org_id: number): Promise<OrgScopeSubscription[]>;

    /** Subscribe org to a scope. Backfills all existing teams from that scope. */
    static async subscribe(org_id: number, user_id: number, scope_slug: string): Promise<OrgScopeSubscription>;

    /** Unsubscribe org from a scope. Does NOT remove already-cataloged teams. */
    static async unsubscribe(org_id: number, user_id: number, scope_slug: string): Promise<void>;

    /** Called by the publish flow when a new team is published under a scope. */
    static async on_team_published(scope_slug: string, team_slug: string): Promise<void>;
}
```

#### 2b. Controller

**`services/backend/src/core_api/controllers/org_catalog.controller.ts`**

| Method | Body | Auth | Description |
|--------|------|------|-------------|
| `get` | `{ org_id }` | member | Returns `{ ok: true, entries: [...], subscriptions: [...] }` |
| `add` | `{ org_id, scope, slug }` | admin | Adds team to catalog |
| `remove` | `{ org_id, scope, slug }` | admin | Removes team from catalog |
| `subscribe` | `{ org_id, scope_slug }` | admin | Subscribes org to scope |
| `unsubscribe` | `{ org_id, scope_slug }` | admin | Unsubscribes org from scope |

All methods validate `org_id` ownership via the auth middleware (`user.org_ids` must include `org_id`). Admin methods additionally check `my_role === 'admin'` or `role_id` is admin.

#### 2c. Routes

Add to `services/backend/src/core_api/routes.ts`:

```typescript
router.post('/org/catalog/get', auth, OrgCatalogController.get);
router.post('/org/catalog/add', auth, OrgCatalogController.add);
router.post('/org/catalog/remove', auth, OrgCatalogController.remove);
router.post('/org/subscriptions/add', auth, OrgCatalogController.subscribe);
router.post('/org/subscriptions/remove', auth, OrgCatalogController.unsubscribe);
```

#### 2d. BFF Proxy

Add to `services/bff/src/lib/control_plane_routes.ts`:

```typescript
'/v1/org/catalog/get',
'/v1/org/catalog/add',
'/v1/org/catalog/remove',
'/v1/org/subscriptions/add',
'/v1/org/subscriptions/remove',
```

#### 2e. Realm Team List Enforcement

Modify `services/backend/src/core_api/services/realm_team_list.service.ts`:

- **`add()`**: Before adding to `team_list`, call `OrgTeamCatalogService.is_in_catalog(realm.org_id, entry.scope, entry.slug)`. Throw `ApiError.bad_request('Team not in org catalog')` if false.
- **`seed_builtin_teams()`**: No enforcement needed — builtin teams are in catalog by definition (Phase 1d handles this).

#### 2f. Publish Hook

Modify `services/backend/src/services/teams_service.ts`:

- In the `publish()` method, after successful insert into `public.teams` / `public.team_versions`, call `OrgTeamCatalogService.on_team_published(scope_slug, team_slug)`.
- `on_team_published` queries `org_scope_subscriptions` for all orgs subscribed to that scope and inserts catalog entries. Fire-and-forget (wrapped in try/catch, logged on failure).

#### 2g. Teams API Filter

Modify `services/backend/src/core_api/controllers/team.controller.ts`:

- `get()` endpoint accepts new optional body field `catalog: true`.
- When `catalog: true`, resolves the caller's org (from `user.org_ids[0]`), queries `org_team_catalog` for that org, and returns only teams matching those `(scope, slug)` pairs.
- Replaces the current `mine: true` behavior for the `/teams` page.

#### 2h. Tests

**`services/backend/tests/unit/core_api/org_team_catalog.service.test.ts`** (extended from Phase 1)

| Test case | Validates |
|-----------|-----------|
| `add inserts catalog entry` | Row created with `source: 'manual'` |
| `add is idempotent` | Second call returns existing row, no error |
| `remove deletes entry` | Row removed |
| `remove is idempotent` | No error if entry doesn't exist |
| `is_in_catalog returns true for existing` | Correct boolean |
| `subscribe creates subscription + backfills` | Subscription row + N catalog entries |
| `unsubscribe removes subscription, keeps catalog` | Subscription gone, catalog entries remain |
| `on_team_published inserts for all subscribers` | New team appears in each subscribed org's catalog |
| `realm team_list add rejects non-catalog team` | `ApiError.bad_request` thrown |
| `realm team_list add allows catalog team` | Entry added successfully |

**Acceptance criteria**:
- All 6 endpoints return correct responses (200/400/403).
- `RealmTeamListService.add` rejects teams not in catalog.
- Publish flow auto-inserts into subscribed orgs' catalogs.
- `npm test` passes.

---

### Phase 3 — Frontend: Org Admin Catalog Tab

**Goal**: Org admins can view and manage their org's team catalog and scope subscriptions.

#### 3a. Org Detail Page — New Tab

Modify `src/pages/account/org_detail_page.tsx`:

- Add `{ id: 'catalog', label: 'Team Catalog' }` to `TABS` array (between `scopes` and `mesh`).
- Add a new `<Catalog_tab />` component rendered when `tab === 'catalog'`.

#### 3b. Catalog Tab Component

**New section in `org_detail_page.tsx`** (or extracted to `src/components/org_catalog_tab.tsx` if large):

**Scope Subscriptions Section** (top):

```
┌────────────────────────────────────────────────────────┐
│ Scope Subscriptions                   [+ Subscribe]    │
├────────────────────────────────────────────────────────┤
│ @cliq       12 teams   default    Sep 2026             │
│ @acme        3 teams              Sep 2026    [×]      │
└────────────────────────────────────────────────────────┘
```

- Fetch on mount: `POST /v1/org/catalog/get` with `{ org_id }`.
- "Subscribe" button opens a modal with a text input for scope slug. On submit: `POST /v1/org/subscriptions/add`.
- Default subscriptions (`@cliq`, org's own scope) show a `default` pill; "×" button hidden.
- Non-admins see the list but no "Subscribe" or "×" buttons.

**Catalog Table** (below):

```
┌──────────┬──────────────────┬─────────┬──────────────┬────────────┬──────┐
│ Scope    │ Team             │ Version │ Source       │ Added      │      │
├──────────┼──────────────────┼─────────┼──────────────┼────────────┼──────┤
│ @cliq    │ hello-world      │ 1.0.0   │ ✦ builtin   │ Sep 6      │      │
│ @acme    │ data-pipeline    │ 2.1.0   │ ⟳ subscription │ Sep 6   │ [×]  │
│ @acme    │ custom-tool      │ 1.0.0   │ ✎ manual    │ Sep 5      │ [×]  │
└──────────┴──────────────────┴─────────┴──────────────┴────────────┴──────┘
```

- Row click → navigate to `/teams/${scope}/${slug}`.
- "Add team" button (admin only) → opens a marketplace search picker that queries `POST /v1/teams/get` (no `catalog: true` filter — searching the full registry). Selecting a team calls `POST /v1/org/catalog/add`.
- "×" remove button (admin only) → confirmation dialog ("This will not uninstall the team from realms."), then `POST /v1/org/catalog/remove`.
- Search bar: client-side filter by scope or team name.
- Sort: default alphabetical by scope → slug. Clickable column headers.
- Empty state: "No teams in your org catalog. Subscribe to a scope or add teams from the marketplace."

#### 3c. Subscribe Modal

Simple modal with:
- Text input for scope slug (with `@` prefix display).
- "Subscribe" button → calls API → on success, refreshes the catalog list.
- Error handling for invalid/nonexistent scope slugs (API returns 404 or 400).

#### 3d. Tests

Manual QA checklist (frontend):
- [ ] Navigate to `/orgs/:id?tab=catalog` — tab renders.
- [ ] Subscriptions section shows default `@cliq` entry.
- [ ] "Subscribe" adds a new scope, catalog auto-populates.
- [ ] "Add team" from marketplace picker inserts into table.
- [ ] "Remove" deletes from table with confirmation.
- [ ] Non-admin user sees read-only view (no buttons).
- [ ] Row click navigates to team detail.

---

### Phase 4 — Frontend: Member Distribution

**Goal**: Non-admin org members see catalog-filtered views everywhere. Realm operators pick from catalog.

#### 4a. `/teams` Page

Modify `src/pages/account/teams_page.tsx`:

- Replace `mine: true` fetch with `POST /v1/org/catalog/get` (or `POST /v1/control/teams/get` with `catalog: true`).
- Default view: all teams in the org's catalog, grouped by scope.
- Filter bar: by scope, search by name.
- Actions: "Install to realm" (opens realm picker), link to team detail.
- Empty state: "No teams in your org catalog." with conditional link to org settings for admins: "Subscribe to scopes or add teams."

#### 4b. Realm Team List Picker

Modify `src/pages/account/realm_teams_page.tsx`:

- `Install_team_wizard` component (the "Add team to realm" modal) currently searches `public.teams`.
- Change to query `POST /v1/org/catalog/get` to populate the team picker dropdown.
- User can only add teams that are in the org catalog.

Modify `src/components/install_team_wizard.tsx`:

- Data source changes from marketplace search to catalog search.
- If catalog is empty, show message: "Your org has no teams in its catalog. Ask an admin to add teams."

#### 4c. Run-in-Realm Dialog

Modify `src/components/run_in_realm_dialog.tsx`:

- Team selector dropdown fetches from `POST /v1/org/catalog/get` instead of full marketplace.
- Ensures users can only start runs for teams the org has adopted.

#### 4d. Marketplace Browse — Catalog Badges

Modify `src/pages/teams/teams_page.tsx` (browse page) and `src/pages/teams/team_detail_page.tsx`:

- For authenticated users, fetch the org catalog on mount.
- On each team card: if team is in catalog → show "In catalog ✓" badge (green pill).
- If team is NOT in catalog and user is org admin → show "Add to org" button.
- "Add to org" button calls `POST /v1/org/catalog/add` inline, then updates badge to "In catalog ✓".

#### 4e. Realm Team List — Orphan Warnings

Modify `src/pages/account/realm_teams_page.tsx`:

- After loading realm `team_list`, also fetch org catalog.
- For each team in `team_list` that is NOT in the org catalog → show warning badge: "⚠ Not in org catalog" with tooltip: "This team was removed from the org catalog. It will continue to run but cannot be re-installed."
- Admin users get a "Add to catalog" quick-action to re-add orphaned teams.

#### 4f. Tests

Manual QA checklist:
- [ ] `/teams` page shows only catalog teams (not full marketplace).
- [ ] Realm team picker only shows catalog teams.
- [ ] Run-in-realm dialog team selector shows only catalog teams.
- [ ] Marketplace browse shows "In catalog ✓" / "Add to org" badges.
- [ ] Realm team list shows orphan warnings for non-catalog teams.
- [ ] "Add to org" from marketplace inserts and updates badge.

---

### Phase 5 — Defaults & Onboarding

**Goal**: Zero-config experience. New orgs are productive immediately. Existing onboarding surfaces updated.

#### 5a. Org Creation Defaults

Verify (should be done in Phase 1d):
- New org auto-subscribes to `@cliq` + own scope.
- Catalog auto-populated with all teams under those scopes.
- First realm's `seed_builtin_teams()` reads from catalog.

#### 5b. Getting Started Panel

Modify `src/pages/home_dashboard_page.tsx` — `Getting_started_card`:

- Add a step or status line: "Your org catalog has **N** teams ready to install."
- Link to `/orgs/:id?tab=catalog`.
- If catalog is empty (edge case): "Add teams to your org catalog to get started."

#### 5c. Empty States

Consistent empty states across all surfaces:

| Surface | Empty state (non-admin) | Empty state (admin) |
|---------|------------------------|---------------------|
| `/teams` | "No teams in your org catalog. Ask an admin to subscribe to scopes or add teams." | "No teams yet. [Subscribe to a scope] or [browse the marketplace] to add teams." |
| Realm team picker | "No teams available. Your org catalog is empty." | "No teams available. [Add teams to your org catalog] first." |
| Run-in-realm dialog | "No teams available for this realm." | "No teams available. [Add teams to your org catalog] first." |

#### 5d. Acceptance Criteria (Full Feature)

- [ ] Fresh local setup: `npm run dev:all` → create account → org has `@cliq` subscription → catalog has `hello-world` → realm has `hello-world` in team_list → daemon installs it → run succeeds.
- [ ] Existing prod deployment: migration backfills all existing orgs → no realm team_list entry is orphaned → verification queries return 0 rows.
- [ ] Org admin subscribes to `@partner` scope → all partner teams appear in catalog → realm operators can install them.
- [ ] Team published under `@acme` → all orgs subscribed to `@acme` get the new team in their catalog automatically.
- [ ] Non-admin member sees read-only catalog, can only install catalog teams to realms they admin.
- [ ] Removing a team from catalog does NOT uninstall from realms — running infrastructure is never disrupted.

---

## Future Considerations (non-blocking)

These are all deferred — none are required for the initial implementation.

- **Scope subscription filters** — e.g., "only teams tagged `production`" from a scope. Start with all-or-nothing; add granularity when needed.
- **Cross-org sharing** — Org A adding org B's private team. Already gated by `public.scopes` visibility. Revisit when multi-org collaboration is a priority.
- **Catalog size limits** — Potentially relevant for SaaS tiers. No cap initially.
- **Notification on new subscription teams** — Nice-to-have UX. Not MVP.
