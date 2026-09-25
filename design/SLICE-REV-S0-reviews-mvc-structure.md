# REV-S0 — ReviewsController MVC structure

**Status:** Ready after DAE-S0  
**Umbrella:** [`SLICE-invent-controllers-mvc-structure.md`](./SLICE-invent-controllers-mvc-structure.md)  
**Depends on:** REV-ORG invent — done  
**Envelope:** Flat

## Goal

`ReviewsController` → `BaseController` + `src/schemas/reviews.ts` + wraps (including `with_dedup` on create).

## Endpoints

As in `routes/v1/reviews.ts` (create/list/get/pending/approve/reject/… — exact set unchanged).

## GitNexus

| Check | Result (baseline) |
|-------|-------------------|
| `impact` ReviewsController | LOW, 5 upstream, d=1: 2 |
| Path callers | SPA reviews; BFF; Core tests |

## Deliverables

1. `src/schemas/reviews.ts`
2. Instance controller + route wraps
3. SPA reviews_page mocks stay compatible with flat responses

## Done when

Core + SPA (+ BFF if proxied) EXIT 0; pushed.
