# Design: Daemon Management in CliqHub

## Problem Statement

The CliqHub UI currently shows a flat list of enrolled daemons with status and heartbeat information, but provides no way to manage them. Users cannot install teams, create workspaces, assemble teams, trigger runs, or monitor activity from the Hub UI. The daemons page is a read-only registry with a prominently placed token-minting flow that belongs in settings.

Additionally, the "offline" daemon concept adds noise — daemons that are gone should be cleaned up, not displayed indefinitely.

## Goals

1. Turn the daemons page from a passive registry into an active management console
2. Provide a daemon detail view for full visibility and control
3. Add a workspace-centric view across all daemons in a realm
4. Clean up UX: remove offline clutter, relocate token minting
5. Enable live monitoring of runs and daemon activity

## Non-Goals

- Fleet-wide aggregate operations (install on all daemons, run on all workspaces) — deferred for future design
- Agent marketplace or third-party agent management
- Multi-realm daemon sharing

---

## Architecture

### Entity Hierarchy

```
Realm
  └── Daemons (fleet members)
        ├── Installed Teams (catalog — what's available)
        └── Workspaces (projects)
              └── Assembled Teams (what's active for execution)
```

### Operation Flow

```
install team → daemon level (makes team usable)
init workspace → daemon level (registers a project)
assemble team → workspace level (binds team for execution)
run → workspace level (executes the pipeline)
```

### Communication Path

All remote operations from Hub to daemon flow through the dispatch/sync layer:

```
Hub UI → Backend dispatch API → Sync service → Daemon long-poll → Execute
```

---

## Daemon Status Model

| State | Criteria | Shown in UI? |
|-------|----------|--------------|
| **online** | Heartbeat within last 60s | Yes (green badge) |
| **stale** | Last heartbeat 60s–threshold | Yes (amber badge, "last seen Xm ago") |
| **expired** | Last heartbeat > threshold | Auto-deregistered / removed |

- **Staleness threshold**: configurable per realm, default 1 hour
- **Auto-deregister**: backend removes expired daemons on heartbeat sweep or lazy on-read
- **Clean shutdown**: daemon calls `deregister` on graceful stop (already exists)
- **Manual remove**: stale daemons can be manually removed from the UI

---

## Tier 1: Daemons List Page Redesign

**Route**: `/realms/:slug/daemons`

### Changes from Current

1. **Single table** — online + stale daemons only (no "offline" rows)
2. **Stale visual indicator** — amber badge with relative timestamp
3. **Remove action** — button on stale daemons (with confirmation dialog)
4. **Relocate token minting** — move "Enroll daemon" flow to realm settings/tokens tab
5. **Row links** — each daemon row navigates to detail page

### Table Columns

| Column | Content |
|--------|---------|
| Daemon | hostname + short ID |
| Status | online (green) / stale (amber) |
| Last heartbeat | relative time (e.g. "12s ago") |
| Workspaces | count |
| Active runs | count |
| Actions | Remove (stale only) |

---

## Tier 2: Daemon Detail Page

**Route**: `/realms/:slug/daemons/:daemon_id`

### Layout

```
┌─────────────────────────────────────────────────────┐
│ Header: hostname, status badge, enrolled since,     │
│         public URL, "Remove" danger action          │
├─────────────────────────────────────────────────────┤
│ Team Catalog                                        │
│ ┌─────────────────────────────────────────────────┐ │
│ │ @acme/deploy    v1.2    [Uninstall]             │ │
│ │ @acme/test      v2.0    [Uninstall]             │ │
│ │                                                 │ │
│ │ [Install team...]                               │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ Workspaces                                          │
│ ┌─────────────────────────────────────────────────┐ │
│ │ my-project  │ @acme/deploy │ completed 5m ago   │ │
│ │ staging     │ @acme/test   │ running            │ │
│ │                                                 │ │
│ │ [Init workspace...]                             │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ Recent Runs                                         │
│ ┌─────────────────────────────────────────────────┐ │
│ │ run-abc1  completed  @acme/deploy  my-project   │ │
│ │ run-def2  failed     @acme/test    staging      │ │
│ │ run-ghi3  running    @acme/deploy  my-project   │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Actions

| Action | Target | Dispatch Command |
|--------|--------|-----------------|
| Install team | daemon | `dispatch/install` (existing) |
| Uninstall team | daemon | `dispatch/uninstall` (new) |
| Init workspace | daemon | `dispatch/init` (new) |
| Assemble team | workspace | `dispatch/assemble` (new) |
| Unbind team | workspace | `dispatch/unbind` (new) |
| Run | workspace | `dispatch/run` (existing) |
| Cancel run | run | `dispatch/cancel` (existing) |

---

## Tier 3: Workspace View

**Route**: `/realms/:slug/workspaces`

Cross-daemon view of all workspaces in the realm.

### List Columns

| Column | Content |
|--------|---------|
| Workspace | name or path |
| Daemon | hostname (linked) |
| Teams | assembled team labels |
| Last run | state + relative time |
| Actions | Run, Assemble |

### Workspace Detail

**Route**: `/realms/:slug/workspaces/:workspace_id`

- Which daemon it belongs to (linked)
- Assembled teams with assemble/unbind actions
- Full run history
- "Run" action button

---

## Tier 4: Live Monitoring

- **Run detail page**: stream logs/events in real-time via SSE or polling
- **Auto-refresh**: run list and daemon detail auto-update without manual refresh
- **Daemon activity feed**: recent events from the daemon (phase starts, completions, errors)

---

## Backend Changes Required

### New Dispatch Commands

```
POST /v1/dispatch/init
  { daemon_id, workspace_path, workspace_name? }
  → Dispatches workspace init to target daemon

POST /v1/dispatch/assemble
  { daemon_id, workspace_id, scope, slug }
  → Dispatches team assembly to target workspace on daemon

POST /v1/dispatch/unbind
  { daemon_id, workspace_id, scope, slug }
  → Dispatches team unbind from workspace

POST /v1/dispatch/uninstall
  { daemon_id, team_id }
  → Dispatches team uninstall from daemon
```

### Auto-Deregister Logic

Add to the heartbeat sweep (or as a periodic task):

```sql
UPDATE daemons
SET status = 'deregistered'
WHERE last_heartbeat < (NOW() - staleness_threshold)
  AND status != 'deregistered';
```

The daemons list query filters: `WHERE status IN ('online', 'stale')`.

### Daemon Delete Endpoint

```
POST /v1/daemons/remove
  { daemon_id, realm_id }
  → Removes daemon from realm membership and marks deregistered
```

Already exists in routes but may need realm-scoping and cascade behavior (clean up workspace associations).

---

## Frontend Implementation Plan

### Phase 1: Daemons List Cleanup (1-2 days)

1. Remove "Enroll daemon" button from daemons page header
2. Add "Enroll daemon" option to realm settings/tokens tab
3. Filter daemons list to online + stale only (exclude offline/deregistered)
4. Add amber badge for stale daemons with relative timestamp
5. Add "Remove" button on stale daemon rows with confirmation dialog
6. Make each daemon row a link to `/realms/:slug/daemons/:daemon_id`
7. Add workspace count and active run count columns

### Phase 2: Daemon Detail Page (2-3 days)

1. Create route and page component at `/realms/:slug/daemons/:daemon_id`
2. Fetch daemon info from `GET /v1/daemons/get_by_id`
3. Fetch workspaces for this daemon from `/v1/workspaces/get` filtered by daemon_id
4. Fetch recent runs from `/v1/runs/get` filtered by daemon_id
5. Fetch installed teams (requires new endpoint or daemon query via sync)
6. Implement action dialogs:
   - "Install team" — team picker → dispatch/install
   - "Init workspace" — name/path input → dispatch/init
   - "Assemble team" — team picker scoped to installed teams → dispatch/assemble
   - "Run" — workspace + team selector → dispatch/run
   - "Cancel" — confirm → dispatch/cancel

### Phase 3: New Dispatch Endpoints (1-2 days)

1. Add `dispatch/init` endpoint to backend
2. Add `dispatch/assemble` endpoint to backend
3. Add `dispatch/unbind` endpoint to backend
4. Add `dispatch/uninstall` endpoint to backend
5. Wire into sync service command delivery
6. Add daemon-side handlers (most already exist as local operations — just need to accept sync commands)

### Phase 4: Auto-Deregister (0.5 day)

1. Add staleness threshold to realm settings (default 1 hour)
2. Add cleanup logic to heartbeat handler or periodic sweep
3. Filter deregistered daemons from list queries

### Phase 5: Workspace View (2 days)

1. Create `/realms/:slug/workspaces` list page
2. Create `/realms/:slug/workspaces/:workspace_id` detail page
3. Add nav link in realm sidebar
4. Wire up actions (assemble, unbind, run)

### Phase 6: Live Monitoring (2-3 days)

1. Add SSE or polling endpoint for run events
2. Update run detail page to stream logs
3. Add auto-refresh to daemons list and daemon detail
4. Add activity feed panel to daemon detail

---

## Migration / Rollout

- All changes are additive — no breaking changes to existing daemon or CLI behavior
- New dispatch commands are no-ops if daemon doesn't support them (graceful degradation)
- Frontend changes can ship incrementally (list cleanup first, detail page next)
- Token minting relocation should include a redirect or link from old location during transition
