# SLICE: Reviews explicit `org_id` + drop header tenancy (REV-ORG)

**Status:** implemented on branch `slice/reviews-explicit-org-id` — **not** merged to `main`  
**Validation note:** Zod returns **422** for missing/invalid body fields.  
**Depends on:** RUN-ORG / NTF-ORG patterns  
**Rule:** hard-cut — `POST /v1/reviews/get` does **not** invent org from `X-Org-Id` / `current_org_id`  
**No new endpoints.** Flat list envelope stays.

## Architecture answers

1. **Needed?** Yes — `ReviewsController.get` passes `req.user.current_org_id` into `list_for_user`.
2. **Merged?** No new paths.
3. **Model?**
   - **List:** body `org_id` required unless `realm_id` (realm SoT).
   - **Create:** already realm-keyed (`realm_id` → org from realm row).
   - **get_by_id / verdict / messages:** id-keyed; for get_by_id permission fallback when caller has no notification row, require body `org_id` (never invent).
4. **Hard-cut?** Yes.

### Callers

| Caller | Action |
|--------|--------|
| SPA `reviews_page` | Add `org_id: current_id` |
| SPA `use_sidebar_badges` | Add `org_id` on reviews probe |
| SPA `events_page` hug poll | Add `org_id` |
| SPA `review_detail` get_by_id | Pass `org_id: current_id` for permission path |
| Daemon create / messages | realm/id keyed — no change |

### Out of scope

- Daemons / Dashboard / Telemetry invent  
- HDR-1 global header removal  
- Envelope migration

## Checklist

### Core
- [x] `reviews_get_schema`: `org_id` UUID + refine (required without `realm_id`)
- [x] `ReviewsController.get`: `assert_org_authorized`; never `current_org_id`
- [x] `get_by_id`: optional body `org_id`; when `!has_notification` require it + permission (no header invent)
- [x] Unit `reviews_controller_org_id.test.ts`

### SPA
- [x] reviews_page, sidebar badges, events hug poll, review_detail get_by_id

### Docs + verify
- [x] OpenAPI regen; push docs branch
- [x] Core + SPA + BFF unit + BFF e2e green
