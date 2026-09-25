# DASH-S0 — DashboardController MVC structure

**Status:** Ready after TEL-S0  
**Umbrella:** [`SLICE-invent-controllers-mvc-structure.md`](./SLICE-invent-controllers-mvc-structure.md)  
**Depends on:** DASH-ORG invent — done  
**Envelope:** Flat

## Goal

`DashboardController` → `BaseController` + `src/schemas/dashboard.ts` + route `wrap`. Keep `POST /v1/dashboard/get` body `{ org_id }` and flat response fields.

## Endpoints

| Method | Path |
|--------|------|
| POST | `/v1/dashboard/get` |

## GitNexus

| Check | Result (baseline) |
|-------|-------------------|
| `impact` DashboardController | LOW, 5 upstream, d=1: 2 |
| Path callers | SPA dashboard; BFF proxy; Core tests |

## Deliverables

1. `src/schemas/dashboard.ts`
2. Instance `DashboardController` + `routes/v1/dashboard.ts` wrap
3. SPA/BFF tests only if handler binding changes break mocks

## Done when

Core + SPA `npm test` (+ BFF if dashboard proxied) EXIT 0; pushed.
