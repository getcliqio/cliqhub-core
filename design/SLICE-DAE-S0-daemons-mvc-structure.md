# DAE-S0 — DaemonController MVC structure

**Status:** Ready after DASH-S0  
**Umbrella:** [`SLICE-invent-controllers-mvc-structure.md`](./SLICE-invent-controllers-mvc-structure.md)  
**Depends on:** DAE-ORG invent — done  
**Envelope:** Flat

## Goal

`DaemonController` → `BaseController` + `src/schemas/daemons.ts` + all `/v1/daemons/*` route wraps. Preserve invent `org_id` / `realm_id` bodies.

## Endpoints (unchanged set)

`list`, `get`, `register`, `heartbeat`, `deregister`, `update`, `approve`, `reject`, `rotate_secret` (exact paths as in `routes/v1/daemons.ts`).

## GitNexus

| Check | Result (baseline) |
|-------|-------------------|
| `impact` DaemonController | LOW, 5 upstream, d=1: 2 |
| Path callers | Daemon enroll/heartbeat; SPA daemons pages; BFF; platform |

## Deliverables

1. `src/schemas/daemons.ts` — one `*Input` per action
2. Instance controller + `register_daemons_routes` wraps
3. Contract-sensitive: platform enroll/register paths must stay wire-identical

## Done when

Core + BFF unit/e2e + SPA + platform contract coverage for daemons paths EXIT 0; pushed.
