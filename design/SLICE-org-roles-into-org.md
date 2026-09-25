# Slice plan: Org role verbs + users/update_role

**Program:** Org roles / members boundary cleanup  
**Repos:** cliqhub (primary), documentation  
**Depends on:** Existing `seed_default_roles_for_org` on create; existing delete-with-members guard in `OrgRoleService.delete`  
**Status:** Done — shipped 2026-09-19  
**Docs SoT:** [Organizations and roles](../../documentation/hub-api/orgs-and-roles.mdx)  

---

## R0 decisions (locked / amended 2026-09-19)

| ID | Decision |
|----|----------|
| R0.1 | Default roles: `owner` (system), `admin`, `operator`, `member`. Seeded on org create — **already done**. |
| R0.2 | Role **definitions** are first-class **org single-path verbs** (not a nested `/orgs/roles/*` resource, and **not** an `orgs/update` patch). |
| R0.3 | `orgs/get` / `get_by_id` may include `roles[]` (+ optional `members` with `role_id`, `available_permissions`). |
| R0.4 | **`orgs/update` = profile only** (`display_name`). No `roles` patch. No members. |
| R0.5 | Role definition verbs: `list_roles`, `get_role`, `create_role`, `update_role`, `delete_role` under `/internal/orgs/*` (BFF `/v1/orgs/*`). |
| R0.6 | **`orgs/delete_role` refused when any member still has that `role_id`** (reassign first). Also refuse delete of `is_system` / `is_default`. |
| R0.7 | **Member assignment:** `POST /internal/users/update_role` `{ user_id, org_id, role_id }`. Replaces `set_member_role`. Distinct from `orgs/update_role` (definition). |
| R0.8 | Hard cut: remove `/v1/orgs/roles/*` and `/internal/orgs/set_member_role` when SPA migrated. No shim. |
| R0.9 | Zod SoT; OpenAPI/MDX co-shipped; docs push with product. |
| R0.10 | Full suites green (backend + BFF unit/integration + Playwright + SPA) then **design verification**. |

### Naming (do not conflate)

| Path | Meaning |
|------|---------|
| `orgs/update_role` | Edit role **definition** (name / permissions) |
| `users/update_role` | Change a **member’s** assigned `role_id` |
| `orgs/update` | Org **display_name** only |

---

## Standing rules

Architecture (single-path verbs, not nested resource trees), docs co-ship + push, full suite gate, snake_case, fix every failure without stopping to ask.

---

## Goal

1. Move role CRUD from `/v1/orgs/roles/*` → `/internal/orgs/{list,get,create,update,delete}_role`.  
2. Add `users/update_role` for assignment; delete `set_member_role`.  
3. Enforce delete-blocked-when-members (already in service — keep and test).  
4. Migrate every SPA / BFF / docs caller.  
5. Suites green + design verification.

**Non-goals:** `orgs/update` roles patch (rejected); changing `DEFAULT_ROLES` vocabulary; realm roles; site-admin `users/set_role`; invite/add/remove fold.

---

## Surface inventory

### Backend Core

| Surface | Action |
|---------|--------|
| `orgs_schemas.ts` | Add schemas for list/get/create/update/delete_role; keep `orgs_update` profile-only; drop `set_member_role` |
| `users_schemas.ts` | Add `users_update_role_schema` |
| `orgs_controller` + `orgs_service` | Wire role verbs (fold or call `OrgRoleService`); enrich get with `roles[]` |
| `org_role_controller` | Delete after move |
| `org_role_service` | Keep logic; ensure delete refuses `member_count > 0` (already); expose via org routes |
| `users_controller` + service | Add `update_role` (≠ site `set_role`) |
| `app.ts` | Register `/internal/orgs/*_role` + `/internal/users/update_role`; remove old paths in R5 |
| Member repo | List returns `role_id`; assignment updates `role_id` (+ text sync if needed) |
| `api-route-permissions.md` | New verbs + users/update_role |

### BFF

| Surface | Action |
|---------|--------|
| Orgs schemas/DTO/VO/mappers/repo/controller | First-class `/v1/orgs/list_roles|get_role|create_role|update_role|delete_role` |
| Users stack | `/v1/users/update_role` → internal |
| Remove | `set_member_role`; passthrough `/v1/orgs/roles/*` |

### SPA

| Surface | Action |
|---------|--------|
| `roles_settings_panel.tsx` | `list_roles` / `create_role` / `update_role` / `delete_role`; block delete when `member_count > 0` |
| `members_settings_panel.tsx` | `users/update_role` |
| `account/org_detail_page.tsx`, `admin/org_detail_page.tsx`, `account_users_panel.tsx` | `users/update_role` |
| `lib/types.ts` | `role_id` + role summary |

### Docs / OpenAPI

| Surface | Action |
|---------|--------|
| `orgs-and-roles.mdx` | Shipped note when done |
| OpenAPI internal-orgs | Add `*_role` ops; remove set_member_role |
| OpenAPI hub-org-roles | Retire `/v1/orgs/roles/*` |
| users OpenAPI + MDX | `update_role` |
| `docs.json` / aggregates / internal-docs | Scrub old paths |

### SDK / store

**N/A** — no org-role SDK types today.

---

## Order

```
R1 inventory → R2 Core verbs + users/update_role
  → R3 BFF → R4 SPA → R5 hard-delete + OpenAPI
    → R6 suites → R7 design verification + docs push
```

---

## R1 — Inventory freeze

Grep: `orgs/roles/`, `set_member_role`, `create_role`, `OrgRole`, `to_org_set_member_role`.

| Sub | Done when |
|-----|-----------|
| R1.1 | Zero unknown callers outside inventory |
| R1.2 | Dual-column `org_members.role` vs `role_id` decision noted for R2 |

---

## R2 — Core

| Sub | Work | Tests |
|-----|------|-------|
| R2.1 | Zod for `list_roles`, `get_role`, `create_role`, `update_role`, `delete_role` (all take `org_id`; mutate verbs take `role_id` where needed) | Schema unit |
| R2.2 | Zod `users_update_role` `{ user_id, org_id, role_id }` | Schema unit |
| R2.3 | Confirm `orgs_update_schema` stays display_name-only (no roles/members) | Schema reject tests |
| R2.4 | Service: list/get/create/update/delete via OrgRoleService rules; enrich get_by_id `roles[]` + member `role_id` | Service unit |
| R2.5 | **delete_role:** 4xx when `member_count > 0`; when `is_system` / `is_default` | Explicit unit cases |
| R2.6 | `users_service.update_role`: membership + role-in-org + last-owner + `org.members.manage` | Service unit |
| R2.7 | Routes: `/internal/orgs/{list,get,create,update,delete}_role`, `/internal/users/update_role` | Integration HTTP |
| R2.8 | Dual-run: keep old `/v1/orgs/roles/*` + `set_member_role` until R4/R5 | Old tests still green |

**R2 exit:** New verbs + assignment green; delete-with-members proven.

---

## R3 — BFF

| Sub | Work | Tests |
|-----|------|-------|
| R3.1 | First-class `/v1/orgs/*_role` schemas, DTO, repo, controller | Unit + integration |
| R3.2 | `/v1/users/update_role` proxy | Unit + integration |
| R3.3 | get_by_id types include `roles` / `role_id` | Mapper tests |
| R3.4 | Keep old passthrough/set_member_role until R4 | Existing tests green |

---

## R4 — SPA

| Sub | Work |
|-----|------|
| R4.1 | Roles panel → list/create/update/delete_role; UX for delete blocked when members |
| R4.2 | Members panel → `users/update_role` |
| R4.3–R4.5 | Account/admin org detail + account users panel → `users/update_role` |
| R4.6 | Types updated; grep zero for `orgs/roles/` and `set_member_role` |

---

## R5 — Hard delete + docs

| Sub | Work |
|-----|------|
| R5.1 | Backend: remove `/v1/orgs/roles/*`, `org_role_controller` public routes, `set_member_role` |
| R5.2 | BFF: remove set_member_role + roles passthrough |
| R5.3 | OpenAPI + MDX + docs.json + internal-docs + permissions matrix |
| R5.4 | Grep: zero `set_member_role`, zero `/v1/orgs/roles/` (excl. design history) |

---

## R6 — Tests (all must pass)

### Backend unit

- Role verb schemas + orgs_service / OrgRoleService (create/update/delete + **delete blocked with members**)  
- `users` update_role (happy, wrong org role, last owner, deny)  
- permissions + migrate_org_roles still green  
- Rewrite/remove `org_role_service` tests that targeted old HTTP shapes as needed  

### Backend integration

- `/internal/orgs/*_role` CRUD  
- delete with members → error  
- `/internal/users/update_role`  
- `orgs/update` unchanged (display_name only)  

### BFF unit + integration

- Mirror Core; passthrough roles paths absent after R5  
- `/v1/users/update_role`  

### Playwright e2e

- Roles settings: create custom role; edit permissions; delete empty custom role  
- Delete blocked when members assigned (assert error / disabled)  
- Members: change role via dropdown → persists  

### SPA vitest

- Hub root vitest green  

### Suite gate

```bash
npm run test:backend
npm run test:bff
npm test
npm run test:e2e --prefix services/bff
```

All exit 0 before R7.

---

## R7 — Design verification

- [x] `orgs/update` = display_name only (no roles, no members)  
- [x] Role definitions only via `orgs/list_roles|get_role|create_role|update_role|delete_role`  
- [x] `orgs/delete_role` fails when members assigned; succeeds after reassign  
- [x] `users/update_role` is the only member-assignment write  
- [x] `/v1/orgs/roles/*` and `set_member_role` gone  
- [x] Owner/default delete rules + owner-only perms rules hold  
- [x] SPA Roles → org role verbs; Members/detail panels → `users/update_role`  
- [x] OpenAPI/MDX match Zod; docs pushed  
- [x] All suites green (backend 1614, BFF 757, SPA 379)  

**Done** when every box is checked.

---

## Amendments

| Date | Change | Why |
|------|--------|-----|
| 2026-09-19 | Target: fold definitions into `orgs/update.roles` | Early preference |
| 2026-09-19 | Member assignment = `users/update_role` | Product |
| 2026-09-19 | `orgs/update` cannot touch members | Product |
| 2026-09-19 | **Rejected** roles-on-`orgs/update`; use single-path `orgs/*_role` verbs | Product |
| 2026-09-19 | Delete role forbidden while members assigned | Product (already in Core delete) |
