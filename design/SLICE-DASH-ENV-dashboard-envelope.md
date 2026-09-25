# DASH-ENV — Dashboard `{ ok, data }` envelope

**Status:** Planned  
**Umbrella:** [`SLICE-invent-controllers-envelope.md`](./SLICE-invent-controllers-envelope.md)  
**Depends on:** DASH-S0 + DASH-ORG — done  
**Hard-cut:** `{ ok, data }` only — nest `realms`/`totals` **inside** `data`

## Architecture

1. **Needed?** Envelope parity — `/internal/dashboard/*` only.  
2. **Merged?** Keep `summary` and `realms` as two actions (do not invent a third).  
3. **Model?** Internal plane; BFF may own a thin dashboard controller or passthrough — match Core envelope; SPA home dashboard.  
4. **Hard-cut?** Yes.

## Endpoints

| Path | Today | After |
|------|-------|-------|
| `POST /internal/dashboard/summary` | flat rollup | `data: DashboardSummaryData` |
| `POST /internal/dashboard/realms` | `{ realms, totals }` at top level | `data: DashboardRealmsData` |

## GitNexus / callers

| Check | Baseline |
|-------|----------|
| `impact` DashboardController | HIGH floor — path grep SoT |
| Path callers | SPA `home_dashboard_page`; BFF `dashboard_controller` / e2e; Core unit tests; docs `internal-dashboard.yaml` |

## Deliverables

1. `schemas/dashboard/data.ts` + full `.describe` on inputs  
2. `this.ok` + JSDoc; drop `FlatApi*`  
3. SPA + BFF e2e assert `body.data`  
4. OpenAPI regen + docs push  
5. Verify Core + BFF unit/e2e + SPA

## Done when

EXIT 0 on changed surfaces; Mintlify/OpenAPI show `data` schemas for both routes.
