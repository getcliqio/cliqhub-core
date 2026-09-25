# RUN-ENV — Runs `{ ok, data }` envelope

**Status:** Planned  
**Umbrella:** [`SLICE-invent-controllers-envelope.md`](./SLICE-invent-controllers-envelope.md)  
**Depends on:** RUN-S0 + RUN-ORG — done; prefer TEL/DASH/DAE/REV ENV done first  
**Hard-cut:** Largest invent wire break — outbox + SPA + claim/enqueue  

**Out of scope:** `LogsController`, `TelemetryController` (TEL-ENV), `RunEventStreamController`

## Architecture

1. **Needed?** Envelope parity for RunController-owned routes only.  
2. **Merged?** Do not merge create/complete/claim/etc.  
3. **Model?** Daemon outbox + SPA runs UI + BFF passthrough.  
4. **Hard-cut?** Yes — **endpoint-cli-contract-tests** mandatory for create/complete/claim/enqueue/cancel/status.

## Endpoints (RunController)

| Family | Today | After |
|--------|-------|-------|
| Paged list | `{ runs, total, offset, limit }` | `PagedData<RunData>` |
| List | `{ runs }` | `RunData[]` |
| One | `{ run }` | `RunData` |
| Create | `{ run_id }` | `RunCreateData` or `RunData` |
| Void-ish | `{ ok: true }` | `BooleanData` |
| Claim / queue item | `{ item }` | typed DTO in `data` |
| Events / artifacts | `{ events }` / `{ artifacts }` / counts | `T[]` / `BooleanData` / small count DTO in `data` |

Keep `with_dedup` composition: `with_dedup(runs.wrap(runs.create))` etc.

## GitNexus / callers

| Check | Baseline |
|-------|----------|
| `impact` RunController | Graph LOW — **highest real wire risk** |
| Path callers | `cliq-platform` hub_outbox / hub_run_mirror; SPA runs/*; BFF `runs_logs.spec`; Core migrated_platform + unit; docs `hub-runs.yaml` |

## Deliverables

1. `schemas/runs/data.ts`; **full** `.describe` on `inputs.ts` (S0 debt — almost none today)  
2. JSDoc **every** public handler (S0 debt — ~21 missing)  
3. `this.ok` + drop `FlatApi*`  
4. Platform outbox + SPA runs decode `data` / `data.items` in **same** change set  
5. OpenAPI regen + docs push  
6. Verify Core + BFF unit/e2e + SPA + platform `test:all` + outbox contract proof

## Done when

All RunController success paths use `OkResponse`; daemon outbox green; docs match Zod; EXIT 0 on every changed package.
