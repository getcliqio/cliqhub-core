# TEL-ENV — Telemetry `{ ok, data }` envelope

**Status:** Done (`slice/telemetry-envelope`) — 2026-09-25  
**Umbrella:** [`SLICE-invent-controllers-envelope.md`](./SLICE-invent-controllers-envelope.md)  
**Depends on:** TEL-S0 structure + TEL-ORG invent — done  
**Hard-cut:** Core success → `{ ok: true, data: T }` only — no `{ ok, spans }` alias

## Architecture

1. **Needed?** Envelope parity only — paths unchanged.  
2. **Merged?** N/A — two existing routes.  
3. **Model?** Core envelope; BFF passthrough; SPA + daemon parse `data`.  
4. **Hard-cut?** Yes — Agents/Notifications rule.

## Endpoints

| Path | Today | After `data` |
|------|-------|--------------|
| `POST /v1/runs/report_telemetry` | `{ ok }` / `{ ok, inserted, received }` | `BooleanData` (usage) / `TelemetryReportData` (traces) |
| `POST /v1/runs/get_telemetry` | `{ ok, spans }` / flat summary / bare `{ run, phases }` | `TelemetrySpanData[]` / `TelemetrySummaryData` / `TelemetryUsageData` |

## GitNexus / callers (2026-09-25)

| Check | Result |
|-------|--------|
| `impact` TelemetryController | HIGH floor (BaseController interface) — path grep SoT |
| Path callers | Core unit tests; SPA home + run usage/spans; BFF passthrough allowlist; docs hub-runs |
| Platform | Daemon currently POSTs legacy `/v1/telemetry` (not this controller) — no platform code change this slice |

**Repos to update:** `cliqhub-core`, `cliqhub-frontend`, `cliqhub-bff` (e2e), `documentation`.

## Deliverables

1. `schemas/telemetry/data.ts` — Zod `*Data` + `.describe` every field  
2. Controller: `ApiRequest` / `ApiOkResponse`, `this.ok`, JSDoc both handlers  
3. SPA unwrap via `data` (+ flat fallback)  
4. BFF Playwright: API envelope + home browser render  
5. OpenAPI regen + push docs  
6. Verify: Core + BFF unit/e2e + SPA (+ coverage on telemetry)

## Done when

All changed-package suites EXIT 0; docs pushed; no flat telemetry success keys in Core handlers.

## Verification (2026-09-25)

| Suite | Result |
|-------|--------|
| Core `npm test` | BACKEND_EXIT:0 |
| BFF `npm test` | BFF_UNIT_EXIT:0 (760) |
| BFF Playwright `test:e2e` (cliqhub_e2e) | BFF_E2E_EXIT:0 (136) — includes `telemetry_envelope.spec.ts` API + home render |
| SPA `npm test` | SPA_EXIT:0 (401) |
| Coverage `telemetry_controller.ts` | stmts/lines **88.29%**, branches **78.94%**, funcs **100%** |
| Platform | No change — daemon uses legacy `/v1/telemetry` |
