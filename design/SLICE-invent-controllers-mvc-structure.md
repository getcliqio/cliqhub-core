# Umbrella: Invent controllers → Realms/Agents MVC structure

**Status:** Done (all five S0 structure slices pushed)  
**Depends on:** TEL/DASH/DAE/REV/RUN invent org_id hard-cuts (done on `slice/*-explicit-org-id`)  
**Out of scope:** Envelope `{ ok, data }` cut (separate `*-ENV` later, like Realms RM-ENV); HDR-1; Logs / RunEventStream (not in invent set)

## Goal

Bring the five invent-touched controllers to the **same structural pattern** as Agents / Realms / Notifications:

| Layer | Pattern |
|-------|---------|
| Controller | `extends BaseController`, instance methods, `this.ok` / `this.fail` / `assert_org_authorized` |
| Routes | `const c = new XController();` + `c.wrap(c.method)` (and `with_dedup(c.wrap(...))` where dedup already exists) |
| Schemas | `src/schemas/<resource>.ts` — Zod `*Input` with `.describe`, typed `*Data` / flat result types |
| Envelope | **Keep flat** `{ ok: true, …fields }` via `FlatApiRequest` / `FlatApiOkResponse` — **no** `{ ok, data }` in these slices |

Parity reference: `NotificationsController` + `realms_controller` (structure only; Realms still flat until RM-ENV).

## Why separate from invent

Invent slices only hard-cut body `org_id` + `assert_org_authorized`. Controllers remained `static` / untyped `req`/`res`. Structure is a **second hard-cut** so review/diff stay focused and GitNexus blast radius is per-resource.

## Slice order (smallest → largest)

| # | Slice | Controller | Paths (Core) | Core tip | GitNexus (post-S0) |
|---|-------|------------|--------------|----------|---------------------|
| 1 | **TEL-S0** | `TelemetryController` | `/v1/runs/report_telemetry`, `/v1/runs/get_telemetry` | `29c71c8` | HIGH (BaseController interface floor) — path grep SoT |
| 2 | **DASH-S0** | `DashboardController` | `/internal/dashboard/{summary,realms}` | `bbe9807` | HIGH (interface floor) — path grep SoT |
| 3 | **DAE-S0** | `DaemonController` | `/v1/daemons/*` (9) | `4ebdf3a` | LOW — 5 upstream, d=1: 2 |
| 4 | **REV-S0** | `ReviewsController` | `/v1/reviews/*` (7) | `5c42da4` | LOW — 5 upstream, d=1: 2 |
| 5 | **RUN-S0** | `RunController` | `/v1/runs/*` (excl. logs/telemetry/stream) | `9ef74f8` | LOW — 5 upstream, d=1: 2 |

**Note:** GitNexus `impact` on Express static class methods under-counts HTTP callers. **Source of truth for callers** = path string greps in `cliqhub-bff`, `cliqhub-frontend`, `cliq-platform` + Core route/controller tests. Run `impact` + `api_impact` at the start of each slice anyway; treat graph as lower-bound.

## Per-slice checklist (mandatory)

1. **GitNexus:** reindex touched repos if stale → `impact` on controller symbol → `api_impact` on controller file → path grep for every route.
2. **Core:** schemas + BaseController refactor + route wrap; unit/integration tests updated to instance handlers if needed.
3. **BFF / SPA / platform:** only if signatures or client parsing break (structure-only should be wire-compatible). Still run suites when that package’s callers exist.
4. **Verify:** Core `npm test`; BFF `npm test` + `npm run test:e2e` when BFF proxies the paths; SPA `npm test` when SPA calls them; platform contract tests when daemon/CLI hits the path.
5. **Branch / push:** one branch per slice across Hub repos that change (prefer continuing invent branch tip or `slice/<resource>-mvc-structure`).

## Non-goals

- Do not invent new endpoints.
- Do not merge create/get/list into fewer paths.
- Do not change org_id invent contracts.
- Do not wrap LogsController / RunEventStreamController in these slices.
- Do not cut `{ ok, data }` here.

## Design docs

- [`SLICE-TEL-S0-telemetry-mvc-structure.md`](./SLICE-TEL-S0-telemetry-mvc-structure.md)
- [`SLICE-DASH-S0-dashboard-mvc-structure.md`](./SLICE-DASH-S0-dashboard-mvc-structure.md)
- [`SLICE-DAE-S0-daemons-mvc-structure.md`](./SLICE-DAE-S0-daemons-mvc-structure.md)
- [`SLICE-REV-S0-reviews-mvc-structure.md`](./SLICE-REV-S0-reviews-mvc-structure.md)
- [`SLICE-RUN-S0-runs-mvc-structure.md`](./SLICE-RUN-S0-runs-mvc-structure.md)
