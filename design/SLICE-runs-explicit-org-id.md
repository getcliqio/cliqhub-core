# SLICE: Runs explicit `org_id` + drop header tenancy (RUN-ORG)

**Status:** implemented on branch `slice/runs-explicit-org-id` (all Hub repos) — **not** merged to `main`  
**Validation note:** Zod returns **422** for missing/invalid body fields (Hub SoT).  
**Location:** `cliqhub-core/design/`  
**Depends on:** Realms / Agents / Notifications org-id hard-cuts  
**Rule:** hard-cut — org-scoped `POST /v1/runs/get` (recent list) does **not** invent org from `X-Org-Id` / `current_org_id`  
**No new product resources.** No route renames. Flat envelope `{ ok, runs, total, … }` stays (no RM-ENV this slice).

**GitNexus:** Express route nodes often missing — treat impact as lower-bound; complement with path-string inventory below.

| Symbol | Repo | Risk | Blast |
|--------|------|------|-------|
| `RunController.get` | core | **HIGH** | SPA home/admin/activity; realm callers already pass `realm_id` |
| `RunService.list_recent` | core | LOW | `org_id` filter already exists — stop header invent only |
| `Bands` / admin runs / `HubActivityProvider` | frontend | **HIGH** | must send body `org_id` |
| CLI `LogsCommand` → daemon `/v1/runs/get` | platform | none | **daemon-local**, not Hub |

---

## Refactoring rules (mandatory)

| Rule / SoT | What it forces |
|------------|----------------|
| **`architecture-endpoints-before-impl`** | No new run paths; no aliases; no dual header+body invent. |
| **Hard-cut** | Org-scoped recent list never invents from header. |
| **`backend-mvc-layers`** | Zod + controller change only; routes stay thin. |
| **`uuid-primary-keys`** | `org_id` is UUID on the wire. |
| **`endpoint-cli-contract-tests`** | SPA callers + BFF e2e; daemon Hub path greps clean for org invent. |
| **`verify-before-claiming-fixed`** | Full suites every changed package; print `EXIT:$?`. |
| **`docs-must-update-on-push`** | OpenAPI `hub-runs` request body + regenerate/push docs. |
| **Focused change** | Only `get` org invent. **Out:** telemetry/logs (TEL-ORG), get_by_id, create, enqueue, HDR-1. |

---

## Architecture answers

1. **Needed?** Yes — `RunController.get` → `list_recent` uses `req.user.current_org_id` today (multi-org-unsafe).
2. **Merged?** No new endpoints.
3. **Model?**
   - **Auth (who):** Bearer.
   - **Org-scoped recent list:** body `org_id` required + `assert_org_authorized`.
   - **Keyed scopes (no required `org_id`):** `realm_id` | `daemon_id` | `workspace_id` | `parent_run_id` — same as Realms mutations keyed by id.
4. **Hard-cut?** Yes — delete `org_id: req.user?.current_org_id`. No header fallback.

### Inventory (today)

| Caller | Body today | Action |
|--------|------------|--------|
| SPA home `Bands` | `{ limit, sort_* }` | **Add `org_id: current_id`** |
| SPA admin `runs_page` | `{ limit, offset, query? }` | **Add `org_id`** |
| SPA `hub_activity_context` | `{ limit: 1 }` | **Add `org_id`** |
| SPA realm runs / layout / team / detail | `realm_id` / `daemon_id` / `workspace_id` | No change |
| CLI logs → daemon | local daemon | Out of scope |
| Daemon → Hub | no Hub `/v1/runs/get` list | Out of scope |

### Explicitly out of this slice

- `/v1/runs/get_telemetry`, `get_logs` (**TEL-ORG**)
- Dashboard `/v1/dashboard/realms` (**DASH-ORG**)
- Reviews / Daemons invent
- Global `X-Org-Id` removal (**HDR-1**)
- Flat → `{ ok, data }` envelope migration

---

## Auth (locked)

```
Authorization: Bearer <token>
        ↓
┌─ org-scoped recent list (no realm_id / daemon_id / workspace_id / parent_run_id)
│     body.org_id required (UUID)
│     assert_org_authorized(auth, org_id)
│     list_recent(..., { org_id: body.org_id })
│     never invent from X-Org-Id / current_org_id
│
├─ realm_id | daemon_id → list_recent without inventing org_id
├─ workspace_id → list_by_workspace / list_active
└─ parent_run_id → list_children
```

Site hub admin (`auth.user.role === 'admin'`) may pass any `org_id` (same as Notifications).

---

## Implementation checklist

### Core

- [x] `get_schema`: optional `org_id` UUID + `superRefine` require when org-scoped path
- [x] `RunController.get`: `assert_org_authorized`; pass `filters.org_id` only — **never** `current_org_id`
- [x] Unit: `runs_controller_org_id.test.ts` (missing → 422; header alone insufficient; membership; realm_id path ok without org_id)

### SPA

- [x] `home_dashboard_page` `Bands.load_runs` — `org_id: current_id`
- [x] `admin/runs_page` — `org_id: current_id`
- [x] `hub_activity_context` — pass `org_id` on runs probe
- [x] Update SPA tests that assert `/v1/runs/get` bodies if needed

### Docs

- [x] OpenAPI `/v1/runs/get` requestBody: `org_id` + description of when required
- [x] Push `documentation/` with product change

### Verify

- [x] `cliqhub-core` `npm test` → `EXIT:0`
- [x] `cliqhub-frontend` `npm test` → `EXIT:0`
- [x] `cliqhub-bff` `npm test` → `EXIT:0`
- [x] `cliqhub-bff` `npm run test:e2e` → `EXIT:0`
- [x] Grep platform: no Hub `/v1/runs/get` list needing org_id

---

## Done when

- Org-scoped `get` refuses missing `org_id` (422) and ignores header invent.
- SPA home / admin / activity send body `org_id`.
- Realm/daemon/workspace callers unchanged and green.
- Suites green; docs pushed.
