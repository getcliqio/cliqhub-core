# DASH-S0 — DashboardController MVC structure

**Status:** Implemented (branch `slice/dashboard-mvc-structure`)  
**Umbrella:** [`SLICE-invent-controllers-mvc-structure.md`](./SLICE-invent-controllers-mvc-structure.md)  
**Depends on:** DASH-ORG invent — done  
**Envelope:** Flat

## Goal

`DashboardController` → `BaseController` + `src/schemas/dashboard/inputs.ts` + route `wrap`. Keep body `{ org_id }` and flat response fields.

## Endpoints (internal plane — not public `/v1`)

| Method | Path |
|--------|------|
| POST | `/internal/dashboard/summary` |
| POST | `/internal/dashboard/realms` |

## GitNexus

| Check | Result (baseline) |
|-------|-------------------|
| `impact` DashboardController | LOW, 5 upstream, d=1: 2 |
| Path callers | SPA home via BFF internal proxy; Core unit tests |

## Deliverables

1. `src/schemas/dashboard/inputs.ts`
2. Instance `DashboardController` + `routes/internal.ts` wraps
3. SPA/BFF tests only if handler binding changes break mocks

## Done when

Core + SPA `npm test` (+ BFF if dashboard proxied) EXIT 0; pushed.
