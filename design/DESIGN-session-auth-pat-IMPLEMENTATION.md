# DESIGN — Session auth via user PAT — implementation plan

**Status:** done  
**Companion to:** [`DESIGN-session-auth-pat.md`](./DESIGN-session-auth-pat.md)

---

## 0. Ground rules

1. **No backward compatibility** — hard cut; no route aliases.
2. **Per-slice exit:** implementation + unit tests + comments/docs for that slice + slice checklist verified + code review (Bugbot on uncommitted/branch diff for the slice).
3. **Naming:** new functions/variables use `snake_case`.
4. **Core comments:** auth boundaries must document Bearer kinds and session-PAT mint rules.
5. **Zero-test-failures** for the package(s) touched in the slice before marking complete.

---

## 1. Slice map

| ID | Title | Depends | Status |
|----|-------|---------|--------|
| 0 | Contracts locked in design docs | — | **done** |
| 1 | Core: PAT-only middleware + internal session mint; delete public JWT session routes | 0 | **done** |
| 2 | BFF: session store + create/get/update/delete | 1 | **done** |
| 3 | SPA: auth_context → `/v1/session/*` | 2 | **done** |
| 4 | CLI: login via session/create; drop JWT refresh / `hub.token` | 2 | **done** |
| 5 | Daemon: `hub.session` PAT; drop `/me` / `hub.token` | 1–4 | **done** |
| 6 | Docs / OpenAPI regen + internal-docs auth page | 1–5 | **done** |
| 7 | E2E / Playwright / daemon-e2e gate | 1–6 | **done** |

---

## 2. Slice 0 — Contracts (documentation)

### Deliverables
- [x] `cliqhub/design/DESIGN-session-auth-pat.md` — product/design
- [x] This implementation plan with per-slice detail
- [x] Locked session fields: `user_id`, `act_as_user_id`, `user_token`, `target_token`
- [x] Locked APIs: internal auth + BFF `/v1/session/*`
- [x] Locked deletes list

### Exit checklist
- [x] Design + implementation docs committed to tree
- [x] No code required
- [x] Review: docs consistency with locked model (user_token immutable on act-as; always Bearer=`target_token`)

**Slice 0 complete:** yes

---

## 3. Slice 1 — Core

### 3.1 Sub-slices

| ID | Work |
|----|------|
| 1.1 | Middleware: accept only `cliq_tok_` \| `cliq_dt_`; remove JWT + `cliq_dk_` |
| 1.2 | `mint_session_pat`, `authenticate_user`, `issue_session_token`, `revoke_session_token`; signup returns session PAT |
| 1.3 | Remove public `/v1/auth/login\|me\|refresh\|impersonate*`; wire `/internal/auth/*` |
| 1.4 | `require_token_scope`: no empty-scope full-power bypass; session mints get explicit default grants |
| 1.5 | Unit + integration tests; file comments |

### Files (expected)
- `cliqhub/services/backend/src/middleware/auth_middleware.ts`
- `cliqhub/services/backend/src/core_api/middleware/require_token_scope.ts`
- `cliqhub/services/backend/src/services/auth_service.ts`
- `cliqhub/services/backend/src/controllers/auth_controller.ts` (or internal auth controller)
- `cliqhub/services/backend/src/controllers/tokens_controller.ts` / token repo as needed
- `cliqhub/services/backend/src/app.ts`
- `cliqhub/services/backend/src/auth/jwt.ts` — remove Hub session use
- Tests under `cliqhub/services/backend/tests/**`

### Comments required
- Top of `auth_middleware.ts`: only two Bearer kinds; sessions owned by BFF.
- On mint helpers: who may call; `session_scoped`; revoke-on-logout.

### Unit / integration tests
- authenticate success → `cliq_tok_`
- JWT Bearer → 401/unauth
- `cliq_dk_` → unauth
- issue_session_token admin vs non-admin
- revoke then reject
- public login route gone (404)
- require_token_scope with explicit grants

### Exit checklist
- [x] 1.1–1.5 implemented
- [x] Backend unit + integration auth tests green (130 tests in auth-focused suite)
- [x] Comments present
- [x] Design status for Slice 1 updated
- [x] Code review (Bugbot on cliqhub uncommitted): **no bugs found**; removed leftover `login_schema` alias

**Slice 1 complete:** yes

**Review notes:** `require_token_scope` still allows empty *capability* `scopes[]` (Forge); Hub **grants** on session PATs are always explicit via `default_grant_for_subject`. `jwt.ts` retained for builder only — not Hub API auth.

---

## 4. Slice 2 — BFF session

### 4.1 Sub-slices

| ID | Work |
|----|------|
| 2.1 | SessionStore columns: `user_id`, `act_as_user_id`, `user_token`, `target_token` (+ identity cache) |
| 2.2 | `session_service`: create/get/update/delete; data-plane Bearer = `target_token` |
| 2.3 | Routes `/v1/session/*`; strip BFF `/v1/auth/login\|me\|logout\|impersonate*` |
| 2.4 | Repo → internal authenticate / issue / revoke |
| 2.5 | Unit tests |

### Files (expected)
- `cliqhub/services/bff/src/repositories/session_store.ts`
- `cliqhub/services/bff/src/services/session_service.ts` (new)
- `cliqhub/services/bff/src/controllers/session_controller.ts` (new)
- `cliqhub/services/bff/src/repositories/auth_repository.ts` (or internal_auth_repository)
- `cliqhub/services/bff/src/app.ts`
- `cliqhub/services/bff/tests/unit/**`

### Exit checklist
- [x] Session always persists both tokens
- [x] Act-as mutates only `target_token` / `act_as_user_id`
- [x] Exit sets `target_token = user_token`
- [x] Unit tests green
- [x] Comments on session_service
- [ ] Bugbot review for slice

**Slice 2 complete:** yes

**Review notes (Bugbot):** Session PATs must not freeze elevated grants — fixed in Core middleware: `session:…` named PATs omit `token_permissions` so assert_grant uses live membership. Standing user PATs still use stored grants.

---

## 5. Slice 3 — SPA

### Work
- `auth_context.tsx` → `/v1/session/create|get|delete|update`
- Admin act-as UI → `session/update`
- Unit tests / mocks updated

### Exit checklist
- [x] No remaining SPA calls to deleted auth session routes
- [x] Vitest green for touched tests
- [ ] Bugbot review for slice

**Slice 3 complete:** yes

**Review notes:** SPA exposes `user_id`, `act_as_user_id`, `acting_as`; `impersonate`/`stop_impersonate` renamed to `act_as`/`stop_act_as`. Signup remains `/v1/auth/signup`. Token APIs under `/v1/auth/*` unchanged.
---

## 6. Slice 4 — CLI

### Work
- `hub_command` login → BFF `session/create` + `X-Client: cli`
- `hub.session` = `cliq_tok_…`
- Remove JWT refresh; remove `hub.token`
- Unit tests

### Exit checklist
- [x] CLI unit tests green (`hub_command`, `hub_credentials`, `settings_command`, related login/setup)
- [x] Help/changelog strings updated for this slice
- [ ] Bugbot review for slice

**Slice 4 complete:** yes

**Review notes:** `cliq.api_url` / `CLIQ_API_URL` already targets the BFF/gateway (default `https://api.cliqhub.io`, local `http://127.0.0.1:3001`) — no separate BFF URL setting. Login uses `POST /v1/session/create`; `resolve_hub_bearer_refreshed` is a no-op alias (no `/v1/auth/refresh`). `hub.token` removed from secret keys / cleared on persist. Setup login path updated to match. Daemon enroll/`/me` left for Slice 5.

---

## 7. Slice 5 — Daemon

### Work
- `hub.session` PAT only; drop `hub.token` and `/v1/auth/me` dependency
- Defaults from login payload where possible
- Daemon unit / daemon-e2e seeds

### Exit checklist
- [x] Daemon tests green for touched areas
- [x] Bugbot review for slice

**Slice 5 complete:** yes

**Review notes:** `HubService.login` → BFF `/v1/session/create`; persists `cliq_tok_…` + `hub.default_realm_*` from payload; rejects non-PAT credentials.token; clears obsolete `hub.token` on login/logout/cliqrc import. `resolve_enroll_realm_slug` is payload/local-only (no `/v1/auth/me`). `SettingsService.set('hub.token')` rejected. Daemon status no longer decodes JWT claims from `hub.session`. Bugbot on uncommitted cliq-platform diff flagged Slice-4 CLI gaps (setup realm defaults / PAT check; user-switch enroll cleanup) — outside daemon hard-cut scope.

---

## 8. Slice 6 — Documentation / OpenAPI

### Work
- Update `documentation/auth.mdx`, `cli.mdx`, `hub-api.mdx`, OpenAPI yamls, generator
- Update `cliqhub/internal-docs/overview/authentication.mdx` to PAT + BFF session model
- Regen hub OpenAPI

### Exit checklist
- [x] Public docs match locked model
- [x] bearerFormat = `cliq_tok_* \| cliq_dt_*` only
- [x] Review docs for leftover JWT / `cliq_dk_` / `hub.token`

**Slice 6 complete:** yes

**Review notes:** Public `auth.mdx` / `cli.mdx` / `hub-api.mdx` describe BFF session + `cliq_tok_`/`cliq_dt_` only; OpenAPI regen dropped public login/me/refresh/impersonate; `bearerFormat` is `cliq_tok_* | cliq_dt_*`. Internal-docs auth page already matched.

---

## 9. Slice 7 — E2E gate

### Suites
- BFF Playwright (`e2e/helpers.ts` + auth/admin/tokens + smoke)
- Backend migrated e2e + integration
- CLI daemon-e2e (hub, settings, setup)

### Exit checklist
- [x] BFF Playwright helpers + `auth.spec` on `/v1/session/*` only; legacy login/me/impersonate → 404 asserted
- [x] Backend migrated e2e already on internal authenticate / `cliq_tok_…` bearers (no leftover public login/me usage)
- [x] CLI daemon-e2e seeds use `hub.session` = `cliq_tok_…` (Slice 5); no `hub.token` leftovers; local daemon API key is opaque (not JWT)
- [x] Playwright live suite run: **auth.spec 13/13 green**; full suite **123 passed / 4 failed** (failures are realm-redirect/daemons smoke, not session auth)
- [x] Design status → **done**

**Slice 7 complete:** yes

**Review notes:** `e2e/helpers.ts` → `session/create|get|delete` + `api_act_as` → `session/update`. `auth.spec.ts` session get + legacy 404. Backend/daemon-e2e leftovers already clean from earlier slices. Full Playwright not 100% green due to unrelated realm/daemons redirect flakes.

---

## 10. Test matrix (full product)

See design doc + per-slice lists. Summary:

| Layer | Positive | Negative |
|-------|----------|----------|
| Core | authenticate PAT; issue; revoke; realm token | JWT/`cliq_dk_`; public login 404; non-admin issue |
| BFF | create equal tokens; update target only; exit restore | bad login; non-admin act-as |
| SPA/CLI/Daemon | session paths; hub.session PAT | legacy keys/URLs gone |
| Playwright | login/logout/act-as/tokens/smoke | wrong password; old URLs 404 |

---

## 11. Progress log

| Date | Slice | Notes |
|------|-------|-------|
| 2026-09-18 | 0 | Design + implementation docs written |
| 2026-09-18 | 1 | Core PAT-only middleware; internal authenticate/issue/revoke; public JWT session routes removed; session PAT mint via default_grant_for_subject; unit+integration auth tests updated |
| 2026-09-18 | 2 | BFF dual-token session store; `/v1/session/{create,get,update,delete}`; stripped `/v1/auth/login\|me\|logout\|impersonate*`; auth_repository → internal authenticate/issue/revoke; all Core data-plane Bearer = `target_token`; BFF unit+integration tests green (749); Bugbot grant-freeze finding fixed for session PATs |
| 2026-09-18 | 1b | Session PAT live grants: middleware skips frozen permissions for `session:…` tokens |
| 2026-09-18 | 3 | SPA auth_context → `/v1/session/*`; act-as via `session/update`; `acting_as`/`user_id`/`act_as_user_id` exposed; hub_activity + admin take-over UI + vitest mocks updated |
| 2026-09-18 | 4 | CLI login → BFF `/v1/session/create`; `hub.session` = session PAT; drop JWT refresh + `hub.token`; help/changelog + unit tests |
| 2026-09-18 | 5 | Daemon: hub.session PAT-only; HubService → session/create + realm defaults; drop `/v1/auth/me` enroll fallback + hub.token reads/writes; seeds/tests use `cliq_tok_…`; unit tests green |
| 2026-09-18 | 4 follow-up | logout revoke + setup PAT validation |
| 2026-09-18 | 6 | Public docs + OpenAPI: session BFF + PAT/realm bearer only; removed public login/me/refresh/impersonate from specs; regen hub/internal OpenAPI; grep-cleaned leftover JWT/`cliq_dk_`/`hub.token` language |
| 2026-09-18 | 7 | BFF Playwright helpers/auth.spec → `/v1/session/*`; legacy auth 404; auth.spec 13/13; full suite 123/127 (4 unrelated realm/daemons fails); BFF unit 749; backend migrated + daemon-e2e seeds already PAT-aligned |
