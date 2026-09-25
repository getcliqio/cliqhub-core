# REV-S0 — ReviewsController MVC structure

**Status:** Implemented (branch `slice/reviews-mvc-structure`)  
**Umbrella:** [`SLICE-invent-controllers-mvc-structure.md`](./SLICE-invent-controllers-mvc-structure.md)  
**Depends on:** REV-ORG invent — done  
**Envelope:** Keep existing flat / `{ ok, data }` response shapes (no ENV cut)

## Goal

`ReviewsController` → `BaseController` + PascalCase aliases on `reviews_schemas.ts` + wraps (including `with_dedup` on create).

## Endpoints

As in `routes/v1/reviews.ts` (create/list/get/verdict/ack/messages/stream — unchanged).

## GitNexus

| Check | Result (baseline) |
|-------|-------------------|
| `impact` ReviewsController | LOW, 5 upstream, d=1: 2 |
| Path callers | SPA reviews; BFF; Core tests |

## Deliverables

1. PascalCase `Reviews*Input` aliases on existing schemas
2. Instance controller + route wraps
3. SPA reviews_page mocks stay compatible

## Done when

Core + SPA (+ BFF if proxied) EXIT 0; pushed.
