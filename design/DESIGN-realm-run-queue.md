# DESIGN: Realm Dispatch Queue (enqueue → offer → claim)

> **Status:** Active plan (supersedes the earlier “tiered solicitation” draft in spirit).  
> **Repos:** 2026-08-21 — simplified to broadcast + claim for exclusive jobs; fan-out existing daemon verbs for all-daemon jobs.  
> **Repos:** Implementation primarily in **cliqhub** (backend + sync) and **cliq-platform/daemon**.

## Problem

Today, run dispatch is **point-to-point**: the caller must pass a `daemon_id`, and Hub POSTs that daemon’s `public_url` (`/v1/execute`). That fights realm-first UX and dynamic fleets:

- Callers (and UI) should target a **realm**, not a machine.
- Online set changes; hard-coding `daemon_id` fails when that host is busy/offline.
- Install and similar ops already need **all online daemons** — a different coordination rule than “one winner.”

We already have **one delivery pipe**: Hub always `POST {daemon.public_url}{path}`. For firewalled daemons, `public_url` points at the sync relay (`sync_command_queue` is a **mailbox**, not a run scheduler). Heartbeats stay census-only.

## Goals

1. **Same architecture for every deployment** — only `public_url` delivery (direct or relay).
2. **Two coordination modes**, one enqueue entry:
   - **Exclusive** (runs): offer to eligible daemons → **one** claims → that daemon runs → reports via existing run mirror.
   - **Fan-out** (install / uninstall / …): POST the **existing** daemon verb to **every** online daemon — **no claim**.
3. Keep `POST /v1/dispatch/run` (with `daemon_id`) as an escape hatch for power users.
4. Defer tiered solicitation / K-sampling / park-wake sophistication until scale requires it.

## Non-goals (v1)

- Full SOLICIT → CONFIRM → ASSIGN multi-tier election engine.
- Replacing `sync_command_queue` (relay mailbox stays for NAT’d daemons).
- Desired-state / pin table for installs (re-push when offline comes back is enough for v1).
- Auto-install-on-assign for runs (v1: only daemons that already have the team, or reject).

---

## Concepts

| Concept | Meaning |
|---------|---------|
| **Delivery** | Always Hub → `POST public_url + path + body`. Sync mailbox is an implementation of some URLs. |
| **Enqueue** | Persist intent on Hub (`realm_dispatch_queue` / `realm_run_queue`). |
| **Offer** | Hub notifies candidate daemon(s) that work exists (`/v1/offer_job` for exclusive). |
| **Claim** | Daemon → Hub: “I take this exclusive item” (atomic). |
| **Fan-out** | Hub POSTs an **existing** daemon route (`/v1/install`, …) to each online member — no claim. |

```
Exclusive (run)
  Caller → POST /v1/dispatch/enqueue { kind: run, realm_id, team_id, … }
        → row status=queued
        → Hub POSTs each eligible daemon public_url /v1/offer_job
        → Winner POST /v1/dispatch/claim { queue_item_id, daemon_id }
        → Daemon starts work locally (or Hub POSTs /v1/execute only to winner — see Slice 3)
        → Daemon reports run state via existing mirror

Fan-out (install)
  Caller → POST /v1/dispatch/enqueue { kind: install, realm_id, … }
        OR keep POST /v1/dispatch/install { realm_id } (already fans out)
        → Hub POSTs each online daemon /v1/install
        → Per-daemon results; offline skipped
```

---

## Endpoints

### Hub (new)

| Method | Path | Caller | Purpose |
|--------|------|--------|---------|
| `POST` | `/v1/dispatch/enqueue` | UI / API / CI | Insert queue row; start offer or fan-out by `kind` |
| `POST` | `/v1/dispatch/claim` | Daemon | Atomic claim for exclusive items |
| `POST` | `/v1/dispatch/queue/get` | UI / API | Status / list by realm (optional in early slices) |
| `POST` | `/v1/dispatch/queue/get_by_id` | UI / API | Single item status |

**Enqueue body (flat — no `payload` bag):**

```json
{
  "kind": "run",
  "realm_id": "…",
  "team_id": "…",
  "workspace_id": "…",
  "workspace_path": "…",
  "inputs": { "claim_id": "CLM-1042" },
  "run_name": "optional",
  "execution_type": "local",
  "priority": 0
}
```

```json
{
  "kind": "install",
  "realm_id": "…",
  "team_id": "…"
}
```

> Hub may persist opaque extras in a DB column for the queue row; the **HTTP API** keeps
> first-class fields (`team_id`, `inputs`, …) — not a nested `payload` object.
**Claim body:**

```json
{
  "queue_item_id": "…",
  "daemon_id": "…"
}
```

Response: `200` claimed, or `409` already claimed.

### Hub (existing — keep)

| Path | Role |
|------|------|
| `POST /v1/dispatch/run` | Point-to-point run (`daemon_id` required) |
| `POST /v1/dispatch/install` | Fan-out install (already supports `realm_id`) — can later wrap the same enqueue/fan-out path |
| `POST /v1/dispatch/cancel`, `init`, `assemble`, … | Unchanged verbs |

### Daemon

| Path | Status | Role |
|------|--------|------|
| `POST /v1/offer_job` | **New** | Receive exclusive offer; decide claim vs ignore |
| `POST /v1/execute` | Exists | Start run when already assigned (may still be used post-claim) |
| `POST /v1/install`, `/uninstall`, `/init`, `/assemble`, `/unbind`, `/cancel` | Exist | Fan-out targets — **no new envelope** |

---

## Coordination rules

### Exclusive (`kind: run`)

1. Enqueue row: `status = queued`.
2. Eligible = online daemons in realm that have the team (v1 filter; empty → fail or park simple).
3. Hub POSTs `/v1/offer_job` to each eligible `public_url` (broadcast within eligibility; optional later: cap N).
4. Daemon if able: `POST /v1/dispatch/claim`.
5. Hub: first successful claim wins; others get `409`.
6. Winner executes; links `run_id` on the queue row; status → `running` → terminal via mirror.

### Fan-out (`kind: install` | later uninstall, …)

1. Enqueue optional audit row, or fire-and-forget like today’s install.
2. Hub POSTs **existing** `/v1/install` (etc.) to every **online** daemon in realm.
3. Collect per-daemon `{ ok, already_installed, error }`.
4. Offline = skipped (not claimed, not queued for auto-retry in v1).

**Do not** use `claim` for fan-out.

---

## Schema (v1)

### `cliq.realm_dispatch_queue`

```sql
CREATE TABLE cliq.realm_dispatch_queue (
    id              TEXT PRIMARY KEY,
    realm_id        TEXT NOT NULL REFERENCES cliq.realms(id),
    kind            TEXT NOT NULL,           -- 'run' | 'install' | …
    payload         JSONB NOT NULL DEFAULT '{}',
    priority        INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'queued',
    -- exclusive assignment
    claimed_by      TEXT,                   -- daemon_id
    claimed_at      BIGINT,
    run_id          TEXT,                   -- when kind=run and started
    -- fan-out summary (optional)
    results         JSONB,                  -- [{ daemon_id, ok, error }]
    submitted_by    TEXT NOT NULL,
    submitted_at    BIGINT NOT NULL,
    error           TEXT,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL
);

CREATE INDEX realm_dispatch_queue_realm_status_idx
    ON cliq.realm_dispatch_queue (realm_id, status, priority, created_at)
    WHERE status IN ('queued', 'offered', 'claimed', 'running');
```

Statuses (exclusive): `queued` → `offered` → `claimed` → `running` → `completed` | `failed` | `cancelled`  
Statuses (fan-out): `queued` → `dispatching` → `completed` | `partial` | `failed`

No `solicitation_log` in v1.

### Delivery note

`cliq.sync_command_queue` / `sync_command_responses` remain the **relay mailbox** when `public_url` is the sync service. They are **not** the realm work queue. Do not merge them.

---

## Daemon: `offer_job`

```json
POST /v1/offer_job
{
  "queue_item_id": "…",
  "kind": "run",
  "team_id": "…",
  "run_context": {},
  "claim_url_hint": "/v1/dispatch/claim"
}
```

Daemon checks capacity + team present → if yes, calls Hub `dispatch/claim` → on success starts run (local accept or wait for Hub `/v1/execute` — pick one in Slice 3 and stick to it).

---

## Implementation slices (with sub-slices)

**Rule:** finish each sub-slice with tests green before starting the next.  
**North-star acceptance (Slice 3d):** two daemons receive an offer; exactly one claim wins; that daemon runs (or is marked claimed + execute path); the other gets `409`.

### Slice 0 — Design lock

- [x] **0a** Freeze names: `dispatch/enqueue`, `dispatch/claim`, daemon `offer_job`
- [x] **0b** Kind matrix: run = claim; install = fan-out existing verbs
- [ ] **0c** OpenAPI stubs (with Slice 2)

**Exit:** This doc agreed.

---

### Slice 1 — Schema + QueueService (Hub) ← done

- [x] **1a** Migration `cliq.realm_dispatch_queue` + Sequelize model
- [x] **1b** `QueueService.create` / `get` / `list_for_realm`
- [x] **1c** Atomic `claim` (`UPDATE … WHERE status IN ('queued','offered') AND claimed_by IS NULL RETURNING *`)
- [x] **1d** Test: sequential claim → second fails
- [x] **1e** Test: **concurrent** claim from two daemon ids → exactly one winner (Promise.all race)

**Exit:** 1a–1e green. No HTTP yet. ✅ `tests/migrated_platform/queue.service.test.ts`

---

### Slice 2 — Hub HTTP ← done

- [x] **2a** `POST /v1/dispatch/enqueue` (user auth, realm member) — create row only
- [x] **2b** `POST /v1/dispatch/claim` (daemon-capable auth)
- [x] **2c** `POST /v1/dispatch/queue/get_by_id`
- [x] **2d** HTTP tests: enqueue → two claim calls → one 200 / one 409
- [x] **2e** `kind=install` wires existing `DispatchService.install_team({ realm_id })` + store `results`

**Exit:** API-level claim race proven without real daemons. ✅ `dispatch.enqueue.claim.http.test.ts`

---

### Slice 3 — Offer + multi-daemon pickup ★ ← done

- [x] **3a** Daemon `POST /v1/offer_job` (capacity + team check → call Hub claim)
- [x] **3b** Hub enqueue(`run`): list online eligible daemons; POST each `public_url/v1/offer_job`
- [x] **3c** After successful claim: **path B** Hub POSTs winner `/v1/execute` only (closest to today; simpler for v1)
- [x] **3d** **Acceptance:** two test/mock daemons (or HTTP stubs with public_url); enqueue once; both offered; one claims + execute; other 409 / no execute
- [x] **3e** Link `run_id` on queue row; status → `running`

**Exit:** Multi-daemon pickup works end-to-end in automated test. ✅ `multi_daemon_offer.claim.execute.test.ts`

---

### Slice 4 — Fan-out cleanup ← done

- [x] **4a** Install through enqueue results shape in UI/API
- [x] **4b** Uninstall fan-out parity (if needed)

**Exit:** `/dispatch/install` and `/dispatch/uninstall` both audit via queue (`item` + `results`). ✅ `dispatch.via_queue.test.ts`
---

### Slice 5 — Realm UI

- [ ] **5a** Realm Teams: install to online (existing/enqueue)
- [ ] **5b** Enqueue run without picking daemon
- [ ] **5c** Show queue/claim status

---

### Slice 6 — Hardening (later)

- [ ] **6a** Offer/claim TTL + sweep
- [ ] **6b** Cap offer broadcast size
- [ ] **6c** Park when zero eligible

---

## Dependency graph

```
0 ──▶ 1a→1b→1c→1d→1e
         └──▶ 2a→2b→2c→2d→2e
                └──▶ 3a→3b→3c→3d→3e   ★ multi-daemon pickup
                       ├──▶ 4…
                       └──▶ 5… → 6…
```

## Migration / compatibility

| Entry | Use |
|-------|-----|
| `POST /v1/dispatch/run` + `daemon_id` | Power user / unchanged |
| `POST /v1/dispatch/enqueue` `kind=run` | Realm-scheduled exclusive run |
| `POST /v1/dispatch/install` `{ realm_id }` | Existing fleet install (Slice 4 may unify) |
| `POST /v1/dispatch/enqueue` `kind=install` | Same fan-out via queue row audit |

Daemons without `offer_job` simply never claim; exclusive enqueue fails or stays queued until Slice 6 park/TTL.

---

## Relation to older draft

The previous long “tiered random solicitation” design (K samples, CONFIRM/ASSIGN, `solicitation_log`, park/wake engine) is **deferred** to Slice 6+ / a future revision. v1 is:

**enqueue → broadcast offer (or fan-out verb) → claim (exclusive only) → existing execute/install paths + run mirror.**
