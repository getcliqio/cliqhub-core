# DESIGN: Heartbeat Team Sync & Unified Team Roster

> **Status:** Proposed  
> **Date:** 2026-08-23  
> **Repos:** `cliqhub` (backend, BFF, frontend), `cliq` (daemon)

## Problem

Daemon-installed teams are invisible to the Hub. The realm teams page shows nothing; run dispatch offers blindly to every online daemon regardless of team availability.

**Root cause:** The daemon's local SQLite is the source of truth for installed teams, but no mechanism pushes that data to the Hub's PostgreSQL. Three partial solutions exist today, none of them complete:

1. **Hub seed** (`seed.ts`) — pre-populates `@cliq/hello-world` and other teams with `daemon_id: null`. These "template" rows have no owning daemon and are dropped by the realm teams aggregation, which requires a `daemon_id` match against enrolled daemons.

2. **Dispatch pull** (`DispatchController._cache_teams`) — a read-through cache that queries a daemon live via `/v1/dispatch/query/teams`, then upserts results into the Hub `teams` table with the correct `daemon_id`. Works correctly, but only fires from individual daemon detail pages in the UI. The realm teams page never calls it.

3. **Heartbeat** — fires every 30 seconds from each daemon, but only sends `{ daemon_id }`. The Hub updates `last_heartbeat` and `status` — no team data is exchanged.

**Consequences:**

- Realm teams page is empty even when daemons have teams installed.
- Run election (`offer_and_dispatch_run`) blindly offers to all online daemons. Daemons without the team receive (and ignore) the offer — wasted network calls and slower claims.
- No clear error when no daemon in a realm has the required team. Runs silently time out.

---

## Goals

1. **Single source of truth flows outward.** The daemon's local team catalog is authoritative. The Hub `teams` table is a continuously-warm cache, populated by heartbeat.
2. **One write path.** A shared `DaemonTeamCacheService.sync()` handles all upserts into the Hub `teams` table — called by heartbeat and on-demand dispatch.
3. **All readers query the Hub.** Realm teams page, daemon detail page, run election, admin views — all read from the Hub `teams` table. No more divergent query paths.
4. **Smart run election.** Pre-filter daemons by team availability before offering. Fail fast with a clear error when no eligible daemon exists.
5. **No ghost rows.** Eliminate `daemon_id: null` template rows from the `teams` table. The published catalog (Browse teams) is a separate query path.

## Non-goals (v1)

- Full team version negotiation (e.g., "daemon has v1.1, run needs v1.2").
- Automatic team installation on daemons that are missing a requested team.
- Team pinning / desired-state reconciliation (re-push when offline daemon comes back).
- Changing the published team registry/catalog — that remains separate.

---

## Architecture

### Data flow

```
┌──────────────────────┐         heartbeat (30s)          ┌──────────────────────┐
│  Daemon (SQLite)     │  ──── { daemon_id, teams_hash,   │  Hub (PostgreSQL)    │
│                      │         teams: [...] }  ───────▶  │                      │
│  teams table         │                                   │  teams table         │
│  (source of truth)   │                                   │  (warm cache)        │
└──────────────────────┘                                   └──────────┬───────────┘
                                                                      │
                                                           reads ─────┤
                                                                      │
                                              ┌───────────────────────┼───────────────────────┐
                                              │                       │                       │
                                     Realm teams page       Run election (offer)      Daemon detail page
                                     /v1/control/teams/get  offer_and_dispatch_run    /v1/dispatch/query/teams
```

### Hash-based dedup

The daemon computes a SHA-256 hash of its serialized team roster. The hash is sent with every heartbeat. The Hub stores the last-seen hash per daemon. If the incoming hash matches, the upsert is skipped entirely — heartbeat stays cheap in the common (no-change) case.

On the daemon side, a dirty flag is set on `install`, `uninstall`, and `update`. If the flag is clean and the cached hash hasn't changed, the daemon skips the local team query entirely and sends only `{ daemon_id }` (backwards compatible with pre-sync Hubs).

---

## Detailed design

### Phase 1: Extract shared service

**New file:** `services/backend/src/core_api/services/daemon_team_cache.service.ts`

```typescript
interface HeartbeatTeamEntry {
    id: string;
    scope: string;         // scope slug, not scope_id
    slug: string;
    version: string | null;
    description: string | null;
    manifest: string;
    dockerfile: string | null;
    dependencies: string | null;
    created_at: number;
}

export class DaemonTeamCacheService {
    /**
     * Upsert a daemon's full team roster into the Hub teams table.
     * Prunes rows for this daemon that are absent from the incoming list.
     * Fire-and-forget safe — catches and logs all errors internally.
     */
    static async sync(daemon_id: string, teams: HeartbeatTeamEntry[]): Promise<void>;
}
```

Implementation notes:
- Batch-resolve scope slugs → `scope_id` with a single `Scope.findAll` query, keyed by slug.
- Skip entries with unresolvable scopes (log warning).
- Upsert: `findOne({ where: { daemon_id, scope_id, slug } })` → update or create.
- Prune: `Team.findAll({ where: { daemon_id } })` → destroy any row whose `id` is not in the incoming set.
- Wrap entire body in `try/catch` — never throws. Log warnings on partial failures.

### Phase 2: Hub accepts teams in heartbeat

**Schema migration** (`schema_migrations.ts`):

```sql
ALTER TABLE cliq.daemons ADD COLUMN IF NOT EXISTS teams_hash TEXT DEFAULT NULL;
```

**Controller** (`daemon.controller.ts`):

Extend `heartbeat_schema`:

```typescript
const heartbeat_team_entry = z.object({
    id: z.string(),
    scope: z.string(),
    slug: z.string(),
    version: z.string().nullable(),
    description: z.string().nullable(),
    manifest: z.string(),
    dockerfile: z.string().nullable().optional(),
    dependencies: z.string().nullable().optional(),
    created_at: z.number().optional(),
});

const heartbeat_schema = z.object({
    daemon_id: z.string(),
    teams_hash: z.string().optional(),
    teams: z.array(heartbeat_team_entry).optional(),
});
```

In `DaemonController.heartbeat`:

```
1. Validate + parse body
2. DaemonService.heartbeat(daemon_id, teams_hash) → returns { hash_changed }
3. If teams present AND hash_changed:
     void DaemonTeamCacheService.sync(daemon_id, teams).catch(log.warn)
4. Return { ok: true }
```

The sync is fire-and-forget — response returns immediately. This keeps heartbeat latency unaffected.

**Service** (`daemon.service.ts`):

```typescript
static async heartbeat(
    daemon_id: string,
    teams_hash?: string,
): Promise<{ hash_changed: boolean }> {
    const now = Date.now();
    const update_fields: Record<string, unknown> = {
        last_heartbeat: now,
        status: 'online',
    };

    let hash_changed = false;
    if (teams_hash !== undefined) {
        const current = await Daemon.findByPk(daemon_id, {
            attributes: ['teams_hash'],
        });
        hash_changed = current?.teams_hash !== teams_hash;
        if (hash_changed) {
            update_fields.teams_hash = teams_hash;
        }
    }

    const [count] = await Daemon.update(update_fields, {
        where: { id: daemon_id },
    });
    if (count === 0) {
        throw new Error(`Daemon '${daemon_id}' not found`);
    }

    return { hash_changed };
}
```

**Backwards compatibility:** Old daemons omit `teams_hash` and `teams`. The Hub treats this as a normal heartbeat — no sync triggered. No breakage.

### Phase 3: Daemon sends teams in heartbeat

**File:** `daemon/src/core/bff/client.ts`

Module-level state:

```typescript
let _last_teams_hash: string | null = null;
let _teams_dirty = true;  // start dirty to force initial sync
```

Modify `_hub_heartbeat`:

```typescript
async function _hub_heartbeat(daemon_id: string): Promise<void> {
    const base = _resolve_api_url();
    const token = await _resolve_daemon_token();
    if (!token) return;

    const payload: Record<string, unknown> = { daemon_id };

    if (_teams_dirty) {
        const roster = await _build_team_roster();
        const hash = compute_sha256(JSON.stringify(roster));

        if (hash !== _last_teams_hash) {
            payload.teams_hash = hash;
            payload.teams = roster;
            _last_teams_hash = hash;
        }
        _teams_dirty = false;
    }

    try {
        await fetch(`${base}/v1/daemons/heartbeat`, { ... });
    } catch { /* best-effort */ }

    // ... existing ACL refresh ...
}
```

Helper:

```typescript
async function _build_team_roster(): Promise<HeartbeatTeamEntry[]> {
    const repos = _repos();
    const daemon_id = get_daemon_id();
    const records = await repos.teams.list(undefined, {
        global: false,
        daemon_id,
    });
    const scopes = await repos.scopes.list();
    const scope_map = new Map(scopes.map(s => [s.id, s.slug]));

    return records.map(r => ({
        id: r.id,
        scope: scope_map.get(r.scope_id) ?? '',
        slug: r.slug,
        version: r.version,
        description: r.description,
        manifest: r.manifest,
        dockerfile: r.dockerfile,
        dependencies: r.dependencies,
        created_at: r.created_at,
    }));
}
```

**Dirty flag + immediate heartbeat** (`daemon/src/core/service/team.service.ts`):

Export a `mark_teams_dirty()` function. Call it at the end of `install`, `uninstall`, and `update`. The heartbeat loop checks the flag and only re-queries the local team list when dirty.

After marking dirty, fire an **immediate out-of-cycle heartbeat** (`void heartbeat_daemon(daemon_id)`) so the Hub sees the change within milliseconds, not up to 30 seconds later. The next scheduled heartbeat is a no-op (hash unchanged). This mirrors the run mirror pattern: push on event, periodic heartbeat as safety net.

Without this, a user installs a team and navigates to the realm teams page — and it's not there yet. The immediate heartbeat eliminates that gap.

### Phase 4: Refactor dispatch `query_teams`

**File:** `services/backend/src/core_api/controllers/dispatch.controller.ts`

- Delete `private static async _cache_teams(...)`.
- In `query_teams`, after getting the dispatch result, normalize to `HeartbeatTeamEntry[]` and call `DaemonTeamCacheService.sync(daemon_id, normalized)`.
- Same write path as heartbeat. `dispatch/query/teams` becomes a force-refresh — useful for daemon detail pages or manual "sync now" actions.

### Phase 5: Clean up seed template rows

**Migration** (`schema_migrations.ts`):

```sql
-- Remove legacy template rows with no owning daemon
DELETE FROM cliq.teams WHERE daemon_id IS NULL;

-- Drop the partial index that supported them
DROP INDEX IF EXISTS cliq.teams_scope_slug_legacy_uniq;
```

**Seed** (`seed.ts`):

Remove `seed_teams()` from the `seed_all()` pipeline. The `teams` table invariant is now: every row has a non-null `daemon_id`, populated by heartbeat sync.

The published team catalog (Browse teams / `/v1/teams/get`) is a separate table and query path — unaffected.

**Frontend** (`src/lib/realm_teams_coverage.ts`):

The filter on line 61 (`if (!daemon_id || !daemon_ids.has(daemon_id)) continue`) is now correct by design. Add a comment documenting the invariant:

```typescript
// Invariant: all teams rows have daemon_id set (heartbeat sync).
// Template/seed rows with daemon_id=null were removed in migration.
if (!daemon_id || !daemon_ids.has(daemon_id)) continue;
```

### Phase 6: Smart run election

**File:** `services/backend/src/core_api/services/dispatch.service.ts`

In `offer_and_dispatch_run`, after getting online daemon IDs:

```typescript
// Current: offer to ALL online daemons in realm
const daemon_ids = await RealmService.list_online_daemon_ids_in_realm(
    item.realm_id, input.user_id,
);

// New: filter to daemons that have the requested team installed
const { scope_id, slug } = await resolve_team_from_payload(item.payload);
const eligible_teams = await Team.findAll({
    where: {
        daemon_id: { [Op.in]: daemon_ids },
        scope_id,
        slug,
    },
    attributes: ['daemon_id'],
});
const eligible_ids = eligible_teams.map(t => t.daemon_id);

if (eligible_ids.length === 0) {
    await QueueService.set_results(item.id, {
        status: 'failed',
        error: `No online daemon in realm has team '${slug}' installed`,
    });
    return { item: await QueueService.get(item.id) };
}

const daemons = await Daemon.findAll({
    where: { id: { [Op.in]: eligible_ids }, status: 'online' },
});
```

Benefits:
- No wasted offer RPCs to daemons that can't run the team.
- Faster claims — smaller race, fewer contenders.
- Immediate, clear failure when no daemon is eligible instead of silent timeout.

---

## Rollout order

| Step | Phase | Risk | Notes |
|------|-------|------|-------|
| 1 | Phase 1 + 4 | None | Pure refactor — extract service, rewire dispatch. No behavior change. |
| 2 | Phase 2 | None | Hub accepts teams in heartbeat. Backwards compatible — old daemons omit the field. |
| 3 | Phase 3 | Low | Daemon starts sending teams. Cache warms within one heartbeat cycle (30s). |
| 4 | Phase 5 | Low | Delete `daemon_id IS NULL` rows and seed function. Only after confirming sync works. |
| 5 | Phase 6 | Medium | Smart election depends on cache being warm. Deploy after Phase 3 has been live long enough to confirm reliability. |

---

## File change summary

| File | Repo | Change |
|------|------|--------|
| `services/backend/src/core_api/services/daemon_team_cache.service.ts` | cliqhub | **New** — shared sync service |
| `services/backend/src/core_api/db/schema_migrations.ts` | cliqhub | `teams_hash` column, delete null rows, drop legacy index |
| `services/backend/src/core_api/controllers/daemon.controller.ts` | cliqhub | Extend heartbeat schema, call sync |
| `services/backend/src/core_api/services/daemon.service.ts` | cliqhub | Accept + store `teams_hash` in heartbeat |
| `services/backend/src/core_api/controllers/dispatch.controller.ts` | cliqhub | Replace `_cache_teams` with service call |
| `services/backend/src/core_api/services/dispatch.service.ts` | cliqhub | Pre-filter daemons by team in `offer_and_dispatch_run` |
| `services/backend/src/core_api/lib/seed.ts` | cliqhub | Remove `seed_teams` from pipeline |
| `daemon/src/core/bff/client.ts` | cliq | Add team roster + hash to `_hub_heartbeat` |
| `daemon/src/core/service/team.service.ts` | cliq | Dirty flag on install/uninstall/update |
| `src/lib/realm_teams_coverage.ts` | cliqhub | Add invariant comment |

---

## Testing

1. **`DaemonTeamCacheService` unit tests** — upsert new teams, update existing, prune stale, resolve scopes, skip unknown scopes.
2. **Heartbeat integration tests** — heartbeat with teams populates Hub `teams` table; same-hash heartbeat skips upsert; missing `teams` field is backwards compatible.
3. **Dispatch query_teams tests** — verify shared service is called, result shape matches.
4. **Run election tests** — only eligible daemons receive offers; zero-eligible returns clear error.
5. **Migration tests** — `daemon_id IS NULL` rows deleted, legacy index dropped, `teams_hash` column added.
6. **Dirty flag unit tests** — flag set on install/uninstall/update, cleared after heartbeat send.

---

## Decisions

1. **Heartbeat payload size.** Not a concern for v1. If it becomes one, move to a version/solicit model that provides diffs to stay in sync.
2. **Stale daemon cleanup.** Team rows follow daemon status — they persist as long as the daemon row exists. A team is "online" if its owning daemon is online. Realm-level queries already filter to online daemons, so offline daemon teams are naturally excluded. No separate team pruning needed.
3. **Agents.** The `agents` table has the same `daemon_id: null` seed pattern and will need the same treatment. Deferred to a follow-up.
