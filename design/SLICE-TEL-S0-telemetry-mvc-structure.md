# TEL-S0 — TelemetryController MVC structure

**Status:** Implemented (branch `slice/telemetry-mvc-structure`)  
**Umbrella:** [`SLICE-invent-controllers-mvc-structure.md`](./SLICE-invent-controllers-mvc-structure.md)  
**Depends on:** TEL-ORG invent (`org_id` on both bodies) — done  
**Envelope:** Flat — no `{ ok, data }`

## Goal

Refactor `TelemetryController` to Agents/Realms structure: `BaseController`, Zod schemas, `wrap`, typed `FlatApiRequest` / `FlatApiOkResponse`. Wire-compatible with invent contract.

## Endpoints (unchanged)

| Method | Path | Notes |
|--------|------|--------|
| POST | `/v1/runs/report_telemetry` | Optional `with_dedup` when `kind === 'usage'` |
| POST | `/v1/runs/get_telemetry` | |

## GitNexus (pre-impl)

| Check | Result (2026-05-14 reindex) |
|-------|-----------------------------|
| `impact` TelemetryController | LOW risk, 5 upstream, d=1: 2 |
| `api_impact` telemetry_controller.ts | empty (Express not modeled) |
| Path callers | Core tests; BFF/SPA if any; daemon outbox `report_telemetry` |

Re-run impact at slice start. Grep `/runs/report_telemetry` and `/runs/get_telemetry` across Hub + platform.

## Deliverables

1. `src/schemas/telemetry.ts` — `ReportTelemetryInput`, `GetTelemetryInput`, result field types
2. `TelemetryController extends BaseController` — instance methods; `assert_org_authorized` kept
3. `routes/v1/runs.ts` — `const telemetry = new TelemetryController()`; wrap (+ dedup wrap for usage)
4. Tests updated for instance handlers
5. No BFF/SPA contract change expected (flat body/response same)

## Done when

- Core `npm test` EXIT 0
- Path callers still green (platform/BFF suites if they cover these paths)
- Branch pushed with design + code
