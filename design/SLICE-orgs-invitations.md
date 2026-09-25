# Slice plan: Organizations plane + Invitations resource

**Program:** Hub SoT cleanup — Organizations / Invitations  
**Repos:** cliqhub (primary), documentation, cliq-platform design amend  
**Depends on:** Org roles slice (Done — `*_role` verbs + `users/update_role`)  
**Status:** Done — implemented 2026-09-21  
**Docs naming:** Mintlify / OpenAPI display name is **Organizations** (never “Orgs”). URL path prefix stays `/orgs/*` (API). New resource display name **Invitations**.

---

## O0 decisions (locked)

| ID | Decision |
|----|----------|
| **O0.1** | **Planes:** Core `/v1` = public Hub (CLI/tokens/docs). Core `/internal` = BFF/network only. BFF console keeps `/v1/orgs/*` and `/v1/invitations/*` as SPA facade → Core. One organization *model*; not dual-mount of every verb. |
| **O0.2** | **Core `/v1` Organizations (reads + list roles only):** `orgs/get`, `orgs/get_by_id`, `orgs/list_roles`, `permissions/list`. |
| **O0.3** | **Core `/internal` Organizations (writes / admin):** `orgs/new`, `update`, `delete`, `leave`, `add_member`, `remove_member`, `get_role`, `create_role`, `update_role`, `delete_role`. Assignment: `users/update_role`. Scope twins under orgs stay until Scopes cleanup (leave as-is). |
| **O0.4** | **No `orgs/get_settings`.** Org settings live on Settings. Mesh OOS. |
| **O0.5** | **Invitations = own resource.** Facade over `account_invites` + `realm_invites`. No table merge this slice. |
| **O0.6** | **Invitations = full public `/v1` resource:** `create`, `get`, `get_by_id`, `revoke`, `get_by_token`, `accept`. No `/internal/invitations/*`. `get`/`get_by_id` are membership-scoped (caller must belong to the org/realm). `create`/`revoke` require manage. Body `target_type: org \| realm`. |
| **O0.7** | **Hard cut.** Remove nested `orgs/invites/*` and `realms/invites/*`. No shims / aliases / backward compatibility. Rebuild `dist/`. |
| **O0.8** | **Drop `orgs/search_users`.** Use `users/get` with `org_id` + `query`. |
| **O0.9** | **Docs:** One **Organizations** group (fold “Org roles”). New **Invitations** group. Internal = plane, not a second product. |
| **O0.10** | **Quality gate:** All suites green. Design + code verification for redundancy, dead code, ghosts. Right > compatible. |

### Non-goals

Mesh→settings · Scopes twin deletion · Unify invite tables · Invite `role`→`role_id` · Path aliases

**Done separately:** Dashboard + Reports → BFF `/v1` + Core `/internal` only (not public Hub `/v1`).

---

## Target endpoints (summary)

**Core `/v1`:** `orgs/get`, `get_by_id`, `list_roles` · `permissions/list` · `invitations/create|get|get_by_id|revoke|get_by_token|accept`  

**Core `/internal` (+ BFF):** `orgs/new|update|delete|leave|add_member|remove_member|get_role|create_role|update_role|delete_role` · `users/update_role` · scope twins unchanged  

**Removed:** `orgs/invites/*`, `realms/invites/*`, `orgs/search_users`, `/internal/invitations/*`, docs group “Org roles”, dist ghosts  

**Tables:** no schema change (`account_invites` + `realm_invites` stay)

**BFF:** all invitations → Core `/v1`; org reads → Core `/v1`; org writes → Core `/internal`

---

## Sub-slices (detailed)

Work top-to-bottom. Each sub-slice has a concrete deliverable and exit check. Do not mark a parent slice done until all its children exit.

---

### O1 — Design lock

| Sub | Work | Files / touchpoints | Exit |
|-----|------|---------------------|------|
| **O1.1** | Keep this SLICE as SoT; fix any drift vs O0 | `cliqhub/design/SLICE-orgs-invitations.md` | Decisions match code plan |
| **O1.2** | Amend permissions design: public Organizations reads; internal writes; Invitations planes | `cliq-platform/design/api-route-permissions.md` | “Public `/v1/orgs/*` removed” gone; O0.2/O0.3/O0.6 tables present |
| **O1.3** | Docs naming rule in SLICE + permissions: display **Organizations**, paths `/orgs` | same | No “Orgs” as product title in new text |

**O1 done when:** design docs agree; no code yet (or docs-only commit OK).

---

### O2 — Organizations Core `/v1` reads + plane hygiene

| Sub | Work | Files / touchpoints | Exit |
|-----|------|---------------------|------|
| **O2.1** | Mount on Core `/v1` only: `orgs/get`, `orgs/get_by_id`, `orgs/list_roles`, `permissions/list` — **no `/internal` twins** | `backend/src/app.ts` | Routes live; smoke with curl/supertest |
| **O2.2** | Ensure role **writes** only on `/internal`: `get_role`, `create_role`, `update_role`, `delete_role` — **not** on Core `/v1` | same + any mistaken `/v1` mounts | `/v1` has no role write routes |
| **O2.3** | Delete `orgs/search_users` from Core routes, controller, service, schemas | `orgs_controller`, `orgs_service`, `orgs_schemas`, `app.ts` | No symbol / route left |
| **O2.4** | Backend tests: integration hits real `/v1` reads + `/internal` writes; remove/adjust search_users cases; assert search_users absent | `tests/integration/orgs.test.ts`, unit orgs tests | Backend orgs-related tests green |
| **O2.5** | BFF repo: `get` / `get_by_id` / `list_roles` / `permissions/list` → Core `/v1`; member/role-write/admin → `/internal` | `bff/.../orgs_repository.ts`, admin repo if needed | Unit repo tests updated |
| **O2.6** | BFF: remove `search_users` route/controller/service/repo/schema | `bff/src/app.ts`, orgs_* | No BFF search_users |
| **O2.7** | BFF tests for read/write plane + no search_users | `bff/tests/**` | BFF unit + integration green for orgs |

**O2 done when:** Organizations read plane correct; search_users gone; backend + BFF orgs tests green.

---

### O3 — Invitations on Core (new resource, hard-cut nested)

| Sub | Work | Files / touchpoints | Exit |
|-----|------|---------------------|------|
| **O3.1** | Add Zod schemas: create / get / revoke / get_by_token / accept + `target_type` | **new** `invitations_schemas.ts` | Schemas compile |
| **O3.2** | Add `InvitationsService`: lift org invite logic from `orgs_service`; lift realm invite logic from `realm.service`; branch on `target_type` | **new** `invitations_service.ts` | Unit-testable |
| **O3.3** | Add `InvitationsController` + wire container/DI if used | **new** controller; `container.ts` if applicable | Handlers exist |
| **O3.4** | Mount Core `/v1/invitations/create|get|get_by_id|revoke|get_by_token|accept` — **no** `/internal/invitations/*` | `app.ts` | Routes registered |
| **O3.5** | Remove org nested invites from routes + orgs controller/service/schemas | orgs_* , `app.ts` | Zero `orgs/invites` |
| **O3.6** | Remove realm nested invites from routes + realm controller/service | `core_api/routes.ts`, `realm.controller`, `realm.service` | Zero `realms/invites` |
| **O3.7** | Move/rewrite unit tests: invitations service/controller; strip invite tests from orgs/realm | new test files; edit old | Backend unit green |
| **O3.8** | Integration: invitations org+realm; token accept on `/v1`; old paths absent | new + edited integration | Backend integration green |

**O3 done when:** full backend `npm test` green; nested invite paths gone from Core src.

---

### O4 — BFF Invitations + allowlists

| Sub | Work | Files / touchpoints | Exit |
|-----|------|---------------------|------|
| **O4.1** | BFF schemas/repo/service/controller for invitations (or thin proxy) | **new** bff invitations_* or extend orgs→invitations | Compiles |
| **O4.2** | BFF routes: all `/v1/invitations/*` → Core `/v1/invitations/*` | `bff/src/app.ts` | Wired |
| **O4.3** | Delete BFF `orgs/invites/*` and any realm-invite special cases that duplicate | `app.ts`, orgs_*, passthrough | Hard cut |
| **O4.4** | Update `control_plane_routes.ts` allowlists | `control_plane_routes.ts` | Allowlist matches O0 |
| **O4.5** | BFF unit + integration for invitations; remove old invite tests | `bff/tests/**` | BFF `npm test` green |

**O4 done when:** BFF unit + integration green; no old invite paths in BFF src.

---

### O5 — SPA callers

| Sub | Work | Files / touchpoints | Exit |
|-----|------|---------------------|------|
| **O5.1** | Org invite accept page → `/v1/invitations/get_by_token`, `accept` | `invite_accept_page.tsx` | Compiles |
| **O5.2** | Realm invite accept page → same invitations paths + `target_type` as needed | `realm_invite_accept_page.tsx` | Compiles |
| **O5.3** | Org invite create/list/revoke callers | `org_detail_page`, `members_settings_panel`, … | New paths |
| **O5.4** | Realm invite create/list/revoke callers | `realm_detail_page`, `realm_wizard`, … | New paths |
| **O5.5** | Replace `orgs/search_users` with `users/get` `{ org_id, query }` | org detail / members typeahead | New path |
| **O5.6** | Update SPA unit mocks/tests touching invite or search URLs | `**/__tests__/**`, panels | SPA `npm test` green |

**O5 done when:** SPA `npm test` green; no `/orgs/invites` or `/realms/invites` or `orgs/search_users` in `cliqhub/src`.

---

### O6 — Documentation (display name **Organizations**)

| Sub | Work | Files / touchpoints | Exit |
|-----|------|---------------------|------|
| **O6.1** | OpenAPI: public **Organizations** tag/file for `/v1` reads + `list_roles` + `permissions/list` | `hub-orgs.yaml` (or rename from hub-org-roles); tag name `Organizations` | YAML valid |
| **O6.2** | OpenAPI: internal write verbs under Internal · Organizations (or single Organizations with plane notes) — not a second product story | `internal-orgs.yaml` | Matches O0.3 |
| **O6.3** | OpenAPI: **Invitations** public only (`create|get|get_by_id|revoke|get_by_token|accept`); drop Internal · Invitations | `hub-invitations.yaml` | Matches O0.6 |
| **O6.4** | Remove nested invite ops from Realms + old org-invite paths; remove separate **Org roles** group | `hub-realms.yaml`, `docs.json`, delete/merge `hub-org-roles.yaml` | No orphan ops |
| **O6.5** | MDX: Organizations overview (roles as section, not separate nav title “Orgs”); Invitations overview; retire/redirect org-roles-only pages | `documentation/hub-api/*.mdx` | Copy says **Organizations** |
| **O6.6** | `docs.json` nav: group title **Organizations**, **Invitations**; no “Orgs” / “Org roles” | `documentation/docs.json` | Nav correct |
| **O6.7** | Fix OpenAPI generator TAG_RULES so regen won’t recreate “Org roles” | `generate_hub_openapi.py` or equivalent | Rules match |
| **O6.8** | Push `documentation/` to origin for Mintlify | docs repo | Mintlify redeploys; local preview OK |

**O6 done when:** Mintlify shows **Organizations** + **Invitations**; no nested invite docs; no “Orgs” group title.

---

### O7 — Full verify, quality pass, ship

| Sub | Work | Exit |
|-----|------|------|
| **O7.1** | Rebuild backend `dist/` | No stale invite/role ghosts in dist |
| **O7.2** | Run backend `npm test` — fix every failure | `BACKEND_EXIT:0` |
| **O7.3** | Run BFF `npm test` — fix every failure | `BFF_UNIT_EXIT:0` |
| **O7.4** | Run BFF `npm run test:e2e` (Playwright) — fix every failure | `BFF_E2E_EXIT:0` |
| **O7.5** | Run SPA `npm test` — fix every failure | `SPA_EXIT:0` |
| **O7.6** | **Design verify:** live routes ≡ O0; SLICE ≡ permissions ≡ OpenAPI; no shims | Checklist signed in PR/commit notes |
| **O7.7** | **Code verify:** grep dead paths (`orgs/invites`, `realms/invites`, `search_users`, `org_role_controller`, `/orgs/roles/`); no redundant twin handlers; snake_case | Zero hits in src |
| **O7.8** | Commit + push product repos + documentation (when asked / per docs rule) | Remotes updated |

**O7 done when:** all exits 0 + design/code verify complete. Only then call the program done.

---

## Dependency order

```
O1 (design)
 └─ O2 (Organizations planes + drop search_users)
      └─ O3 (Core Invitations + hard-cut nested)
           └─ O4 (BFF Invitations)
                └─ O5 (SPA)
                     └─ O6 (Docs: Organizations + Invitations)
                          └─ O7 (suites + verify + ship)
```

O2 and O3 are sequential on Core (avoid breaking invite callers mid-flight). O6 can start draft OpenAPI in parallel after O3 route names freeze, but nav push waits until O5 paths are final.

---

## Test rules (every slice)

- No failing tests left behind; fix unrelated failures in suites you run.
- No skip / waive / “pre-existing.”
- Targeted runs OK while debugging; parent slice exit = full package suite for surfaces touched.
- O7 re-runs **all** changed surfaces before “done.”
