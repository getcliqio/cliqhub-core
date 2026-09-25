# RUN-S0 — RunController MVC structure

**Status:** Implemented  
**Umbrella:** [`SLICE-invent-controllers-mvc-structure.md`](./SLICE-invent-controllers-mvc-structure.md)  
**Depends on:** RUN-ORG invent — done  
**Envelope:** Flat  
**Out of scope:** `LogsController`, `TelemetryController` (TEL-S0), `RunEventStreamController`

## Goal

`RunController` → `BaseController` + `src/schemas/runs.ts` + wraps for all RunController-owned routes in `routes/v1/runs.ts`. Keep `with_dedup` on create/complete/resume/update_status.

## Endpoints (RunController only)

`get`, `get_by_id`, `create`, `complete`, `resume`, `cancel`, `supply_inputs`, `enqueue`, `claim`, `get_status`, `update_status`, `artifacts/create` — paths unchanged.

## GitNexus

| Check | Result (baseline) |
|-------|-------------------|
| `impact` RunController | LOW, 5 upstream, d=1: 2 |
| Path callers | Daemon outbox; CLI; SPA runs; BFF; platform — **highest wire risk** |

## Deliverables

1. `src/schemas/runs.ts` — all RunController inputs
2. Instance `RunController` + route wraps / dedup composition: `with_dedup(runs.wrap(runs.create))`
3. Full Core suite + BFF + platform contract proof for critical run paths

## Done when

Core + BFF unit + BFF e2e + SPA (if runs UI) + platform contract EXIT 0; pushed.
