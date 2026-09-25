# Org-Scoped Realm Slugs

## Status: Draft (public lookup hard-cut)

> **API note (2026-09):** Public `POST /v1/realms/get_by_slug` was removed in the realm
> hard-cut. Callers resolve by `POST /v1/realms/get_by_id` with `realm_id` **or**
> `{ org_slug, slug }`. Org-scoped uniqueness (`UNIQUE(org_id, slug)`) and qualified
> slug UX below still apply; only the dedicated get_by_slug route is gone.

## Summary

Realm slugs are currently globally unique (`UNIQUE(slug)`). This prevents
multiple orgs from using natural names like `default`, `ops`, `staging`,
or `production`. Every org already gets a default realm, so `default` is
a collision waiting to happen.

This design scopes realm slugs to their owning org (`UNIQUE(org_id, slug)`)
and introduces a **qualified slug** syntax: `org.slug` (dot-separated).
Frontend URLs move to a RESTful hierarchy: `/o/:org/realms/:slug`.

---

## Motivation

1. **Default realm collision.** Every org creates a `{org_slug}.default`
   realm. Two orgs cannot both have a realm called `default` today.
2. **Natural naming.** Teams want `ops`, `staging`, `production` — not
   `measureone-ops` or `measureone.ops` as the actual slug.
3. **Org boundary enforcement.** Phases 1–3 of the org boundary work
   enforce `org_id` on realms, runs, reviews, notifications, and channels.
   Realm identity should follow the same boundary.
4. **CLI clarity.** `--realm measureone.ops` is unambiguous and
   self-documenting. `--realm ops` alone is ambiguous when a user belongs
   to multiple orgs.

---

## Qualified Slug Syntax

The **qualified slug** is `{org_slug}.{realm_slug}`:

```
measureone.ops      →  org = measureone,  realm = ops
elan.default        →  org = elan,        realm = default
acme.staging        →  org = acme,        realm = staging
```

This is unambiguous because:
- **Org slugs** use `[a-z][a-z0-9-]*` (no dots, no underscores).
- **Realm slugs** will no longer allow dots (reserved as the separator).
- Split on the **first dot** → left = org, right = realm.

---

## URL Scheme

### Before

```
/realms/:slug/...
/realms/measureone.ops/teams
/a2a/r/:slug/.well-known/agent-card.json
```

### After

```
/o/:org/realms/:slug/...
/o/measureone/realms/ops/teams
/a2a/o/:org/r/:slug/.well-known/agent-card.json
```

The `/o/:org` prefix establishes org context for the entire subtree.
Old `/realms/:slug` URLs will redirect to the new structure.

---

## CLI Default Resolution

When `cliqd` starts with no `--realm` argument:

1. **Single org membership** → use that org's `default` realm.
2. **Multiple org memberships** → error with message listing available
   orgs and qualified defaults (e.g., `elan.default`, `measureone.default`).

When `cliq login` completes, the response includes `default_realm` in
qualified form (e.g., `elan.default`). The CLI stores this and uses it
as the fallback.

### Login response changes

```jsonc
{
    "token": "...",
    "default_realm": "elan.default",       // qualified slug
    "default_realm_id": "uuid-...",         // unchanged
    "org_slugs": ["elan", "measureone"],    // all memberships
    "orgs": [                               // full org list for CLI
        { "slug": "elan", "name": "elan", "default_realm": "elan.default" },
        { "slug": "measureone", "name": "MeasureOne", "default_realm": "measureone.default" }
    ]
}
```

---

## Phase 1: Schema Migration

### 1a. Disallow dots in realm slugs

Update the slug regex from:

```
/^[a-z0-9][a-z0-9_.-]{0,62}$/
```

To:

```
/^[a-z0-9][a-z0-9_-]{0,62}$/
```

Dots are reserved for the qualified `org.slug` separator.

### 1b. Rename existing slugs that contain dots

All existing `{org_slug}.default` slugs become just `default`:

| Before                  | After     | Org        |
|-------------------------|-----------|------------|
| `measureone.default`    | `default` | measureone |
| `elan.default`          | `default` | elan       |
| `cliq.default`          | `default` | cliq       |

For any non-default slug containing a dot (e.g., `acme.staging`), strip
the org prefix if it matches the owning org; otherwise replace dots with
hyphens.

Migration SQL:

```sql
-- Rename {org_slug}.default → default
UPDATE cliq."realms" r
SET "slug" = 'default'
FROM cliq."orgs" o
WHERE r."org_id" = o."id"
  AND r."slug" = o."slug" || '.default';

-- For other dotted slugs, strip matching org prefix
UPDATE cliq."realms" r
SET "slug" = SUBSTRING(r."slug" FROM LENGTH(o."slug") + 2)
FROM cliq."orgs" o
WHERE r."org_id" = o."id"
  AND r."slug" LIKE o."slug" || '.%'
  AND r."slug" != o."slug" || '.default';
```

### 1c. Change unique constraint

```sql
-- Drop global uniqueness
ALTER TABLE cliq."realms" DROP CONSTRAINT IF EXISTS "realms_slug_key";
DROP INDEX IF EXISTS cliq."realms_slug_key";

-- Add org-scoped uniqueness (only for non-deleted realms)
CREATE UNIQUE INDEX "realms_org_id_slug_unique"
    ON cliq."realms" ("org_id", "slug")
    WHERE "deleted" = false;
```

### 1d. Update slug validation

In `realm.service.ts`:

```typescript
// Old: dots allowed
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

// New: dots reserved for org.slug separator
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
```

### 1e. Update default realm slug helpers

In `account_realm.ts`:

```typescript
// Old
account_default_realm_slug(slug) → `${slug}.default`

// New
account_default_realm_slug(_slug) → 'default'
```

In `ensure_account_default_realm` / `ensure_org_default_realm`:
- New default realm slug is just `default`
- Duplicate check scoped to `{ slug: 'default', org_id }` instead of
  global `{ slug: '{org}.default' }`

---

## Phase 2: Backend Slug Resolution

### 2a. Add `parse_qualified_slug` helper

```typescript
// lib/qualified_slug.ts
interface QualifiedSlug {
    org_slug: string;
    realm_slug: string;
}

function parse_qualified_slug(input: string): QualifiedSlug {
    const dot = input.indexOf('.');
    if (dot < 1) throw ApiError.bad_request(
        `Invalid qualified realm slug '${input}'. Expected format: org.realm`
    );
    return {
        org_slug: input.slice(0, dot),
        realm_slug: input.slice(dot + 1),
    };
}

function format_qualified_slug(org_slug: string, realm_slug: string): string {
    return `${org_slug}.${realm_slug}`;
}
```

### 2b. Update `RealmService.get_by_slug`

> **Hard-cut note (2026-09):** There is no public `POST /v1/realms/get_by_slug`.
> Callers use `POST /v1/realms/get_by_id` with `realm_id` or `{ slug, org_slug? }`.
> The service method below remains an internal lookup helper.

Current signature:

```typescript
get_by_slug(slug: string, user_id: string)
```

New signature:

```typescript
get_by_slug(slug: string, user_id: string, opts?: { org_id?: number })
```

When `org_id` is provided, query becomes:

```typescript
Realm.findOne({ where: { slug, org_id, ...ALIVE } })
```

When not provided (backward compat during migration), falls back to
global slug lookup with a deprecation warning.

### 2c. Update all slug lookup call sites

Each needs org context added:

| File | Function | How to get org_id |
|------|----------|-------------------|
| `realm.controller.ts` | `get_by_slug` | `req.user.current_org_id` |
| `daemon_enroll.service.ts` | `mint_daemon_enroll_token` | Parse `org.slug`, resolve org |
| `agent_card.service.ts` | `build_for_slug` | Parse from route params |
| `realm_a2a.service.ts` | `authorize_send` | Parse from route params |
| `realm.service.ts` | `create` duplicate check | `opts.org_id` |
| `realm.service.ts` | `ensure_account_default_realm` | Personal org id |
| `realm.service.ts` | `ensure_org_default_realm` | Org id from param |
| `migrate_personal_orgs.ts` | Slug lookups | Org id from context |

### 2d. Update `RealmService.create`

Duplicate check changes from:

```typescript
Realm.findOne({ where: { slug, ...ALIVE } })
```

To:

```typescript
Realm.findOne({ where: { slug, org_id, ...ALIVE } })
```

This allows `ops` in org A and `ops` in org B simultaneously.

---

## Phase 3: API Surface

### 3a. `POST /v1/realms/get_by_slug`

Current body: `{ slug }`

New body: `{ slug, org_slug? }` or `{ qualified_slug }`.

When `org_slug` is omitted, use `req.user.current_org_id` (from
`X-Org-Id` header). This keeps the frontend happy during migration —
the org context is already in the session.

### 3b. `POST /v1/daemons/enroll`

Current body: `{ realm_slug, ... }`

New body: `{ realm_slug, ... }` where `realm_slug` is now a qualified
slug (`org.realm`). Backend parses with `parse_qualified_slug`.

Backward compat: if `realm_slug` has no dot and `req.user` has exactly
one org, use that org. Otherwise reject with a clear error.

### 3c. A2A public routes

Current: `GET /a2a/r/:slug/...`

New: `GET /a2a/o/:org/r/:slug/...`

Old routes redirect with 301. The agent card URL embedded in responses
changes to include the org prefix.

### 3d. Login / me response

Add to `/v1/auth/login` and `/v1/auth/me` responses:

```jsonc
{
    "default_realm_qualified": "elan.default",  // org.slug format
    "orgs": [
        {
            "id": 1,
            "slug": "elan",
            "name": "elan",
            "default_realm_slug": "default",
            "default_realm_qualified": "elan.default"
        }
    ]
}
```

### 3e. Response payloads

Any API response that includes `realm_slug` should also include:
- `org_slug` — the owning org's slug
- `realm_qualified` — the `org.slug` form

This is additive (backward compatible).

---

## Phase 4: Frontend Routes + URL Generation

### 4a. Router change

```typescript
// Old
{ path: 'realms/:slug', element: <RealmLayout />, children: [...] }

// New
{ path: 'o/:org/realms/:slug', element: <RealmLayout />, children: [...] }
```

`RealmLayout` extracts both `:org` and `:slug` from params. Uses org
context to call `get_by_slug` with scoping.

### 4b. Redirects from old URLs

Add a catch-all redirect route:

```typescript
{ path: 'realms/:old_slug', element: <RealmLegacyRedirect /> }
```

`RealmLegacyRedirect`:
1. Calls `get_by_slug` (which still works with the old global slug
   during transition, or can try the current org).
2. Redirects to `/o/${org_slug}/realms/${new_slug}`.

### 4c. URL generation (~15 sites)

All `\`/realms/${slug}\`` becomes `\`/o/${org_slug}/realms/${slug}\``.

Key files:
- `home_dashboard_page.tsx` (~6 locations)
- `getting_started_panel.tsx`
- `reviews_page.tsx`, `review_detail_page.tsx`
- `realms_page.tsx`
- `realm_wizard.tsx` (post-create navigate)
- `install_to_realm_dialog.tsx`
- `realm_invite_accept_page.tsx`
- `admin/realms_page.tsx`, `admin/daemons_page.tsx`
- `realm_primary_nav.ts`

### 4d. Org context from URL

The `/o/:org` prefix in the URL provides org context without needing
`X-Org-Id` headers. `RealmLayout` can set the org switcher to match
the URL org, keeping them in sync.

### 4e. Sidebar / nav

The org switcher and realm list already filter by `current_org_id`.
No structural change — just URL generation.

---

## Phase 5: External Contracts (CLI / `cliq-platform`)

### 5a. `--realm` argument

```
cliq login --realm measureone.ops
cliq login --realm elan.default
cliq login                          # auto-resolve (see below)
```

Parsing: `parse_qualified_slug` on the `--realm` value.

### 5b. Auto-resolution (no `--realm`)

```
if user has 1 org membership:
    realm = {that_org}.default
else:
    error: "Multiple orgs found. Specify --realm org.slug"
    list available: elan.default, measureone.default, ...
```

### 5c. Stored config (`~/.cliqrc`)

```jsonc
{
    "hub": {
        "session": "...",
        "default_realm": "elan.default",
        "org": "elan"
    }
}
```

### 5d. `CLIQ_REALM` environment variable

For CI/automation:

```bash
export CLIQ_REALM=measureone.ops
cliqd  # uses measureone.ops
```

---

## Migration Strategy

### Ordering

The phases can be executed incrementally with backward compatibility
at each step:

1. **Phase 1** (schema) can land first. Renaming `{org}.default` → `default`
   is safe because no code yet queries by bare `default` without org.
   The old global unique constraint drops, but the data is still unique
   since no duplicates exist yet.

2. **Phase 2** (backend resolution) adds org-scoped lookups. During
   transition, fall back to global lookup when org context is missing.
   Log warnings for unscoped lookups to track migration progress.

3. **Phase 3** (API surface) is additive — new fields alongside existing
   ones. Old clients continue to work until deprecated.

4. **Phase 4** (frontend routes) is the visible breaking change. Ship
   with redirect routes from old URLs. Can be feature-flagged.

5. **Phase 5** (CLI) depends on Phase 3 for the API contract. Coordinate
   with `cliq-platform` release.

### No Backward Compatibility

This is a clean break. Old URLs, old API calls without org context, and
old A2A routes are removed — not redirected. Daemon tokens are unaffected
(they carry `realm_id` UUIDs, not slugs).

---

## Decisions

1. **Realm settings URL.** `/o/:org/realms/:slug/settings` — settings
   are a child of the realm.

2. **Short URLs for personal org.** No vanity shortcuts. Consistency
   over convenience.

3. **Existing bookmarks/links.** No backward compatibility redirects.
   Old `/realms/:slug` URLs break cleanly.

4. **A2A partner URLs.** No dual-serving. Old `/a2a/r/:slug/...` routes
   are removed. New routes only.
