# DESIGN: Relocate `/dispatch` onto real resources

> **Status:** Active — hard cut, no shims.  
> **Goal:** Delete the `/dispatch` catch-all. Verbs live on **runs**, **teams**, **daemons**, **realms/auth**.  
> **Rule:** Each slice is independently shippable: Hub + BFF + SPA (+ CLI if it calls the path) + docs OpenAPI + full test proof before “done.”

## Architecture answers (locked)

1. **Needed?** No new capabilities — relocate existing verbs. Drop public wire-JWT mint if CLI can use typed auth or Hub-internal mint only (Slice 5).
2. **Merge?** Yes — pinned `dispatch/run` + `enqueue kind=run` → one `runs/enqueue`. Install/uninstall → `teams` only (not run queue as product API).
3. **Model?** Public Hub `/v1` + BFF passthrough. Daemon mirror routes under `/runs/*` (create/complete/resume-without-phase) stay daemon→Hub; user→daemon controls are separate verbs on the same resource.
4. **Hard cut?** Yes. Each sub-slice moves callers, deletes old path in the same sub-slice. No dual-serve aliases.

## Collision note

| Path | Role | Keep? |
|------|------|--------|
| `POST /v1/runs/resume` `{ run_id }` | Daemon→Hub mirror (state) | Yes — unchanged |
| User “resume from phase” (today `dispatch/resume`) | Hub→daemon outbox | Moves to **`POST /v1/runs/resume_from_phase`** `{ run_id, from_phase }` |

---

## Target endpoint map

| Verb | New path | Auth |
|------|----------|------|
| Schedule run (realm or pin) | `POST /runs/enqueue` | User PAT (`runs`/`dispatch` write) |
| Claim exclusive queue item | `POST /runs/claim` | Realm/daemon token |
| Queue item status | `POST /runs/queue/get_by_id` | User PAT |
| Cancel | `POST /runs/cancel` | User PAT |
| Resume from phase | `POST /runs/resume_from_phase` | User PAT |
| Supply inputs | `POST /runs/supply_inputs` | User PAT |
| Force terminate | `POST /runs/force_terminate` | User PAT |
| Install team | `POST /teams/install` | User PAT |
| Uninstall team | `POST /teams/uninstall` | User PAT |
| Live installed teams | `POST /teams/get` `{ daemon_id }` | User PAT |
| Live workspaces | `POST /workspaces/get` `{ daemon_id }` | User PAT |
| Realm wire key public/rotate | `POST /auth/get_dispatch_public_key`, `/auth/rotate_dispatch_key` | User PAT (admin for rotate) |
| Wire JWT mint | `POST /auth/generate_token` `type: "daemon_wire"` **or** drop public mint | User / internal |

After Slice 6: **no** `/v1/dispatch/*` routes remain.

---

## Slice plan (testable units)

### Slice 0 — Baseline (this session’s prior hard cuts)

Already done or in tree: drop `poll` / `keys/backfill` / `verify_token` / `init` / `assemble` / `unbind`.  
**Done when:** committed + pushed on `cliqhub` + docs already on `documentation` (`1300fbb` / `7d1aeee`).

---

### Slice 1 — Run controls → `/runs` (user → daemon outbox)

**Status: DONE**

| ID | Move | Delete |
|----|------|--------|
| **1a** | `POST /runs/supply_inputs` | `/dispatch/supply_inputs` |
| **1b** | `POST /runs/cancel` | `/dispatch/cancel` |
| **1c** | `POST /runs/resume_from_phase` | `/dispatch/resume` |
| **1d** | `POST /runs/force_terminate` | `/dispatch/force_terminate` |

**Surfaces:** Hub routes + DispatchService handlers re-exported or moved to RunController; BFF passthrough; SPA (`run_detail`, daemon/workspace detail); unit/integration tests that name the old paths; OpenAPI + hub-api docs.

**Verify:** backend `npm test`; BFF `npm test` + `npm run test:e2e`; SPA `npm test`; docs regen + push.

**Browser e2e:** extend or add Playwright coverage that cancel / supply_inputs POST paths are the new `/runs/*` (or run-detail flow if already covered — assert network path).

---

### Slice 2 — Schedule run → `/runs/enqueue`

**Status: DONE**

| ID | Move | Delete |
|----|------|--------|
| **2a** | `POST /runs/enqueue` with `realm_id` | `/dispatch/enqueue` (HTTP; service kept for install) |
| **2b** | Same path with `daemon_id` + `workspace_id` | `/dispatch/run` |

---

### Slice 3 — Claim + queue → `/runs`

**Status: DONE**

| ID | Move | Delete |
|----|------|--------|
| **3a** | `POST /runs/claim` | `/dispatch/claim` |
| **3b** | `POST /runs/queue/get_by_id` | `/dispatch/queue/get_by_id` |

---

### Slice 4 — Install / uninstall → `/teams`

**Status: DONE**

| ID | Move | Delete |
|----|------|--------|
| **4a** | `POST /teams/install` `{ team_id, realm_id \| daemon_ids }` | `/dispatch/install` |
| **4b** | `POST /teams/uninstall` `{ scope, slug, realm_id \| daemon_ids }` | `/dispatch/uninstall` |
| **4c** | If `/dispatch/enqueue` still exists for install kinds only — delete enqueue entirely | `/dispatch/enqueue` |

**Surfaces:** install wizard, realm teams page, daemon install/remove; OpenAPI teams tag.

---

### Slice 5 — Live daemon inventory → `/daemons`

**Status: DONE**

| ID | Move | Delete |
|----|------|--------|
| **5a** | `POST /teams/get` `{ daemon_id }` | `/dispatch/query/teams` → `/daemons/teams/get` |
| **5b** | `POST /workspaces/get` `{ daemon_id }` | `/dispatch/query/workspaces` → `/daemons/workspaces/get` |

**Surfaces:** daemon detail, run_dialogs; not Hub catalog `/teams/get`.

---

### Slice 6 — Keys + wire mint; delete `/dispatch`

**Status: DONE**

| ID | Move | Delete |
|----|------|--------|
| **6a** | `POST /auth/get_dispatch_public_key`, `/auth/rotate_dispatch_key` | `/dispatch/keys/public`, `/dispatch/keys/rotate` |
| **6b** | Wire JWT: `POST /auth/generate_token` `type: "daemon_wire"` | `/dispatch/tokens/mint` |
| **6c** | Confirm zero `/dispatch/*` routes; remove BFF passthrough leftovers; docs “Dispatch” section → Runs/Teams/Daemons | any stragglers |

---

## Per-slice definition of done

1. Old path **gone** from `routes.ts`, BFF `control_plane_routes`, SPA fetch sites, platform inventory tests.
2. New path registered; OpenAPI regenerated; Mintlify `documentation/` updated **and pushed**.
3. Full suites exit 0 (print `EXIT:$?`):
   - `cliqhub/services/backend` → `npm test`
   - `cliqhub/services/bff` → `npm test` and `npm run test:e2e`
   - `cliqhub` → `npm test`
4. Rebuild backend `dist/` before e2e if needed.
5. Commit + push `cliqhub` (and `cliq-platform` if CLI/daemon claim URL changed).
6. Do **not** claim complete from memory — re-run in that turn.

## Out of scope

- Changing command_outbox delivery mechanics
- Renaming daemon local `/v1/execute` etc.
- Tiered solicitation / park-wake
