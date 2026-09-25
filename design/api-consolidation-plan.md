# API Consolidation & Rename Plan

## Naming Conventions

| Convention | Rule | Example |
|---|---|---|
| `new` | Create a resource | `/users/new`, `/orgs/new` |
| `get` | Get a list (with filters) | `/teams/get`, `/users/get` |
| `get_by_id` | Get single resource detail | `/teams/get_by_id`, `/users/get_by_id` |
| `update` | Update a resource | `/users/update`, `/orgs/update` |
| `delete` | Soft-delete / mark deleted | `/teams/delete`, `/orgs/delete` |
| Flat paths only | No multi-level nesting | `/orgs/add_member` NOT `/orgs/members/add` |
| All POST | Every endpoint is POST | — |
| snake_case | All path segments | `/teams/get_by_id` not `/teams/getById` |

## Resource Hierarchy

Tokens are **not** a first-class resource. They belong to users.
Scopes are a first-class resource (they exist independently).
Stats + audit → consolidated under `/reports`.

### First-class resources: `auth`, `users`, `teams`, `drafts`, `orgs`, `scopes`, `reports`, `builder`, `hug`

---

## Complete Endpoint Map: Old → New

### Auth (`/api/auth/*`)

| Old path | New path | Notes |
|---|---|---|
| `/api/auth/signup` | `/api/auth/signup` | No change |
| `/api/auth/login` | `/api/auth/login` | No change |
| `/api/auth/me` | `/api/auth/me` | No change |
| `/api/auth/create_token` | `/api/users/new_token` | Moved to users |
| `/api/auth/revoke_token` | `/api/users/revoke_token` | Moved to users |
| `/api/auth/list_tokens` | `/api/users/get_tokens` | Moved to users |

### Users (`/api/users/*`) — NEW resource, absorbs admin/users + auth/tokens

| Old path | New path | Permissions | Input |
|---|---|---|---|
| `/api/admin/users/list` | `/api/users/get` | org_admin (with org_id) or site_admin (without) | `{ org_id?, search?, limit?, offset? }` |
| `/api/admin/users/get` | `/api/users/get_by_id` | site_admin | `{ user_id }` |
| `/api/admin/users/create` | `/api/users/new` | site_admin | `{ username, email, password, display_name? }` |
| `/api/admin/users/update` | `/api/users/update` | self (own profile) or site_admin (any user) | `{ user_id?, display_name?, email? }` |
| `/api/admin/users/delete` | `/api/users/delete` | site_admin | `{ user_id }` |
| `/api/admin/users/suspend` | `/api/users/suspend` | site_admin | `{ user_id, reason? }` |
| `/api/admin/users/unsuspend` | `/api/users/unsuspend` | site_admin | `{ user_id }` |
| `/api/admin/users/reset_password` | `/api/users/reset_password` | site_admin | `{ user_id, new_password }` |
| `/api/admin/users/set_role` | `/api/users/set_role` | site_admin | `{ user_id, role }` |
| `/api/account/update_profile` | `/api/users/update` | Merged — self updates own profile | `{ display_name?, email? }` |
| `/api/account/change_password` | `/api/users/change_password` | self only | `{ current_password, new_password }` |
| `/api/auth/create_token` | `/api/users/new_token` | self or site_admin (with user_id) | `{ name, user_id? }` |
| `/api/auth/list_tokens` | `/api/users/get_tokens` | self or site_admin (with user_id) | `{ user_id?, limit?, offset? }` |
| `/api/auth/revoke_token` | `/api/users/revoke_token` | self (own token) or site_admin | `{ token_id }` |
| `/api/admin/tokens/list` | `/api/users/get_tokens` | Merged — admin passes user_id or omits for all | (same) |
| `/api/admin/tokens/revoke` | `/api/users/revoke_token` | Merged | (same) |

### Teams (`/api/teams/*`) — consolidated list/search/mine into `get`

| Old path | New path | Permissions | Input |
|---|---|---|---|
| `/api/teams/list` | `/api/teams/get` | public (filtered) or admin (all) | `{ query?, domain?, tag?, scope?, mine?, group_by_scope?, listed?, limit?, offset? }` |
| `/api/teams/search` | `/api/teams/get` | Merged — pass `query` param | (same) |
| `/api/teams/list_mine` | `/api/teams/get` | Merged — pass `mine: true, scope` | (same) |
| `/api/teams/list_all_mine` | `/api/teams/get` | Merged — pass `mine: true, group_by_scope: true` | (same) |
| `/api/admin/teams/list` | `/api/teams/get` | Merged — admin sees all, can filter `listed` | (same) |
| `/api/teams/get` | `/api/teams/get_by_id` | public (if visible) | `{ name, scope? }` |
| `/api/teams/get_version` | `/api/teams/get_version` | public (if visible) | `{ name, scope?, version }` |
| `/api/teams/get_versions` | `/api/teams/get_versions` | public (if visible) | `{ name, scope?, latest_only? }` |
| `/api/teams/get_latest_version` | `/api/teams/get_versions` | Merged — pass `latest_only: true` | (same) |
| `/api/teams/batch_latest` | `/api/teams/batch_latest` | public | `{ teams[] }` (no change) |
| `/api/teams/publish` | `/api/teams/publish` | scope member | No change |
| `/api/teams/publish_check` | `/api/teams/publish_check` | scope member | No change |
| `/api/teams/download` | `/api/teams/download` | public (if visible) | No change |
| `/api/teams/delete` | `/api/teams/delete` | author or site_admin | `{ name, scope?, team_id? }` |
| `/api/teams/delete_version` | `/api/teams/delete_version` | author or site_admin | No change |
| `/api/teams/toggle_listed` | `/api/teams/set_listed` | author or site_admin | `{ name, scope?, team_id?, listed }` |
| `/api/teams/rename` | `/api/teams/rename` | author or site_admin | No change |
| `/api/admin/teams/set_listed` | `/api/teams/set_listed` | Merged | (same) |
| `/api/admin/teams/delete` | `/api/teams/delete` | Merged — admin uses team_id | (same) |
| `/api/admin/teams/transfer` | `/api/teams/transfer` | site_admin only | `{ team_id, new_author_id, new_scope? }` |

### Drafts (`/api/drafts/*`)

| Old path | New path | Notes |
|---|---|---|
| `/api/drafts/list` | `/api/drafts/get` | Rename list → get |
| `/api/drafts/get` | `/api/drafts/get_by_id` | Rename |
| `/api/drafts/save` (create) | `/api/drafts/new` | When no id |
| `/api/drafts/save` (update) | `/api/drafts/update` | When id present |
| `/api/drafts/delete` | `/api/drafts/delete` | No change |

### Orgs (`/api/orgs/*`) — flatten multi-level paths, absorb admin

| Old path | New path | Permissions | Input |
|---|---|---|---|
| `/api/orgs/list` | `/api/orgs/get` | self (own orgs) or site_admin (all) | `{ search?, limit?, offset? }` |
| `/api/admin/orgs/list` | `/api/orgs/get` | Merged | (same) |
| `/api/orgs/get` | `/api/orgs/get_by_id` | org member or site_admin | `{ org_id }` |
| `/api/admin/orgs/create` | `/api/orgs/new` | site_admin | `{ slug, display_name?, admin_username, ... }` |
| `/api/orgs/update` | `/api/orgs/update` | org_admin or site_admin | No change |
| `/api/admin/orgs/delete` | `/api/orgs/delete` | site_admin | `{ org_id }` |
| `/api/orgs/leave` | `/api/orgs/leave` | org member | No change |
| `/api/orgs/members/add` | `/api/orgs/add_member` | org_admin or site_admin | No change |
| `/api/orgs/members/remove` | `/api/orgs/remove_member` | org_admin or site_admin | No change |
| `/api/orgs/members/set_role` | `/api/orgs/set_member_role` | org_admin or site_admin | No change |
| `/api/orgs/scopes/create` | `/api/orgs/new_scope` | org_admin or site_admin | No change |
| `/api/orgs/scopes/delete` | `/api/orgs/delete_scope` | org_admin or site_admin | No change |
| `/api/orgs/scopes/assign` | `/api/orgs/assign_scope_member` | org_admin or site_admin | No change |
| `/api/orgs/scopes/unassign` | `/api/orgs/unassign_scope_member` | org_admin or site_admin | No change |

### Scopes (`/api/scopes/*`) — absorbs admin/scopes

| Old path | New path | Permissions |
|---|---|---|
| `/api/admin/scopes/list` | `/api/scopes/get` | site_admin |
| `/api/admin/scopes/create` | `/api/scopes/new` | site_admin |
| `/api/admin/scopes/update` | `/api/scopes/update` | site_admin |
| `/api/admin/scopes/delete` | `/api/scopes/delete` | site_admin |

### Reports (`/api/reports/*`) — absorbs admin/stats + admin/audit

| Old path | New path | Permissions |
|---|---|---|
| `/api/admin/stats` | `/api/reports/stats` | site_admin |
| `/api/admin/audit` | `/api/reports/audit` | site_admin |

### Builder (`/api/builder/*`) — no changes

| Path | Notes |
|---|---|
| `/api/builder/generate` | No change |
| `/api/builder/improve_role` | No change |
| `/api/builder/suggest` | No change |
| `/api/builder/validate` | No change |
| `/api/builder/chat` | No change |

### HUG (`/api/hug/*`) — no changes

| Path | Notes |
|---|---|
| `/api/hug/generate_token` | No change |
| `/api/hug/status` | No change |

---

## Final Backend Endpoint Count

| Resource | Endpoints | Methods |
|---|---|---|
| `auth` | 3 | signup, login, me |
| `users` | 12 | get, get_by_id, new, update, delete, suspend, unsuspend, reset_password, set_role, change_password, new_token, get_tokens, revoke_token |
| `teams` | 12 | get, get_by_id, get_version, get_versions, batch_latest, publish, publish_check, download, delete, delete_version, set_listed, rename, transfer |
| `drafts` | 5 | get, get_by_id, new, update, delete |
| `orgs` | 10 | get, get_by_id, new, update, delete, leave, add_member, remove_member, set_member_role, new_scope, delete_scope, assign_scope_member, unassign_scope_member |
| `scopes` | 4 | get, new, update, delete |
| `reports` | 2 | stats, audit |
| `builder` | 5 | generate, improve_role, suggest, validate, chat |
| `hug` | 2 | generate_token, status |
| `health` | 1 | check |
| **Total** | **56** | (down from 65 current — 29 admin + 36 resource) |

---

## What Gets Deleted

- `AdminService` class → methods distributed to `UsersService`, `TeamsService`, `OrgsService`, `ScopesService`, `ReportsService`
- `AdminController` class → methods distributed to resource controllers
- `admin_schemas.ts` → schemas merged into resource schema files
- `admin_guard` middleware → replaced by per-method `_require_admin(auth)` inside each service
- All `/api/admin/*` routes from `app.ts`
- `AccountService` → absorbed into `UsersService`
- `AccountController` → absorbed into `UsersController`
- Token methods from `AuthService`/`AuthController` → moved to `UsersService`/`UsersController`
- All corresponding unit + integration test files for admin, account, auth tokens

---

## BFF Impact

The BFF **keeps** its `/api/admin/*` routes. The BFF admin controller simply calls the new backend resource endpoints instead:

| BFF route | Backend call |
|---|---|
| `POST /api/admin/list_users` | `POST backend/api/users/get` (with admin token) |
| `POST /api/admin/list_teams` | `POST backend/api/teams/get` (with admin token) |
| etc. | etc. |

The BFF renames its non-admin routes to match the new backend naming.

---

## CLI Impact

The CLI calls these backend endpoints directly (routed via Nginx):

| Old CLI call | New CLI call |
|---|---|
| `/teams/list` | `/teams/get` |
| `/teams/search` | `/teams/get` (with `query` param) |
| `/teams/get` | `/teams/get_by_id` |
| `/teams/download` | `/teams/download` (no change) |
| `/teams/publish` | `/teams/publish` (no change) |
| `/teams/batch_latest` | `/teams/batch_latest` (no change) |
| `/auth/login` | `/auth/login` (no change) |
| `/auth/create_token` | `/users/new_token` |

---

## Slice-by-Slice Implementation Plan

### Slice A — Create UsersService + UsersController (absorb Account + Auth tokens + Admin users)

**New files:**
- `src/services/users_service.ts`
- `src/controllers/users_controller.ts`
- `src/schemas/users_schemas.ts`

**Methods in UsersService:**

| Method | From | Permissions |
|---|---|---|
| `get(auth, params)` | `AdminService.list_users` + `OrgsService` | org_admin (with org_id) or site_admin |
| `get_by_id(auth, params)` | `AdminService.get_user` | site_admin |
| `new_user(auth, params)` | `AdminService.create_user` | site_admin |
| `update(auth, params)` | `AdminService.update_user` + `AccountService.update_profile` | self (no user_id) or site_admin (with user_id) |
| `delete(auth, params)` | `AdminService.delete_user` | site_admin |
| `suspend(auth, params)` | `AdminService.suspend_user` | site_admin |
| `unsuspend(auth, params)` | `AdminService.unsuspend_user` | site_admin |
| `reset_password(auth, params)` | `AdminService.reset_password` | site_admin |
| `set_role(auth, params)` | `AdminService.set_role` | site_admin |
| `change_password(auth, params)` | `AccountService.change_password` | self only |
| `new_token(auth, params)` | `AuthController.create_token` (token service) | self or site_admin (with user_id) |
| `get_tokens(auth, params)` | `AuthController.list_tokens` + `AdminService.admin_list_tokens` | self or site_admin (with user_id) or site_admin (all) |
| `revoke_token(auth, params)` | `AuthController.revoke_token` + `AdminService.admin_revoke_token` | self (own token) or site_admin |

**Tests:**
- `tests/unit/services/users_service.test.ts` (~35 tests)
- `tests/unit/controllers/users_controller.test.ts` (~15 tests)
- `tests/integration/users.test.ts` (~25 tests)

**Wired routes in app.ts:**
```
POST /api/users/get
POST /api/users/get_by_id
POST /api/users/new
POST /api/users/update
POST /api/users/delete
POST /api/users/suspend
POST /api/users/unsuspend
POST /api/users/reset_password
POST /api/users/set_role
POST /api/users/change_password
POST /api/users/new_token
POST /api/users/get_tokens
POST /api/users/revoke_token
```

**Deletes after wiring:**
- `AccountService`, `AccountController`, `account_schemas.ts`
- Token methods from `AuthService`/`AuthController`
- User/token methods from `AdminService`/`AdminController`

---

### Slice B — Consolidate TeamsService (merge list/search/mine + admin teams)

**Modify:** `src/services/teams_service.ts`, `src/controllers/teams_controller.ts`, `src/schemas/teams_schemas.ts`

**Method changes:**

| Method | What changes |
|---|---|
| `get(auth, params)` | **NEW unified list** — merges `list`, `search`, `list_my_teams`, `list_all_my_teams`, `admin_list_teams`. Accepts `{ query?, domain?, tag?, scope?, mine?, group_by_scope?, listed?, limit?, offset? }`. Admin sees all; user sees public+own. |
| `get_by_id(auth, params)` | **Renamed** from `get`. Same logic. `{ name, scope? }` |
| `get_versions(auth, params)` | **Absorbs** `get_latest_version`. Add `latest_only?` param. |
| `set_listed(auth, params)` | **Replaces** `toggle_listed` + `admin_set_listed`. `{ name?, scope?, team_id?, listed }`. Author or admin. |
| `transfer(auth, params)` | **Moved from** `AdminService.admin_transfer_team`. admin only. |
| `delete(auth, params)` | **Absorbs** `admin_delete_team`. Accepts `team_id?` for admin, `name+scope` for author. |

**Removed methods:** `list`, `search`, `list_my_teams`, `list_all_my_teams`, `get_latest_version`, `toggle_listed`

**Tests:**
- Update `tests/unit/services/teams_service.test.ts` (~20 tests rewritten)
- Update `tests/unit/controllers/teams_controller.test.ts`
- Update `tests/integration/teams_read.test.ts` + `teams_write.test.ts`

**Wired routes in app.ts:**
```
POST /api/teams/get              (unified list)
POST /api/teams/get_by_id        (single team detail)
POST /api/teams/get_version
POST /api/teams/get_versions     (absorbs get_latest_version)
POST /api/teams/batch_latest
POST /api/teams/publish
POST /api/teams/publish_check
POST /api/teams/download
POST /api/teams/delete           (author or admin)
POST /api/teams/delete_version
POST /api/teams/set_listed       (replaces toggle_listed)
POST /api/teams/rename
POST /api/teams/transfer         (admin only)
```

---

### Slice C — Consolidate OrgsService (absorb admin orgs, flatten paths)

**Modify:** `src/services/orgs_service.ts`, `src/controllers/orgs_controller.ts`, `src/schemas/orgs_schemas.ts`

**Method changes:**

| Method | What changes |
|---|---|
| `get(auth, params)` | **Replaces** `list_my_orgs` + `admin_list_orgs`. Regular user (no search) → own orgs. Admin → all orgs with search/pagination. |
| `get_by_id(auth, params)` | **Renamed** from `get_org`. Same logic. |
| `new_org(auth, params)` | **Moved from** `AdminService.admin_create_org`. Site admin only. |
| `delete(auth, params)` | **Moved from** `AdminService.admin_delete_org`. Site admin only. |

**Existing methods renamed (flatten paths):**
- `add_member` stays `/api/orgs/add_member`
- `remove_member` stays `/api/orgs/remove_member`
- `set_member_role` stays `/api/orgs/set_member_role`
- `create_org_scope` → `new_scope` at `/api/orgs/new_scope`
- `delete_org_scope` → `delete_scope` at `/api/orgs/delete_scope`
- `assign_scope_member` stays `/api/orgs/assign_scope_member`
- `unassign_scope_member` stays `/api/orgs/unassign_scope_member`

**Tests:**
- Update `tests/unit/services/orgs_service.test.ts`
- Update `tests/unit/controllers/orgs_controller.test.ts`
- Update `tests/integration/orgs.test.ts`
- New tests for new/delete org methods (~10 tests)

**Wired routes:**
```
POST /api/orgs/get
POST /api/orgs/get_by_id
POST /api/orgs/new
POST /api/orgs/update
POST /api/orgs/delete
POST /api/orgs/leave
POST /api/orgs/add_member
POST /api/orgs/remove_member
POST /api/orgs/set_member_role
POST /api/orgs/new_scope
POST /api/orgs/delete_scope
POST /api/orgs/assign_scope_member
POST /api/orgs/unassign_scope_member
```

---

### Slice D — Create ScopesService + ReportsService (absorb admin scopes, stats, audit)

**New files:**
- `src/services/scopes_service.ts`
- `src/controllers/scopes_controller.ts`
- `src/schemas/scopes_schemas.ts`
- `src/services/reports_service.ts`
- `src/controllers/reports_controller.ts`
- `src/schemas/reports_schemas.ts`

**ScopesService methods (all site_admin):**

| Method | From |
|---|---|
| `get(auth, params)` | `AdminService.list_scopes` |
| `new_scope(auth, params)` | `AdminService.create_scope` |
| `update(auth, params)` | `AdminService.update_scope` |
| `delete(auth, params)` | `AdminService.delete_scope` |

**ReportsService methods (all site_admin):**

| Method | From |
|---|---|
| `stats(auth)` | `AdminService.stats` |
| `audit(auth, params)` | `AdminService.audit_log` |

**Tests:**
- `tests/unit/services/scopes_service.test.ts` (~12 tests)
- `tests/unit/controllers/scopes_controller.test.ts` (~6 tests)
- `tests/integration/scopes.test.ts` (~10 tests)
- `tests/unit/services/reports_service.test.ts` (~6 tests)
- `tests/unit/controllers/reports_controller.test.ts` (~4 tests)
- `tests/integration/reports.test.ts` (~6 tests)

**Wired routes:**
```
POST /api/scopes/get
POST /api/scopes/new
POST /api/scopes/update
POST /api/scopes/delete
POST /api/reports/stats
POST /api/reports/audit
```

---

### Slice E — Rename Drafts endpoints + split save into new/update

**Modify:** `src/services/drafts_service.ts`, `src/controllers/drafts_controller.ts`, `src/schemas/drafts_schemas.ts`

| Old | New |
|---|---|
| `list` → `get` | `/api/drafts/get` |
| `get` → `get_by_id` | `/api/drafts/get_by_id` |
| `save` (no id) → `new_draft` | `/api/drafts/new` |
| `save` (with id) → `update` | `/api/drafts/update` |
| `delete` | `/api/drafts/delete` (no change) |

**Tests:** Update existing draft tests to use new names (~10 tests rewritten).

---

### Slice F — Delete AdminService/AdminController/admin_guard + old routes, update container

**Deletes:**
- `src/services/admin_service.ts`
- `src/controllers/admin_controller.ts`
- `src/schemas/admin_schemas.ts`
- `src/middleware/admin_guard.ts`
- `tests/unit/services/admin_service.test.ts`
- `tests/unit/controllers/admin_controller.test.ts`
- `tests/unit/middleware/admin_guard.test.ts`
- `tests/integration/admin_users_scopes.test.ts`
- `tests/integration/admin_teams_tokens_orgs.test.ts`

**Modify:**
- `src/container.ts` — remove AdminService/AdminController, add UsersService/UsersController, ScopesService/ScopesController, ReportsService/ReportsController
- `src/app.ts` — remove all `/api/admin/*` routes, remove `admin_guard` import, remove `AccountController`/`AccountService` references
- Remove `AccountService` + `AccountController` + their test files

**Verify:** All tests pass.

---

### Slice G — Update BFF to match new backend paths

**Modify:** All BFF repositories, services, controllers, schemas to call new backend paths.

| BFF layer | Changes |
|---|---|
| `repositories/` | Update fetch URLs (e.g., `/api/teams/list` → `/api/teams/get`) |
| `services/` | Rename methods to match new convention |
| `controllers/` | Rename handler methods |
| `schemas/` | Update schema names |
| `app.ts` | Update route paths |
| BFF admin routes | Keep `/api/admin/*` paths in BFF, but have them call unified backend endpoints |

**Tests:** Update all BFF unit + integration tests.

---

### Slice H — Update CLI to match new backend paths

**Modify:** `cliq/src/commands/hub_command.ts`

| Old CLI call | New CLI call |
|---|---|
| `/teams/list` | `/teams/get` |
| `/teams/search` | `/teams/get` (with `query`) |
| `/teams/get` | `/teams/get_by_id` |
| `/auth/create_token` | `/users/new_token` |

**Modify:** `cliq/src/node/handlers/teams.ts` + `cliq/src/node/register_handlers.ts` — update local handler paths.

**Tests:** Update CLI test files.

---

### Slice I — Update E2E tests + Frontend pages

**Modify:** All Playwright E2E specs to use new BFF paths.
**Modify:** Frontend pages that call BFF endpoints (via `useAuthFetch` or `bff-fetch`).

---

### Slice J — Final cleanup + verify all tests green

- Remove any dead imports, unused schemas, orphaned test helpers
- Run full test suite: backend, BFF, CLI, E2E
- Update internal-docs API documentation to reflect new paths

---

## Slice Summary

| Slice | Focus | Est. new/modified tests |
|---|---|---|
| A | UsersService (absorb Account + Auth tokens + Admin users) | ~75 |
| B | Consolidate TeamsService (merge list/search/mine + admin) | ~40 rewritten |
| C | Consolidate OrgsService (absorb admin orgs, flatten paths) | ~25 |
| D | ScopesService + ReportsService (absorb admin scopes/stats/audit) | ~44 |
| E | Rename Drafts (get/get_by_id/new/update/delete) | ~10 rewritten |
| F | Delete AdminService/AdminController/admin_guard + old files | 0 (deletions only) |
| G | Update BFF paths + tests | ~60 rewritten |
| H | Update CLI paths + tests | ~15 rewritten |
| I | Update E2E tests + Frontend pages | ~65 rewritten |
| J | Final cleanup + verify | 0 |

**Total slices: 10**
**Each slice is independently mergeable and testable.**
