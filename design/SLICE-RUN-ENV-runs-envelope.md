# RUN-ENV — Runs `{ ok, data }` envelope

**Status:** Done (`slice/runs-envelope`) — 2026-09-25  
**Umbrella:** [`SLICE-invent-controllers-envelope.md`](./SLICE-invent-controllers-envelope.md)  
**Depends on:** RUN-S0 + RUN-ORG — done; TEL-ENV done  
**Hard-cut:** Largest invent wire break — outbox + SPA + claim/enqueue  

**Out of scope:** `LogsController`, `TelemetryController` (TEL-ENV), `RunEventStreamController`

## Architecture

1. **Needed?** Envelope parity for RunController-owned routes only.  
2. **Merged?** Do not merge create/complete/claim/etc.  
3. **Model?** Daemon outbox + SPA runs UI + BFF passthrough.  
4. **Hard-cut?** Yes — **endpoint-cli-contract-tests** mandatory for create/complete/claim/enqueue/cancel/status.

## Endpoints (RunController)

| Family | Before | After |
|--------|--------|-------|
| Paged list | `{ runs, total, offset, limit }` | `PagedData` / `RunPagedData` in `data` |
| List | `{ runs }` | `RunData[]` in `data` |
| One | `{ run }` | `RunData` in `data` |
| Create | `{ run_id }` | `RunCreateData` in `data` |
| Void-ish | `{ ok: true }` | `BooleanData` in `data` |
| Claim / queue item | `{ item }` | `QueueItemData` in `data` |
| Events / artifacts | `{ events }` / `{ artifacts }` / counts | `T[]` / `BooleanData` / small count DTO in `data` |

Keep `with_dedup` composition: `with_dedup(runs.wrap(runs.create))` etc.

## GitNexus / callers

| Check | Baseline |
|-------|----------|
| `impact` RunController | Graph critical — **highest real wire risk** |
| Path callers | `cliq-platform` hub_outbox / hub_run_mirror (HTTP status only); SPA runs/* via `hub_payload` / `hub_list`; BFF passthrough; Core migrated_platform + unit; docs `hub-runs.yaml` |
| Platform | No code change — outbox + claim win on HTTP 2xx/409; `unwrap_hub_body` already accepts `{ data }` |

## Deliverables

1. `schemas/runs/data.ts` — Zod `*Data` + `.describe` every field (`RunPagedData` included)  
2. JSDoc on public handlers  
3. `this.ok` + drop flat `{ runs }` / `{ run }` / `{ item }`  
4. SPA decode `data` / `data.items` in same change set  
5. OpenAPI regen + docs push (`RESPONSE_DATA_OVERRIDES` for RunController routes)  
6. Verify Core + BFF unit/e2e + SPA + platform outbox contract

## Done when

All RunController success paths use `OkResponse`; daemon outbox green; docs match Zod; EXIT 0 on every changed package.

## Verification (2026-09-25)

| Suite | Result |
|-------|--------|
| Core `npm test` | BACKEND_EXIT:0 (159 files / 1603 tests) |
| SPA `npm test` | SPA_EXIT:0 (58 / 401) |
| BFF `npm test` | BFF_UNIT_EXIT:0 (44 / 760) |
| BFF Playwright `test:e2e` (`cliqhub_e2e`) | BFF_E2E_EXIT:0 (139) — includes `runs_envelope.spec.ts` |
| Platform outbox / mirror / envelope fixtures | PLATFORM_CONTRACT_EXIT:0 (36) |
| OpenAPI regen + hub-by-tag sync | OPENAPI_EXIT:0 — `RunData` / `RunPagedData` / claim `QueueItemData` refs |
