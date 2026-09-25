# Slice plan: Users resource cleanup — profile+preferences merge, passwords internal, drop token twins

**Program:** Hub Users / Auth boundary cleanup  
**Repos:** cliqhub (primary), documentation  
**Depends on:** Act-as (BFF session `target_token`) + `/v1/auth/*` token APIs already SoT for credentials  
**Status:** implemented — R0–R8 (2026-09-19)  

---

## Standing rules (every slice — do not ask the user to rememorize)

These are **non-negotiable** for this program. Each R-slice inherits them.

### A. Architecture (`architecture-endpoints-before-impl`)

1. **No new endpoints** that duplicate auth or profile. Prefer merge / delete.  
2. **Hard cut** — no temporary aliases for dropped `/v1/users/get_tokens`, `revoke_token`, `preferences/*`, or public password routes unless an R0 row explicitly allows a dated shim. Default = **no shim**.  
3. **Public `/v1` vs `/internal`:**  
   - Identity directory + self/admin profile = `/v1/users/*`  
   - Password mutations = `/internal/users/*` only (BFF calls Core with internal auth)  
   - Token lifecycle = `/v1/auth/*` only (self-serve; admin uses **act-as**)  
4. Before coding a sub-slice: confirm the endpoint is still required by the locked matrix below.

### B. Docs (`docs-must-update-on-push`)

Same session / same PR as any contract change:

1. Hub Zod (`users_schemas.ts`) — SoT for request/response shapes.  
2. Regenerate OpenAPI (`documentation/scripts/generate_hub_openapi.py` + by-tag).  
3. Update `hub-api` MDX / nav; remove dead paths.  
4. **Commit + push** `documentation` to `origin/main` — do not leave docs local.

### C. Verify (`verify-before-claiming-fixed`)

When claiming a slice **Done** after UI + BFF + backend changes:

```bash
cd cliqhub/services/backend && npm test; echo "BACKEND_EXIT:$?"
cd cliqhub/services/bff && npm test; echo "BFF_UNIT_EXIT:$?"
cd cliqhub/services/bff && npm run test:e2e; echo "BFF_E2E_EXIT:$?"
cd cliqhub && npm test; echo "SPA_EXIT:$?"
```

- **All** of the above exit **0**. No subset. No “e2e later.”  
- Fix **every** failure in those suites (including unrelated).  
- Rebuild `services/backend/dist` when Hub ships compiled output.  
- Do **not** stop mid-fix to ask whether to continue — keep fixing until green.

### D. Code conventions

- New functions/variables: **snake_case**.  
- Prefer consolidating callers in the same slice that deletes a route (no orphan SPA/BFF paths).  
- Update route inventory / allowlist tests in the same slice as route deletes.

---

## R0 decisions (locked 2026-09-19)

| ID | Decision |
|----|----------|
| R0.1 | **Events ≠ preferences.** Notification/event **rows** come from notifications APIs. `users.preferences` is only a JSON bag (today: `event_alerts` toggles + seen timestamps for the Events UI). |
| R0.2 | **Drop** public `POST /v1/users/get_tokens` and `POST /v1/users/revoke_token`. Token SoT = `/v1/auth/*`. |
| R0.3 | **Drop** Admin Tokens page (global all-users token list). Silly. Per-user token work = **act-as** then Account/realm Tokens UI (`/v1/auth/*`). |
| R0.4 | **Merge** `preferences/update` into `POST /v1/users/update` (optional `preferences` patch object, shallow-merge top-level keys). |
| R0.5 | **Drop** `POST /v1/users/preferences/get` and `POST /v1/users/preferences/update`. |
| R0.6 | `POST /v1/users/get_by_id` gains optional `include_preferences: boolean` (default **false**). When true, response includes `preferences`. |
| R0.7 | Session / Events that need prefs: call `get_by_id` with `include_preferences: true` **or** receive prefs on `users/update` response / session refresh path — **no** standalone preferences resource. |
| R0.8 | **Move** `change_password` and `reset_password` to **`/internal/users/*` only**. Remove public `/v1/users/change_password` and `/v1/users/reset_password`. (`/internal/users/reset_password` already exists — remove the public twin.) |
| R0.9 | BFF may keep **SPA-facing** session routes (e.g. `POST /v1/users/change_password` on BFF) that **proxy to Core `/internal/...`**. Core must not expose password mutations on public `/v1`. |
| R0.10 | Zod is SoT; OpenAPI/MDX co-shipped every contract slice. |
| R0.11 | **No shim** for deleted token/preferences/public-password Core routes. |
| R0.12 | Auth resource unchanged for generate/get/revoke/rotate/validate. Do not add admin `user_id` filter to auth — act-as covers admin needs. |

---

## Goal

1. **Users** = people directory + profile (display/email/…) + optional preferences bag on read/write.  
2. **Auth** = credential tokens (self-serve; admin via act-as).  
3. **Passwords** = BFF → Core `/internal` only.  
4. Delete dead Admin Tokens UI and Core token twins under `/v1/users`.  
5. Docs + tests green end-to-end (all suites).

Non-goals: redesign of act-as; changing notifications schema; renaming `event_alerts` keys; publishing new npm packages.

---

## Current vs target

| Concern | Today | Target |
|---------|--------|--------|
| Self tokens | `/v1/auth/*` + SPA Account Tokens | unchanged |
| Admin all-tokens list | `/v1/users/get_tokens` + Admin Tokens page | **gone** |
| Admin revoke any token | `/v1/users/revoke_token` | **gone** (act-as + auth revoke) |
| Preferences get/update | `/v1/users/preferences/*` | **folded** into `update` + `get_by_id?include_preferences` |
| Profile update | `/v1/users/update` (+ BFF `update_profile`) | one Core `update` (prefs optional) |
| Change password | public `/v1/users/change_password` | `/internal/users/change_password` |
| Reset password | public `/v1` **and** `/internal` | `/internal` only |
| Event alert toggles | prefs `event_alerts` via preferences/update | same bag via `users/update` |

---

## Endpoint matrix (every surface)

### Core Hub — public `/v1/users`

| Endpoint | R-slice | Action |
|----------|---------|--------|
| `POST /v1/users/get` | keep | Directory (admin / org) |
| `POST /v1/users/get_by_id` | **R2** | + `include_preferences?` |
| `POST /v1/users/update` | **R2** | Profile fields ± `preferences` patch |
| ~~`preferences/get`~~ | **R5** delete | — |
| ~~`preferences/update`~~ | **R5** delete | — |
| ~~`get_tokens`~~ | **R3** delete | — |
| ~~`revoke_token`~~ | **R3** delete | — |
| ~~`change_password`~~ | **R4** delete public | — |
| ~~`reset_password`~~ | **R4** delete public | — |

### Core Hub — `/internal/users`

| Endpoint | R-slice | Action |
|----------|---------|--------|
| `new` / `delete` / `suspend` / `unsuspend` / `set_role` | keep | Already internal |
| `reset_password` | **R4** | Keep; sole Core path |
| `change_password` | **R4** | **Add** internal; BFF account uses it |

### Core Hub — `/v1/auth` (unchanged)

| Endpoint | Notes |
|----------|-------|
| `generate_token` / `get_tokens` / `revoke_token` / `rotate_token` / `validate_token` | Self-serve SoT; act-as ⇒ target user’s tokens |

### BFF (SPA-facing)

| BFF route | R-slice | Notes |
|-----------|---------|-------|
| Account Tokens → `/v1/auth/*` | keep | Already correct |
| `POST /v1/users/update_profile` | **R2** | Proxy to Core `users/update` (may include prefs later) |
| `POST /v1/users/preferences/*` | **R5** | Remove; Events → `users/update` |
| `POST /v1/users/change_password` | **R4** | Keep BFF path; Core = `/internal/users/change_password` |
| `POST /v1/users/reset_password` | **R4** | Admin; Core = `/internal/users/reset_password` |
| `POST /v1/users/get_tokens` / `revoke_token` | **R3** | Remove from BFF admin |
| Admin Tokens page + router | **R3** | Delete |

---

## Zod sketch (lock in R0 / implement R2)

```ts
// POST /v1/users/get_by_id
users_get_by_id_schema = z.object({
  user_id: z.number().int().positive(),
  include_preferences: z.boolean().optional().default(false),
});

// POST /v1/users/update  — profile and/or preferences
users_update_schema = z.object({
  user_id: z.number().int().positive().optional(), // admin updating another; omit = self
  display_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  // …existing profile fields only — do not invent new ones
  /**
   * Shallow-merge into users.preferences JSONB.
   * Example Events bag: { event_alerts: { hug, my_runs, all, *_seen_at } }
   */
  preferences: z.record(z.string(), z.unknown()).optional(),
});

// POST /internal/users/change_password
users_change_password_schema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(/* existing min */),
});

// POST /internal/users/reset_password  (admin / BFF)
users_reset_password_schema = z.object({
  user_id: z.number().int().positive(),
  new_password: z.string().min(/* existing min */),
});
```

**Semantics**

| Call | Effect |
|------|--------|
| `update` profile fields only | Today’s profile update |
| `update` + `preferences` | Shallow-merge prefs (replaces preferences/update) |
| `update` both | One request |
| `get_by_id` without flag | No `preferences` key (or empty omit) |
| `get_by_id` + `include_preferences: true` | Include full prefs object |

---

## R0 — Design lock

- [ ] Confirm R0.1–R0.12 with stakeholder (this doc).  
- [ ] No code.

**Exit R0:** decisions recorded; proceed to R1.

---

## R1 — Inventory + caller map (no product behavior change)

| ID | Work | Surfaces | Testable outcome |
|----|------|----------|------------------|
| R1.1 | `rg` all callers of `users/get_tokens`, `users/revoke_token`, `preferences/*`, public password paths | Hub + BFF + SPA + docs | Checklist table in this doc or PR |
| R1.2 | Confirm Admin Tokens route + nav links | SPA | List files to delete in R3 |
| R1.3 | Confirm Events only uses `event_alerts` prefs | SPA | Document keys |
| R1.4 | Confirm BFF admin reset uses public vs internal | BFF | Note for R4 |

**Exit R1:** inventory complete; zero route deletes yet.

---

## R2 — Merge preferences into `update` + `get_by_id`

| ID | Work | Surfaces | Rules |
|----|------|----------|-------|
| R2.1 | Zod: extend `users_update_schema` with optional `preferences`; extend `get_by_id` with `include_preferences` | Hub schemas | A, D |
| R2.2 | Service: shallow-merge prefs on update; gate prefs on get_by_id | Hub | A |
| R2.3 | Controller wiring; keep old preferences routes **until R5** (or delete in same PR if SPA migrated in R2.5 — prefer **same PR** with R2.5) | Hub | A.2 hard cut preferred: migrate callers then delete in R5 if split; **this program prefers R2+R5 same ship if small** |
| R2.4 | BFF account: `update_profile` may accept prefs; stop requiring preferences endpoints for new code | BFF | A |
| R2.5 | SPA Events: `preferences/update` → `users/update` with `{ preferences: { event_alerts: … } }` | SPA | A |
| R2.6 | Session refresh / user DTO: ensure Events still sees prefs after refresh (include on session user or get_by_id) | BFF + SPA | A |
| R2.7 | Zod → OpenAPI + MDX for update + get_by_id | documentation | **B — push docs** |
| R2.8 | Unit + integration for merge + include flag | Hub | C (partial OK until R6) |

**Green R2:** Events can write prefs via `users/update`; get_by_id flag works; docs updated.

---

## R3 — Drop users token twins + Admin Tokens UI

| ID | Work | Surfaces | Rules |
|----|------|----------|-------|
| R3.1 | Remove Core routes `get_tokens` / `revoke_token` + service methods if unused | Hub | A.2 |
| R3.2 | Remove BFF admin get_tokens / revoke_token + schemas/tests | BFF | A |
| R3.3 | Delete `src/pages/admin/tokens_page.tsx` + router entry + nav | SPA | A |
| R3.4 | Update route inventory / platform allowlist / admin schema tests | Hub + BFF | C |
| R3.5 | Docs: remove users token ops from OpenAPI/MDX; point admins to act-as + Account Tokens | documentation | **B — push** |
| R3.6 | Confirm Account Tokens + realm Tokens still use `/v1/auth/*` only | SPA | A |

**Green R3:** `rg '/v1/users/get_tokens|/v1/users/revoke_token'` empty in product code; Admin Tokens gone; auth paths untouched.

---

## R4 — Passwords → `/internal` only

| ID | Work | Surfaces | Rules |
|----|------|----------|-------|
| R4.1 | Add Core `POST /internal/users/change_password` (`require_internal`) | Hub | A.3 |
| R4.2 | Remove Core `POST /v1/users/change_password` and `POST /v1/users/reset_password` | Hub | A.2 |
| R4.3 | Keep `/internal/users/reset_password`; ensure authz same as today | Hub | A |
| R4.4 | BFF account_repository → `/internal/users/change_password` | BFF | A.3 / R0.9 |
| R4.5 | BFF admin_repository reset → `/internal/users/reset_password` | BFF | A |
| R4.6 | SPA still calls BFF `/v1/users/change_password` and admin reset paths (BFF public); no SPA→Core public password | SPA | A |
| R4.7 | OpenAPI: password ops documented as internal / BFF-only; remove from public users tag if OpenAPI is Core-public | documentation | **B — push** |
| R4.8 | Tests: public password routes 404; internal success paths | Hub + BFF | C |

**Green R4:** no public Core password routes; BFF + admin flows work.

---

## R5 — Delete preferences HTTP twins

| ID | Work | Surfaces | Rules |
|----|------|----------|-------|
| R5.1 | Remove Core `preferences/get` + `preferences/update` | Hub | A.2 |
| R5.2 | Remove BFF preferences routes + account methods | BFF | A |
| R5.3 | SPA: zero callers of preferences paths | SPA | A |
| R5.4 | Docs remove preferences resources | documentation | **B — push** |
| R5.5 | `rg preferences/get|preferences/update` empty | all | C |

**Exit R5:** only `users/update` + `get_by_id?include_preferences` touch prefs.

---

## R6 — SPA polish + dead UI

| ID | Work | Surfaces | Rules |
|----|------|----------|-------|
| R6.1 | Events page uses `users/update` only | SPA | A |
| R6.2 | Admin users page reset_password still via BFF | SPA | A |
| R6.3 | Remove Admin Tokens crumbs/links elsewhere | SPA | A |
| R6.4 | Act-as smoke: admin acts-as user → Account Tokens lists that user’s PATs | SPA / e2e | C |

---

## R7 — Docs + Zod / OpenAPI audit

| ID | Work | Surfaces | Rules |
|----|------|----------|-------|
| R7.1 | Diff every Zod users field vs OpenAPI | documentation | B |
| R7.2 | Users MDX: profile update with preferences example; get_by_id include_preferences | documentation | B |
| R7.3 | Explicit note: tokens live under Auth; act-as for admin | documentation | B |
| R7.4 | Explicit note: preferences bag vs Events notifications | documentation | B |
| R7.5 | Push documentation `main` | documentation | **B** |

---

## R8 — Exit review gate

### R8.1 Architecture

- [ ] No `/v1/users` token or preferences or public password routes.  
- [ ] Passwords only `/internal/users/{change,reset}_password`.  
- [ ] Prefs only via `update` / `get_by_id?include_preferences`.  
- [ ] Admin Tokens UI gone; auth + act-as sufficient.  
- [ ] Zod ↔ OpenAPI ↔ MDX aligned.

### R8.2 Code review

- [ ] `rg` clean for deleted paths.  
- [ ] BFF still proxies SPA password routes to internal.  
- [ ] Events `event_alerts` still works.  
- [ ] `dist/` rebuilt for Hub backend.

### R8.3 Test gate — **all suites, all changed surfaces**

```bash
cd cliqhub/services/backend && npm test; echo "BACKEND_EXIT:$?"
cd cliqhub/services/bff && npm test; echo "BFF_UNIT_EXIT:$?"
cd cliqhub/services/bff && npm run test:e2e; echo "BFF_E2E_EXIT:$?"
cd cliqhub && npm test; echo "SPA_EXIT:$?"
```

- [ ] All four exit 0.  
- [ ] Docs pushed (not ahead of origin).  
- [ ] Do not claim Done until then; fix every failure without stopping to ask.

---

## Order of work

```
R0 lock → R1 inventory
  → R2 merge prefs into update + get_by_id
  → R3 drop token twins + Admin Tokens UI
  → R4 passwords internal-only
  → R5 delete preferences HTTP
  → R6 SPA polish
  → R7 docs audit + push
  → R8 STOP (full suites green)
```

Prefer **shipping R2–R5 in one implementation pass** if churn is small; keep slice IDs for review/checklist.

---

## Test plan summary

| Layer | Cases |
|-------|--------|
| Unit | prefs shallow-merge; include_preferences default false; password internal schemas |
| Integration | update+prefs; get_by_id flag; public password 404; internal change/reset OK; users get_tokens 404 |
| BFF | account update/change_password → internal; admin reset → internal; no get_tokens |
| SPA | Events toggles; no Admin Tokens route; Account Tokens still auth |
| Playwright | login → events toggle persists; act-as → tokens page; admin reset password |
| Docs | OpenAPI ≡ Zod; no deleted paths |

---

## Amendments

| Date | Change | Why |
|------|--------|-----|
| 2026-09-19 | Initial plan from Users vs Auth review | Drop global tokens; merge prefs; passwords internal |
| 2026-09-19 | Bake verify/docs/architecture rules into every slice | User: don’t require rememorizing rules |
| 2026-09-19 | R0.12 no admin user_id on auth get_tokens | Act-as sufficient; global list dropped |

---

## Sign-off

| Role | Name | Date |
|------|------|------|
| Product / API owner | | |
| Implementer | | |
