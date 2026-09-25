# REV-ENV — Reviews `{ ok, data }` envelope

**Status:** Planned  
**Umbrella:** [`SLICE-invent-controllers-envelope.md`](./SLICE-invent-controllers-envelope.md)  
**Depends on:** REV-S0 + REV-ORG — done  
**Hard-cut:** Canonical `this.ok` + Zod `data.ts` (today’s mixed `{ ok, data }` + `FlatApi*` is **not** done)

## Architecture

1. **Needed?** Finish envelope + DTO standards — paths unchanged.  
2. **Merged?** Keep review + messages actions as today; no new nested message resource.  
3. **Model?** `/v1/reviews/*`; SPA + hug/daemon consumers.  
4. **Hard-cut?** Yes — one `ReviewData` / `ReviewMessageData`; reuse `BooleanData`.

## Endpoints

Normalize every reviews route to:

- List → `data: ReviewData[]` or `PagedData<ReviewData>` if already paged  
- One → `data: ReviewData`  
- Messages → `data: ReviewMessageData[]` (prefer flat array in `data`, not `{ messages }` unless a documented composite DTO is clearer — pick **one** and document)  
- Mutations → `ReviewData` or `BooleanData`

## GitNexus / callers

| Check | Baseline |
|-------|----------|
| `impact` ReviewsController | Graph LOW — SPA + hug are SoT |
| Path callers | SPA reviews pages/chat; platform hug controller; BFF e2e; Core tests; docs `hub-reviews.yaml` |

## Deliverables

1. Move schemas to `schemas/reviews/{inputs,data}.ts` (from `reviews_schemas.ts`); `.describe` everywhere  
2. Drop `FlatApi*`; JSDoc already mostly present — keep complete  
3. SPA + platform hug decode `data`  
4. OpenAPI + docs push  
5. Verify Core + BFF + SPA + platform tests touching reviews

## Done when

No `FlatApi*` in reviews controller; OpenAPI matches Zod `*Data`; callers green.
