# BFF Implementation Plan — Detailed Slice Breakdown

Companion to `bff-api-architecture.md`.

Each slice is self-contained: backend test gaps for the resource are fixed,
the BFF layer is built, the frontend is updated, and tests are written —
all within the same slice. Every slice produces something you can test in
the browser.

**Execution sequence within every slice:**

1. Fix backend test gaps for the handlers being wrapped
2. Add BFF types (`api_types.ts`) → DTOs (`dto.ts`) → mappers (`mappers.ts`)
3. Add Zod schemas
4. Build repository → service → controller
5. Wire routes + update container
6. Write BFF unit tests (mappers, repo, service, controller, schemas)
7. Write BFF integration tests (supertest)
8. Update frontend (URLs, validation, error handling)
9. Manual browser smoke test
10. `npm test` in both `cliqhub/` and `cliqhub/services/bff/` → all green → merge

---

## Naming Conventions

| Layer | Naming | Example |
|-------|--------|---------|
| Backend API types (Value Objects) | `*VO` suffix | `UserVO`, `TeamDetailVO` |
| DTOs (BFF → Frontend) | `DTO` suffix | `UserDTO`, `TeamListItemDTO` |
| Value Objects (internal) | `VO` suffix | `SessionPolicyVO`, `ScopeVO` |
| Mappers | `to_*_dto` | `to_user_dto()`, `to_team_list_item_dto()` |
| Zod schemas | `*_schema` | `login_schema`, `publish_team_schema` |
| Test fixtures | `SCREAMING_SNAKE` | `ALICE`, `BOB`, `SITE_ADMIN` |

---

## Master Route Inventory

**70 existing Next.js routes → 64 BFF routes (6 removed)**

| Domain | Existing | BFF | Removed |
|--------|----------|-----|---------|
| Auth | 6 | 7 | 0 |
| Teams | 14 | 12 | 3 |
| Builder | 5 | 4 | 1 |
| Drafts | 4 | 4 | 0 |
| Orgs | 10 | 11 | 0 |
| Account | 2 | 2 | 0 |
| Admin | 22 | 22 | 2 |
| HUG | 2 | 2 | 0 |
| Health | 1 | 1 | 0 |
| **Total** | **66 + 4 dead** | **64 + 1 health** | **6** |

---

## Slice 1 — Scaffold BFF + Shared Utilities

**Duration:** 2–3 days
**BFF routes delivered:** 1 (`GET /bff-health`)
**Browser testable:** Health endpoint only — existing app still works via proxy fallback

### 1a — Shared backend test fixtures

**File:** `cliqhub/tests/fixtures/users.ts` (new)

Shared `AuthContext` objects used by all backend tests from here on:

- `UNAUTHED` — `user: null`
- `ALICE` — regular user, owns scope `alice`, member of org `acme` with scopes `acme` + `acme-labs` (private)
- `BOB` — regular user, owns scope `bob`, member of org `acme` (no private scopes)
- `SITE_ADMIN` — `role: 'admin'`, owns scope `admin_user`

### 1b — BFF project setup

**Directory:** `cliqhub/services/bff/`

| File | Purpose |
|------|---------|
| `package.json` | express 5, cors, helmet, cookie-parser, pg, zod, uuid, http-proxy-middleware |
| `tsconfig.json` | ES2022, NodeNext, strict |
| `vitest.config.ts` | globals: true |

### 1c — Core infrastructure files

| File | What it does |
|------|-------------|
| `src/config/env.ts` | Typed config: `port`, `backend_url`, `session_secret`, `session_ttl_seconds`, `session_idle_seconds`, `database_url`, `cookie_name`, `cors_origins`, `node_env`, rate limit settings |
| `src/repositories/session_store.ts` | PostgreSQL session CRUD (`bff.sessions`): `create`, `find`, `touch`, `destroy`, `destroy_user`, `prune_expired`. Checks idle timeout in `find()`. All methods async. |
| `src/repositories/api_client.ts` | `post<T>(path, body, token?)` — unwraps `{ok, data}` envelope, throws `ApiError`. `post_raw()` — returns raw envelope. |
| `src/repositories/api_error.ts` | `ApiError` class with `code`, `status` fields |
| `src/middleware/error_handler.ts` | ZodError→422, ApiError→mapped status, unknown→500 |
| `src/middleware/csrf_guard.ts` | Check Origin header on POST, 403 if invalid |
| `src/middleware/rate_limit.ts` | Sliding window per user_id or IP |
| `src/middleware/proxy_fallback.ts` | Forwards unmigrated `/api/*` to Next.js backend — removed in final cleanup |
| `src/controllers/base_controller.ts` | `send_ok()`, `send_error()`, `AuthenticatedRequest`, `SessionData` types |
| `src/types/api_types.ts` | Empty shell |
| `src/types/dto.ts` | Empty shell |
| `src/types/mappers.ts` | Empty shell |

### 1d — Dependency injection

**File:** `src/container.ts`

```typescript
export interface Container {
    config: EnvConfig;
    session_store: SessionStore;
    api_client: ApiClient;
}

export async function create_container(config: EnvConfig): Promise<Container> {
    const session_store = new SessionStore(config);
    await session_store.init();  // creates bff schema + sessions table
    const api_client = new ApiClient(config.backend_url);
    return { config, session_store, api_client };
}
```

Extended in each subsequent slice with domain-specific repos/services/controllers.

### 1e — App factory + server

**File:** `src/app.ts` — `create_app(container)`: helmet, cors, json, cookie-parser, `/bff-health`, CSRF guard on `/api`, proxy fallback, error handler.

**File:** `src/server.ts` — loads env, creates container, creates app, listens, starts prune interval.

### 1f — Shared frontend utilities

Created NOW so every subsequent slice can use them immediately.

**File:** `cliqhub/lib/validation.ts` (new)

```typescript
export const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const RESERVED_SLUGS = ['local', 'prebuilt', 'cliq', 'admin', 'api', 'bff'];

export function validate_slug(value: string): string | null { ... }
export function validate_email(value: string): string | null { ... }
export function validate_password(value: string): string | null { ... }
```

**File:** `cliqhub/components/ui/api-error.tsx` (new)

```tsx
export function ApiErrorBanner({ error }: { error: string | null }) {
    if (!error) return null;
    return (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
        </div>
    );
}
```

### 1g — BFF unit tests

| File | Tests | Count |
|------|-------|-------|
| `tests/unit/repositories/session_store.test.ts` | create+find, miss, touch, destroy, destroy_user, expired, idle, prune (mocked pg.Pool) | 10 |
| `tests/unit/repositories/api_client.test.ts` | correct URL, auth header, no-auth, unwrap ok, throw ApiError, network error | 6 |
| `tests/unit/middleware/error_handler.test.ts` | ZodError→422, ApiError unauthorized→401, forbidden→403, unknown→500 | 4 |
| `tests/unit/middleware/csrf_guard.test.ts` | valid origin, invalid origin, skip GET | 3 |

### 1h — BFF integration tests

| Test | Proves |
|------|--------|
| `GET /bff-health` → 200 | Health check |
| `POST /api/anything` with bad origin → 403 | CSRF |
| `POST /api/unmigrated-route` → proxied to backend | Fallback works |

### 1i — Verify

```bash
cd cliqhub/services/bff && npm test    # 23+ tests pass
npm run dev                             # :3001/bff-health responds
# existing app still works via proxy fallback
```

---

## Slice 2 — Auth: Login, Signup, Logout, Me

**Duration:** 2–3 days
**BFF routes delivered:** 4 (`login`, `signup`, `logout`, `me`)
**Browser testable:** Login page, signup, logout, auth state — the core auth loop

### 2a — Backend test gaps for auth

**File:** `cliqhub/tests/auth-handlers.test.ts` (extend)

| Handler | New Test | Scenario |
|---------|---------|----------|
| `login` | `it('rejects suspended user')` | `suspended_at` set → `forbidden` |

(1 new test. Existing auth tests are solid — login, signup, me, tokens already covered.)

### 2b — BFF types

**`vo.ts`** — add `LoginResponseVO`, `UserVO`, `ScopeVO`

**`dto.ts`** — add `UserDTO`, `ScopeDTO`, `LoginResponseDTO`, `SessionUserDTO`

**`mappers.ts`** — add `to_user_dto()`, `to_scope_dto()`, `to_login_response_dto()`

### 2c — BFF layers

**`src/schemas/auth_schemas.ts`:**

```typescript
export const login_schema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
});
export const signup_schema = z.object({
    username: z.string().min(1).max(40),
    email: z.string().email(),
    password: z.string().min(8),
});
```

**`src/repositories/auth_repository.ts`:**

| Method | Backend Path | Backend Method |
|--------|-------------|----------------|
| `login(username, password)` | `/api/auth/login` | POST |
| `signup(username, email, password)` | `/api/auth/signup` | POST |
| `me(token)` | `/api/auth/me` | GET |

**`src/services/auth_service.ts`:**

Constructor: `(auth_repo, session_store, config)`

| Method | Logic |
|--------|-------|
| `login(username, password)` | repo.login → create PostgreSQL session → return `{session_id, dto}` |
| `signup(username, email, password)` | repo.signup → create session → return `{session_id, dto}` |
| `logout(session_id)` | await session_store.destroy |
| `me(session_data)` | return UserDTO + ScopeDTO[] from session (no backend call) |

**`src/controllers/auth_controller.ts`:**

Constructor: `(auth_service, config)`

| Method | Cookie Action |
|--------|--------------|
| `login` | Sets `cliqhub_sid` HttpOnly cookie |
| `signup` | Sets `cliqhub_sid` HttpOnly cookie |
| `logout` | Clears `cliqhub_sid` |
| `me` | — |

**`src/middleware/session_auth.ts`:**

Reads cookie → `session_store.find()` → attaches `req.session_data` or returns 401.

### 2d — Wire routes + container

Register login + signup BEFORE session guard (public).
Register logout + me AFTER session guard (authenticated).
Add `AuthRepository`, `AuthService`, `AuthController` to container.

### 2e — Frontend changes

| File | Change |
|------|--------|
| `app/login/page.tsx` | `.trim().toLowerCase()` on username before submit |
| `lib/auth-context.tsx` | `api_get('/api/auth/me')` → `api_post('/api/auth/me', {})` |
| `lib/auth-context.tsx` | Add 401 detection in `useAuthFetch` → auto-logout + redirect to `/login` |
| `lib/auth-context.tsx` | `useAuthFetch` returns parsed `{ok, data, error}` instead of raw Response |

### 2f — BFF tests

**Unit (28):**

| File | Tests | Count |
|------|-------|-------|
| `services/auth_service.test.ts` | login success, bad creds, suspended, signup, logout, me | 6 |
| `controllers/auth_controller.test.ts` | routes to service, sets cookie, clears cookie, error handling | 6 |
| `repositories/auth_repository.test.ts` | correct paths, body, token, me uses GET | 5 |
| `types/auth_mappers.test.ts` | to_user_dto, to_scope_dto, to_login_response_dto | 5 |
| `middleware/session_auth.test.ts` | valid cookie, missing, expired, idle timeout | 4 |
| `schemas/auth_schemas.test.ts` | valid/invalid for login + signup | 2 |

**Integration (8):**

| Test | Proves |
|------|--------|
| login valid → 200 + cookie | Session created |
| login bad creds → 401, no cookie | Error path |
| login suspended → 403 | Suspension check |
| signup → 200 + cookie | Signup works |
| signup short password → 422 | Zod |
| me with session → 200 | Introspection |
| me without session → 401 | Guard |
| logout → 200, cookie cleared | Session destroyed |

### 2g — Browser smoke

- Open `/login` → login → see dashboard → logout → redirected to `/login`
- Verify HttpOnly cookie in dev tools
- Verify no JWT in response body

---

## Slice 3 — Auth: Token Management

**Duration:** 1 day
**BFF routes delivered:** 3 (`create_token`, `revoke_token`, `list_tokens`)
**Browser testable:** Account → Tokens page — create, list, revoke

### 3a — Backend test gaps

**File:** `cliqhub/tests/auth-handlers.test.ts` (extend)

| Handler | New Test | Scenario |
|---------|---------|----------|
| `revoke_token` | `it('cannot revoke another user token')` | `user_id` mismatch → `deleted: false` |

### 3b — BFF types

**`vo.ts`** — add `TokenVO`
**`dto.ts`** — add `TokenDTO`
**`mappers.ts`** — add `to_token_dto()`

### 3c — BFF layers

**`src/schemas/auth_schemas.ts`** — add:

```typescript
export const create_token_schema = z.object({
    name: z.string().max(100).optional(),
});
export const revoke_token_schema = z.object({
    token_id: z.number().int().positive(),
});
```

**`auth_repository.ts`** — add `create_token`, `revoke_token`, `list_tokens`

**`auth_service.ts`** — add same 3 methods (pass-through with DTO mapping)

**`auth_controller.ts`** — add same 3 methods

### 3d — Wire routes

All 3 are authenticated (after session guard).

### 3e — Frontend changes

| File | Change |
|------|--------|
| `app/account/tokens/page.tsx` | `GET /api/auth/list_tokens` → `POST /api/auth/list_tokens` |
| `app/account/tokens/page.tsx` | Replace 3 silent `catch` blocks (`/* silently fail */`) with `ApiErrorBanner` |
| `app/account/tokens/page.tsx` | Show success message on token create (with copy button) |

### 3f — BFF tests

**Unit (10):** service, controller, repository, mapper for 3 endpoints
**Integration (3):** create → list → revoke with session

### 3g — Browser smoke

- Login → Account → Tokens → Create token → see it listed → Revoke → gone

---

## Slice 4 — Teams: Browse, Search, View, Download

**Duration:** 2 days
**BFF routes delivered:** 4 (`list`, `get`, `search`, `download`)
**Browser testable:** Public teams page, team detail page, search

### 4a — Backend test gaps

**File:** `cliqhub/tests/teams-handlers.test.ts` (extend)

| Handler | New Test | Scenario |
|---------|---------|----------|
| `list` | `it('authed user sees private teams in own scope')` | Alice sees `scope: alice` private |
| `list` | `it('authed user does not see others private teams')` | Alice cannot see `scope: bob` private |
| `search` | `it('authed user visibility matches list')` | Same rules as list |
| `download` | `it('rejects private team for non-scope-member')` | → `not_found` |

### 4b — BFF types

**`vo.ts`** — add `TeamListItemVO`, `TeamDetailVO`, `TeamVersionVO`
**`dto.ts`** — add `TeamListItemDTO`, `TeamDetailDTO`, `TeamVersionDTO`
**`mappers.ts`** — add `to_team_list_item_dto()`, `to_team_detail_dto()`, `to_team_version_dto()`

### 4c — BFF layers

**`src/schemas/teams_schemas.ts`:**

```typescript
export const teams_list_schema = z.object({
    domain: z.string().optional(), tag: z.string().optional(),
    limit: z.number().int().max(100).optional(), offset: z.number().int().optional(),
});
export const teams_get_schema = z.object({
    name: z.string().min(1), scope: z.string().optional(),
});
export const teams_search_schema = z.object({
    query: z.string().min(1), domain: z.string().optional(),
    limit: z.number().int().max(100).optional(),
});
export const teams_download_schema = z.object({
    name: z.string().min(1), scope: z.string().optional(),
    version: z.string().optional(),
});
```

**`repositories/teams_repository.ts`** — 4 methods, all paths unchanged
**`services/teams_service.ts`** — pass-through with DTO mapping
**`controllers/teams_controller.ts`** — 4 methods

### 4d — Wire routes

`list`, `get`, `search` are public (before session guard — browsing without login).
`download` is authenticated.

### 4e — Frontend changes

None in this sub-slice — these routes are consumed by the public browse pages and CLI. The browse pages currently use SSR direct DB queries; SSR migration happens later in Slice 11.

### 4f — BFF tests

**Unit (20):** service, controller, repository, mappers × 4 endpoints
**Integration (5):** list→200, search with query, search missing query→422, get team, download

### 4g — Browser smoke

- Existing browse pages still work (via proxy fallback or direct SSR)
- Hit BFF endpoints directly with curl to confirm they work

---

## Slice 5 — Teams: Publish, Rename, Delete, Toggle

**Duration:** 2 days
**BFF routes delivered:** 4 (`publish`, `delete`, `rename`, `toggle_listed`)
**Browser testable:** Builder → publish, Account → my teams (rename, toggle, delete)

### 5a — Backend test gaps

**File:** `cliqhub/tests/teams-handlers.test.ts` (extend)

| Handler | New Tests | Count |
|---------|----------|-------|
| `publish` | rejects non-owner publish to existing team | 1 |
| `publish_check` | unauthed, missing params, invalid slug, invalid semver, wrong scope, non-author, version conflict, new team, valid bump | 9 |
| `rename_team` | unauthed, invalid slug, same name, not found, non-owner, admin override, name conflict, success + package patch | 8 |
| `delete_team` | admin override for non-owned team | 1 |
| `toggle_listed` | admin override for non-owned team | 1 |

(20 new backend tests)

### 5b — BFF types + schemas

**`dto.ts`** — add `PublishResultDTO`
**`mappers.ts`** — add `to_publish_result_dto()`

**`src/schemas/teams_schemas.ts`** — add:

```typescript
export const teams_publish_schema = z.object({
    name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
    scope: z.string().optional(), version: z.string().optional(),
    bump: z.enum(['patch', 'minor', 'major']).optional(),
    data_base64: z.string().min(1), changelog: z.string().optional(),
    readme: z.string().optional(),
});
export const teams_delete_schema = z.object({
    name: z.string().min(1), scope: z.string().optional(),
});
export const teams_rename_schema = z.object({
    name: z.string().min(1), scope: z.string().min(1),
    new_name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
});
export const teams_toggle_listed_schema = z.object({
    name: z.string().min(1), scope: z.string().optional(),
});
```

### 5c — BFF layers

**`teams_repository.ts`** — add 4 methods

| Method | Backend Path |
|--------|-------------|
| `publish` | `/api/teams/publish` (unchanged) |
| `delete_team` | `/api/teams/delete` (unchanged) |
| `rename` | `/api/teams/rename` (unchanged) |
| `toggle_listed` | `/api/teams/toggle-listed` (BFF: `toggle_listed`) |

**`teams_service.ts`** — add 4 methods
**`teams_controller.ts`** — add 4 methods

### 5d — Wire routes

All 4 authenticated (after session guard).

### 5e — Frontend changes

| File | Change |
|------|--------|
| `components/builder/publish-dialog.tsx` | Add `validate_slug(name)` (from `lib/validation.ts`) before submit; show inline error |
| `components/rename-team-button.tsx` | Add `validate_slug(new_name)` before submit; show inline error |
| `components/danger-zone.tsx` | Already has good error handling — no changes |
| `app/account/teams/page.tsx` | Replace 4 silent `catch` blocks with `ApiErrorBanner` display |
| `app/account/teams/page.tsx` | Add `confirm()` dialog before toggle listed/unlisted |
| `app/account/teams/page.tsx` | Update URL: `/api/teams/toggle-listed` → `/api/teams/toggle_listed` |

### 5f — BFF tests

**Unit (20):** service, controller, repository, mapper × 4 endpoints + schema validation
**Integration (7):** publish success, publish non-owner→403, delete owner, delete non-owner→403, delete admin→200, rename invalid slug→422, toggle→200

### 5g — Browser smoke

- Login → Builder → generate team → publish → see in my teams
- My teams → rename → new name visible
- My teams → toggle listed → confirmation → toggled
- My teams → danger zone → type confirm → delete

---

## Slice 6 — Teams: My Teams, Versions, Batch

**Duration:** 1 day
**BFF routes delivered:** 4 (`list_mine`, `list_mine_all`, `get_latest_version`, `batch_latest`)
**Browser testable:** Scope page (my teams), publish dialog (version check)

### 6a — Backend test gaps

**File:** `cliqhub/tests/teams-handlers.test.ts` (extend)

| Handler | New Tests | Count |
|---------|----------|-------|
| `list_all_my_teams` | unauthed, multi-scope, zero-scope, empty | 4 |

### 6b — BFF layers

**`teams_repository.ts`** — add 4 methods with path translation:

| Method | Backend Path |
|--------|-------------|
| `list_mine` | `/api/teams/mine` |
| `list_mine_all` | `/api/teams/mine-all` |
| `get_latest_version` | `/api/teams/latest-version` |
| `batch_latest` | `/api/teams/batch-latest` |

**`src/schemas/teams_schemas.ts`** — add:

```typescript
export const teams_list_mine_schema = z.object({ scope: z.string().optional() });
export const teams_get_latest_version_schema = z.object({
    name: z.string().min(1), scope: z.string().optional(),
});
export const teams_batch_latest_schema = z.object({
    teams: z.array(z.object({ name: z.string(), scope: z.string().optional() })).min(1).max(100),
});
```

### 6c — Frontend changes

| File | Change |
|------|--------|
| `app/teams/s/[slug]/page.tsx` | Update URL: `/api/teams/mine` → `/api/teams/list_mine` |
| `app/account/teams/page.tsx` | Update URL: `/api/teams/mine-all` → `/api/teams/list_mine_all` |
| `components/builder/publish-dialog.tsx` | Update URL: `/api/teams/latest-version` → `/api/teams/get_latest_version` |

### 6d — BFF tests

**Unit (16):** 4 endpoints × (service, controller, repository, schema)
**Integration (4):** list_mine, list_mine_all, get_latest_version, batch_latest

### 6e — Browser smoke

- Login → scope page → see my teams
- Login → account → my teams → see all teams across scopes
- Login → builder → open publish dialog → version check fetches latest

**All 12 team routes now complete.**

---

## Slice 7 — Drafts

**Duration:** 1–2 days
**BFF routes delivered:** 4 (`list`, `get`, `save`, `delete`)
**Browser testable:** Account → My Teams → Drafts tab, Builder → save/load

### 7a — Backend test gaps

**File:** `cliqhub/tests/drafts-handlers.test.ts` (extend)

| Handler | New Test | Scenario |
|---------|---------|----------|
| `get_draft` | `it('user A cannot access user B draft')` | Wrong user_id → `not_found` |
| `save_draft` | `it('user A cannot update user B draft')` | → `not_found` |
| `delete_draft` | `it('user A cannot delete user B draft')` | → `not_found` |

### 7b — BFF types

**`dto.ts`** — add `DraftListItemDTO`, `DraftDetailDTO`

### 7c — BFF layers + schemas

**`src/schemas/drafts_schemas.ts`:**

```typescript
export const drafts_get_schema = z.object({ id: z.number().int().positive() });
export const drafts_save_schema = z.object({
    id: z.number().int().optional(), title: z.string().optional(),
    team_json: z.string().min(1),
});
export const drafts_delete_schema = z.object({ id: z.number().int().positive() });
```

**Repository, service, controller** — 4 methods each. All paths unchanged.

### 7d — Frontend changes

| File | Change |
|------|--------|
| `components/builder/builder-shell.tsx` | Replace silent `catch(() => {})` on draft load with error state display |
| `components/builder/save-button.tsx` | Replace silent `catch` with visible "Save failed" indicator + retry button |
| `components/builder/save-button.tsx` | Auto-save failure shows amber "Unsaved changes" badge |

### 7e — BFF tests

**Unit (16):** 4 endpoints × 4 layers
**Integration (5):** list, get, save (create+update), delete, cross-user isolation (user A → user B → 404)

### 7f — Browser smoke

- Login → Builder → generate → save → reload page → draft persists
- Login → Account → My Teams → Drafts tab → see drafts → delete one

---

## Slice 8 — Builder (AI Endpoints)

**Duration:** 1 day
**BFF routes delivered:** 4 (`generate`, `improve_role`, `validate`, `chat`)
**Browser testable:** Builder → Spark page, chat panel, role editor, validation bar

### 8a — Backend test gaps

None — builder handlers already have tests.

### 8b — BFF types + schemas

**`dto.ts`** — add `BuilderGenerateDTO`, `BuilderChatDTO`, `BuilderValidationDTO`, `BuilderImproveDTO`

**`src/schemas/builder_schemas.ts`:**

```typescript
export const builder_generate_schema = z.object({ intent: z.string().min(1).max(2000) });
export const builder_improve_role_schema = z.object({
    role_name: z.string().min(1), content_md: z.string().min(1),
    team_context: z.unknown().optional(),
});
export const builder_validate_schema = z.object({ team: z.unknown() });
export const builder_chat_schema = z.object({
    message: z.string().min(1).max(4000), team: z.unknown(),
    history: z.array(z.unknown()).optional(),
});
```

### 8c — BFF layers

Repository path translation: `improve-role` → `improve_role` (BFF path is snake_case, backend is hyphenated).

Builder routes are **public** (registered before session guard) but **rate-limited**.

### 8d — Frontend changes

| File | Change |
|------|--------|
| `components/builder/phase-editor.tsx` | Update URL: `/api/builder/improve-role` → `/api/builder/improve_role` |
| `components/builder/phase-editor.tsx` | Replace silent `catch` with "Improve failed — try again" message |
| `components/builder/role-editor.tsx` | Update URL: `/api/builder/improve-role` → `/api/builder/improve_role` |
| `components/builder/role-editor.tsx` | Replace silent `catch` with "Improve failed — try again" message |
| `components/builder/validation-bar.tsx` | Replace silent `catch` with "Validation unavailable" message |

### 8e — BFF tests

**Unit (16):** 4 endpoints × 4 layers
**Integration (4):** generate without session (public), generate rate limited→429, improve_role, chat

### 8f — Browser smoke

- Open builder without login → generate works (public)
- Login → builder → improve role → see improved content
- Validation bar runs without silent failure

**All 8 draft + builder routes now complete.**

---

## Slice 9 — Orgs: Core (List, View, Update, Leave)

**Duration:** 1–2 days
**BFF routes delivered:** 4 (`list`, `get`, `update`, `leave`)
**Browser testable:** Account → Orgs page, Org detail page

### 9a — Backend test gaps

None for these 4 — already tested in `orgs-handlers.test.ts`.

### 9b — BFF types

**`dto.ts`** — add `OrgListItemDTO`, `OrgDetailDTO`, `OrgMemberDTO`, `OrgScopeDTO`

### 9c — BFF layers + schemas

**`src/schemas/orgs_schemas.ts`:**

```typescript
export const orgs_get_schema = z.object({ org_id: z.number().int().positive() });
export const orgs_update_schema = z.object({
    org_id: z.number().int().positive(), display_name: z.string().min(1),
});
export const orgs_leave_schema = z.object({ org_id: z.number().int().positive() });
```

Repository: `list` and `get` paths unchanged. `update` and `leave` paths unchanged.

### 9d — Frontend changes

| File | Change |
|------|--------|
| `app/account/orgs/page.tsx` | Replace silent `catch` on org list with `ApiErrorBanner` |
| `app/account/orgs/[id]/page.tsx` | Show backend error on `leave_org` ("cannot leave as last admin") |
| `app/account/orgs/[id]/page.tsx` | Add `try/catch` on org load |

### 9e — BFF tests

**Unit (16):** 4 endpoints × 4 layers
**Integration (4):** list, get as member, get as non-member→403, leave last admin→error

### 9f — Browser smoke

- Login as alice → Account → Orgs → see org list → click org → see detail
- Try leave when last admin → error shown

---

## Slice 10 — Orgs: Members (Add, Remove, Set Role)

**Duration:** 1–2 days
**BFF routes delivered:** 3 (`add_member`, `remove_member`, `set_member_role`)
**Browser testable:** Org detail page — member management section

### 10a — Backend test gaps

**File:** `cliqhub/tests/orgs-handlers.test.ts` (extend)

| Handler | New Test | Scenario |
|---------|---------|----------|
| `set_member_role` | `it('rejects invalid role value')` | `role: 'owner'` → `invalid_params` |
| `set_member_role` | `it('rejects member not found')` | → `not_found` |

### 10b — BFF layers + schemas

**`src/schemas/orgs_schemas.ts`** — add:

```typescript
export const orgs_add_member_schema = z.object({
    org_id: z.number().int().positive(), username: z.string().min(1),
});
export const orgs_remove_member_schema = z.object({
    org_id: z.number().int().positive(), user_id: z.number().int().positive(),
});
export const orgs_set_member_role_schema = z.object({
    org_id: z.number().int().positive(), user_id: z.number().int().positive(),
    role: z.enum(['admin', 'member']),
});
```

**Repository path translation:**

| BFF method | Backend path |
|-----------|-------------|
| `add_member` | `/api/orgs/members/add` |
| `remove_member` | `/api/orgs/members/remove` |
| `set_member_role` | `/api/orgs/members/set-role` |

### 10c — Frontend changes

| File | Change |
|------|--------|
| `app/account/orgs/[id]/page.tsx` | Add `validate_slug` on add member username input |
| `app/account/orgs/[id]/page.tsx` | Add `try/catch` + `ApiErrorBanner` on `remove_member` (currently no catch) |
| `app/account/orgs/[id]/page.tsx` | Add `try/catch` + `ApiErrorBanner` on `set_member_role` (currently no catch) |
| `app/account/orgs/[id]/page.tsx` | Update URLs: `/api/orgs/members/add` → `/api/orgs/add_member`, etc. |
| `app/admin/orgs/[id]/page.tsx` | Same URL + error handling fixes |

### 10d — BFF tests

**Unit (12):** 3 endpoints × 4 layers
**Integration (5):** add as admin, add as member→403, remove, remove last admin→error, set_role invalid→422

### 10e — Browser smoke

- Login as alice (org admin) → org → add member → see member appear → change role → remove member

---

## Slice 11 — Orgs: Scopes (Create, Delete, Assign, Unassign)

**Duration:** 1–2 days
**BFF routes delivered:** 4 (`create_scope`, `delete_scope`, `assign_scope_member`, `unassign_scope_member`)
**Browser testable:** Org detail page — scope management section

### 11a — Backend test gaps

**File:** `cliqhub/tests/orgs-handlers.test.ts` (extend)

| Handler | New Test | Scenario |
|---------|---------|----------|
| `unassign_scope_member` | `it('rejects non-org-admin')` | → `forbidden` |
| `unassign_scope_member` | `it('rejects scope not in org')` | → `not_found` |
| `delete_org_scope` | `it('rejects non-org-admin')` | → `forbidden` |

### 11b — BFF layers + schemas

**`src/schemas/orgs_schemas.ts`** — add:

```typescript
export const orgs_create_scope_schema = z.object({
    org_id: z.number().int().positive(),
    slug: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
    display_name: z.string().optional(),
    visibility: z.enum(['public', 'private']).optional(),
});
export const orgs_delete_scope_schema = z.object({
    org_id: z.number().int().positive(), scope_id: z.number().int().positive(),
});
export const orgs_assign_scope_member_schema = z.object({
    org_id: z.number().int().positive(), scope_id: z.number().int().positive(),
    user_id: z.number().int().positive(),
});
export const orgs_unassign_scope_member_schema = z.object({
    org_id: z.number().int().positive(), scope_id: z.number().int().positive(),
    user_id: z.number().int().positive(),
});
```

**Repository path translation:**

| BFF method | Backend path |
|-----------|-------------|
| `create_scope` | `/api/orgs/scopes/create` |
| `delete_scope` | `/api/orgs/scopes/delete` |
| `assign_scope_member` | `/api/orgs/scopes/assign` |
| `unassign_scope_member` | `/api/orgs/scopes/unassign` |

### 11c — Frontend changes

| File | Change |
|------|--------|
| `app/account/orgs/[id]/page.tsx` | Show backend error on `delete_scope` ("has N teams") |
| `app/account/orgs/[id]/page.tsx` | Add `try/catch` + `ApiErrorBanner` on assign/unassign (currently no catch) |
| `app/account/orgs/[id]/page.tsx` | Update URLs: `/api/orgs/scopes/create` → `/api/orgs/create_scope`, etc. |
| `app/admin/orgs/[id]/page.tsx` | Same URL + error handling fixes |

### 11d — BFF tests

**Unit (16):** 4 endpoints × 4 layers
**Integration (5):** create scope, create invalid slug→422, delete scope with teams→error, assign, unassign non-admin→403

### 11e — Browser smoke

- Login as org admin → create scope → assign member to scope → unassign → delete scope
- Try delete scope that has teams → error shown

**All 11 org routes now complete.**

---

## Slice 12 — Account: Profile + Password

**Duration:** 1–2 days
**BFF routes delivered:** 2 (`update_profile`, `change_password`)
**Browser testable:** Account → Settings page

### 12a — Backend test gaps (new file)

**File:** `cliqhub/tests/account-handlers.test.ts` (new)

| Handler | Test | Scenario |
|---------|------|----------|
| `update_profile` | rejects unauthenticated | → `unauthorized` |
| `update_profile` | returns unchanged when no params | → `{updated: false}` |
| `update_profile` | rejects invalid email | → `invalid_params` |
| `update_profile` | rejects email conflict | → `conflict` |
| `update_profile` | rejects display name too long | >100 → `invalid_params` |
| `update_profile` | rejects empty display name | '' → `invalid_params` |
| `update_profile` | updates display name only | → success |
| `update_profile` | updates email only | → success |
| `update_profile` | updates both fields | → success |
| `change_password` | rejects unauthenticated | → `unauthorized` |
| `change_password` | rejects missing params | → `invalid_params` |
| `change_password` | rejects short new password | <8 → `invalid_params` |
| `change_password` | rejects wrong current password | → `forbidden` |
| `change_password` | changes password on success | → success |

(14 new backend tests)

### 12b — BFF layers + schemas

**`src/schemas/account_schemas.ts`:**

```typescript
export const update_profile_schema = z.object({
    display_name: z.string().min(1).max(100).optional(),
    email: z.string().email().optional(),
});
export const change_password_schema = z.object({
    current_password: z.string().min(1),
    new_password: z.string().min(8),
});
```

**Repository path translation:**

| BFF method | Backend path |
|-----------|-------------|
| `update_profile` | `/api/account/update-profile` |
| `change_password` | `/api/account/change-password` |

### 12c — Frontend changes

| File | Change |
|------|--------|
| `app/account/settings/page.tsx` | Add `validate_email()` for email field |
| `app/account/settings/page.tsx` | Add max 100 char check for display_name |
| `app/account/settings/page.tsx` | Trim fields before dirty check |
| `app/account/settings/page.tsx` | Update URL: `/api/account/update-profile` → `/api/account/update_profile` |
| `app/account/settings/page.tsx` | Update URL: `/api/account/change-password` → `/api/account/change_password` |
| `app/account/settings/page.tsx` | Add `try/catch` on both forms (currently no catch at all) |

### 12d — BFF tests

**Unit (10):** 2 endpoints × 5 (service, controller, repository, mapper, schema)
**Integration (4):** update profile, duplicate email→409, change password wrong current→403, change password short→422

### 12e — Browser smoke

- Login → Settings → change display name → success message
- Change email to duplicate → error shown
- Change password with wrong current → error shown
- Change password correctly → success

---

## Slice 13 — HUG Integration

**Duration:** 1 day
**BFF routes delivered:** 2 (`get_token_status`, `generate_token`)
**Browser testable:** Account → Settings → HUG section

### 13a — Backend test gaps (new file)

**File:** `cliqhub/tests/hug-handlers.test.ts` (new)

| Handler | Test | Scenario |
|---------|------|----------|
| `generate_hug_token` | rejects unauthenticated | → `unauthorized` |
| `generate_hug_token` | returns error when HUG not configured | → error |
| `generate_hug_token` | returns error when HUG server fails | upstream 500 → error |
| `generate_hug_token` | returns error when HUG unreachable | fetch throws → error |
| `generate_hug_token` | returns token on success | → `{token, server_url}` |
| `get_hug_status` | rejects unauthenticated | → `unauthorized` |
| `get_hug_status` | returns configured true | env set → `{configured: true}` |
| `get_hug_status` | returns configured false | no env → `{configured: false}` |

(8 new backend tests)

### 13b — BFF types + layers

**`dto.ts`** — add `HugStatusDTO`, `HugTokenDTO`

**Repository path translation:**

| BFF method | Backend path | Backend method |
|-----------|-------------|----------------|
| `get_token_status` | `/api/hug/token` | GET |
| `generate_token` | `/api/hug/token/generate` | POST |

### 13c — Frontend changes

| File | Change |
|------|--------|
| `app/account/settings/page.tsx` | Update URL: `/api/hug/token` → `/api/hug/get_token_status` (and change to POST) |
| `app/account/settings/page.tsx` | Update URL: `/api/hug/token/generate` → `/api/hug/generate_token` |
| `app/account/settings/page.tsx` | Replace silent `catch` on HUG status with "HUG unavailable" text |

### 13d — BFF tests

**Unit (8):** 2 endpoints × 4 layers
**Integration (3):** get status, generate success, generate not configured→error

### 13e — Browser smoke

- Login → Settings → HUG section shows status
- Generate HUG token → token displayed

**Account + HUG complete.**

---

## Slice 14 — Admin: Dashboard + Audit

**Duration:** 1 day
**BFF routes delivered:** 2 (`stats`, `audit`)
**Browser testable:** Admin dashboard, Admin → Audit log

### 14a — Backend test gaps

None — `admin_stats` and `admin_audit_log` already tested.

### 14b — BFF types + layers

**`dto.ts`** — add `StatsDTO`, `AuditLogEntryDTO`

Service: check `session_data.role === 'admin'` → throw `ApiError('forbidden')` if not. This is defense-in-depth (backend also checks).

### 14c — Frontend changes

| File | Change |
|------|--------|
| `app/admin/page.tsx` | Update URL if path changes (stats path unchanged) |
| `app/admin/audit/page.tsx` | Add `try/catch` on audit log load (currently no catch at all) |

### 14d — BFF tests

**Unit (8):** 2 endpoints × 4 layers
**Integration (4):** stats 401 (no session), stats 403 (non-admin), stats 200 (admin), audit 200

### 14e — Browser smoke

- Login as admin → Admin dashboard → see stats
- Admin → Audit → see log entries

---

## Slice 15 — Admin: User Management

**Duration:** 2–3 days
**BFF routes delivered:** 7 (`list_users`, `get_user`, `create_user`, `update_user`, `suspend_user`, `unsuspend_user`, `delete_user`)
**Browser testable:** Admin → Users page — full CRUD + suspend/unsuspend

### 15a — Backend test gaps

**File:** `cliqhub/tests/admin-users.test.ts` (extend)

| Handler | New Tests | Count |
|---------|----------|-------|
| `create_user` | non-admin, missing fields, short pw, invalid slug, reserved username, invalid email, duplicate, success + audit | 8 |
| `update_user` | non-admin, not found, invalid email, email conflict, empty display, no changes, success + audit | 7 |
| `unsuspend_user` | non-admin, not found | 2 |

(17 new backend tests)

### 15b — BFF types

**`dto.ts`** — add `AdminUserDTO`, `AdminUserDetailDTO`

### 15c — BFF layers + schemas

**`src/schemas/admin_schemas.ts`:**

```typescript
export const admin_list_users_schema = z.object({
    search: z.string().optional(), limit: z.number().int().optional(),
    offset: z.number().int().optional(),
});
export const admin_get_user_schema = z.object({ user_id: z.number().int().positive() });
export const admin_create_user_schema = z.object({
    username: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
    email: z.string().email(), password: z.string().min(8),
    role: z.enum(['user', 'admin']).optional(),
});
export const admin_update_user_schema = z.object({
    user_id: z.number().int().positive(),
    display_name: z.string().min(1).optional(),
    email: z.string().email().optional(),
});
export const admin_suspend_user_schema = z.object({
    user_id: z.number().int().positive(), reason: z.string().optional(),
});
export const admin_unsuspend_user_schema = z.object({ user_id: z.number().int().positive() });
export const admin_delete_user_schema = z.object({ user_id: z.number().int().positive() });
```

**Repository path translation:**

| BFF method | Backend path |
|-----------|-------------|
| `list_users` | `/api/admin/users` |
| `get_user` | `/api/admin/users/get` |
| `create_user` | `/api/admin/users/create` |
| `update_user` | `/api/admin/users/update` |
| `suspend_user` | `/api/admin/users/suspend` |
| `unsuspend_user` | `/api/admin/users/unsuspend` |
| `delete_user` | `/api/admin/users/delete` |

### 15d — Frontend changes

| File | Change |
|------|--------|
| `app/admin/users/page.tsx` | Add `validate_slug` for username in create form |
| `app/admin/users/page.tsx` | Add `validate_email` for email in create/edit forms |
| `app/admin/users/page.tsx` | Add `type="password"` on password fields |
| `app/admin/users/page.tsx` | Add `try/catch` on `load_users` and `open_detail` (currently no catch — network error = crash) |
| `app/admin/users/page.tsx` | Refactor `do_action('suspend', ...)` → `auth_fetch('/api/admin/suspend_user', ...)` (named routes, not template string) |
| `app/admin/users/page.tsx` | Same for `unsuspend`, `delete` |
| `app/admin/users/page.tsx` | Update URLs: `/api/admin/users` → `/api/admin/list_users`, `/api/admin/users/get` → `/api/admin/get_user`, etc. |

### 15e — BFF tests

**Unit (28):** 7 endpoints × 4 layers
**Integration (8):** 401, 403, create user, create invalid slug→422, update, suspend, unsuspend, delete

### 15f — Browser smoke

- Login as admin → Users → Create user → see in list → Edit → Suspend → Unsuspend → Delete

---

## Slice 16 — Admin: User Role + Password Reset

**Duration:** 1 day
**BFF routes delivered:** 2 (`set_user_role`, `reset_user_password`)
**Browser testable:** Admin → Users → role change + password reset

### 16a — BFF layers + schemas

**`src/schemas/admin_schemas.ts`** — add:

```typescript
export const admin_set_user_role_schema = z.object({
    user_id: z.number().int().positive(), role: z.enum(['user', 'admin']),
});
export const admin_reset_user_password_schema = z.object({
    user_id: z.number().int().positive(), new_password: z.string().min(8),
});
```

**Repository path translation:**

| BFF method | Backend path |
|-----------|-------------|
| `set_user_role` | `/api/admin/users/set-role` |
| `reset_user_password` | `/api/admin/users/reset-password` |

### 16b — Frontend changes

| File | Change |
|------|--------|
| `app/admin/users/page.tsx` | Refactor `do_action('set-role', ...)` → `auth_fetch('/api/admin/set_user_role', ...)` |
| `app/admin/users/page.tsx` | Add confirmation dialog for role change (promote/demote) |
| `app/admin/users/page.tsx` | Refactor `do_action('reset-password', ...)` → `auth_fetch('/api/admin/reset_user_password', ...)` |
| `app/admin/users/page.tsx` | Change password input to `type="password"` in reset modal |

### 16c — BFF tests

**Unit (8):** 2 endpoints × 4 layers
**Integration (3):** set role success, set role self-demotion→403, reset password

### 16d — Browser smoke

- Login as admin → Users → Promote user → confirmation dialog → confirm → role changed
- Reset password → new password set

**Admin user management complete (9 routes).**

---

## Slice 17 — Admin: Teams + Tokens

**Duration:** 1 day
**BFF routes delivered:** 4 (`list_teams`, `set_team_listed`, `list_tokens`, `revoke_token`)
**Browser testable:** Admin → Teams page, Admin → Tokens page

### 17a — BFF types

**`dto.ts`** — add `AdminTeamDTO`, `AdminTokenDTO`

### 17b — Frontend changes

| File | Change |
|------|--------|
| `app/admin/teams/page.tsx` | Update URLs: `/api/admin/teams` → `/api/admin/list_teams`, `/api/admin/teams/set-listed` → `/api/admin/set_team_listed` |
| `app/admin/teams/page.tsx` | Add `try/catch` on load (currently no catch) |
| `app/admin/tokens/page.tsx` | Update URLs: `/api/admin/tokens` → `/api/admin/list_tokens`, `/api/admin/tokens/revoke` → `/api/admin/revoke_token` |
| `app/admin/tokens/page.tsx` | Add `try/catch` on load (currently no catch) |

### 17c — BFF tests

**Unit (16):** 4 endpoints × 4 layers
**Integration (4):** list teams, set_team_listed, list tokens, revoke token

### 17d — Browser smoke

- Admin → Teams → toggle listed
- Admin → Tokens → see all tokens → revoke one

---

## Slice 18 — Admin: Scopes

**Duration:** 1 day
**BFF routes delivered:** 4 (`list_scopes`, `create_scope`, `update_scope`, `delete_scope`)
**Browser testable:** Admin → Scopes page

### 18a — BFF types

**`dto.ts`** — add `AdminScopeDTO`

### 18b — Frontend changes

| File | Change |
|------|--------|
| `app/admin/scopes/page.tsx` | Add `validate_slug` for scope slug |
| `app/admin/scopes/page.tsx` | Update URLs: `/api/admin/scopes` → `/api/admin/list_scopes`, etc. |
| `app/admin/scopes/page.tsx` | Add `try/catch` on load (currently no catch) |

### 18c — BFF tests

**Unit (16):** 4 endpoints × 4 layers
**Integration (4):** list, create, update, delete (with type-to-confirm)

### 18d — Browser smoke

- Admin → Scopes → create scope → update display name → delete (type `@slug` to confirm)

---

## Slice 19 — Admin: Orgs

**Duration:** 1–2 days
**BFF routes delivered:** 3 (`list_orgs`, `create_org`, `delete_org`)
**Browser testable:** Admin → Orgs page, Admin → Org detail page

### 19a — BFF types

**`dto.ts`** — add `AdminOrgDTO`

### 19b — Frontend changes

| File | Change |
|------|--------|
| `app/admin/orgs/page.tsx` | Add `validate_slug` for org slug |
| `app/admin/orgs/page.tsx` | Add `validate_email` + `type="password"` for inline user creation |
| `app/admin/orgs/page.tsx` | Update URLs: `/api/admin/orgs` → `/api/admin/list_orgs`, `/api/admin/orgs/create` → `/api/admin/create_org` |
| `app/admin/orgs/page.tsx` | Add `try/catch` on load (currently no catch) |
| `app/admin/orgs/[id]/page.tsx` | Update URL: `/api/admin/orgs/delete` → `/api/admin/delete_org` |
| `app/admin/orgs/[id]/page.tsx` | Show errors on assign/unassign scope member (currently no catch) |
| `app/admin/orgs/[id]/page.tsx` | Update all org member/scope URLs (already done in user-facing org slices, but admin page has its own calls) |

### 19c — BFF tests

**Unit (12):** 3 endpoints × 4 layers
**Integration (3):** list orgs, create org, delete org (type slug to confirm)

### 19d — Browser smoke

- Admin → Orgs → create org → see in list → click → manage → delete

**All 22 admin routes now complete.**

---

## Slice 20 — SSR Migration + Silent Catch Sweep

**Duration:** 2 days
**BFF routes delivered:** 0 (frontend-only)
**Browser testable:** Team browse pages, team detail pages

### 20a — SSR pages

| Page | Before | After |
|------|--------|-------|
| `/teams` | `query()` direct DB | `fetch('http://bff:3001/api/teams/list')` server-side |
| `/teams/[scope]/[name]` | `get_team()` direct DB | `fetch('http://bff:3001/api/teams/get')` server-side |
| `/admin/teams/[scope]/[name]` | `get_team()` direct DB | Same + forward cookie |
| `/account/teams/[scope]/[name]` | `get_team()` direct DB | Same + forward cookie |

Authenticated SSR forwards the browser's cookie:

```typescript
import { cookies } from 'next/headers';
const cookie_store = await cookies();
const session = cookie_store.get('cliqhub_sid');
// pass Cookie header in fetch
```

### 20b — Remove dead imports

- Delete `lib/get-team.ts`
- Remove all direct `lib/db` imports from Next.js page components

### 20c — Final silent catch sweep

Walk every page and verify:
- Every `catch` block displays error to user via `ApiErrorBanner`, OR
- Logs to console + shows fallback UI (never empty state with no explanation)

### 20d — Browser smoke

- Open `/teams` → public teams rendered
- Open `/teams/alice/my-team` → team detail rendered
- Unauthenticated SSR → public data
- Authenticated SSR → private data visible

---

## Slice 21 — CLI + nginx

**Duration:** 1 day
**BFF routes delivered:** 0 (infra only)

### 21a — CLI changes

**File:** `cliq/src/commands/hub_command.ts`

| Change | Before | After |
|--------|--------|-------|
| Path rename | `'/teams/batch-latest'` | `'/teams/batch_latest'` |
| Add header | — | `'X-Client': 'cli'` on all requests |

### 21b — Backend route rename

Rename `cliqhub/app/api/teams/batch-latest/` → `batch_latest/` (or add redirect).

### 21c — nginx config

```nginx
location /api/ {
    if ($http_x_client = "cli") {
        proxy_pass http://nextjs:3000;
        break;
    }
    proxy_pass http://bff:3001;
}
```

### 21d — Tests

- CLI unit test: `_post` sends `X-Client: cli` header
- CLI unit test: `_post` builds correct path for `batch_latest`
- Manual: `cliq hub login` → `cliq hub search` → `cliq hub install`

---

## Slice 22 — E2E Automation + Cleanup

**Duration:** 3–4 days
**Browser testable:** Full Playwright suite

### 22a — Playwright setup

`cliqhub/services/bff/playwright.config.ts`

### 22b — E2E tests (29 tests)

| Suite | Tests | Count |
|-------|-------|-------|
| `auth.spec.ts` | Login valid, login wrong pw, login suspended, logout | 4 |
| `teams.spec.ts` | Browse, search, view detail, publish, rename, delete | 6 |
| `drafts.spec.ts` | Draft lifecycle, save failure shows error, delete draft | 3 |
| `orgs.spec.ts` | View as member, add member, last admin blocked, create scope, delete scope with teams | 5 |
| `account.spec.ts` | Update profile, change password, token management | 3 |
| `admin.spec.ts` | User CRUD+suspend, org management, non-admin blocked, role change confirmation, password reset | 5 |
| `rbac.spec.ts` | Session timeout, non-owner team delete, org member cannot manage | 3 |

### 22c — Cleanup

| Task | Detail |
|------|--------|
| Remove 6 dead Next.js route files | `get_version`, `versions`, `delete-version`, `suggest`, `admin/teams/delete`, `admin/teams/transfer` |
| Remove old BFF proxy code | `proxy.ts`, old `session_routes.ts`, old `session_guard.ts` |
| Remove proxy fallback | Delete `proxy_fallback.ts`, remove from `app.ts` |
| Update Railway config | BFF service entrypoint |
| Update docker-compose | BFF DATABASE_URL env var |
| Update root `package.json` | BFF in `concurrently` dev script |
| Update CI | All 3 test tiers |

### 22d — Final verification

```bash
cd cliqhub/services/bff && npm test          # BFF unit + integration
cd cliqhub && npm test                        # backend tests
cd cliq && npm test                           # CLI tests
cd cliqhub/services/bff && npx playwright test # E2E
```

---

## Summary

| Slice | Scope | Routes | Duration |
|-------|-------|--------|----------|
| 1 | Scaffold BFF + utilities | 1 (health) | 2–3 days |
| 2 | Auth: login, signup, logout, me | 4 | 2–3 days |
| 3 | Auth: token management | 3 | 1 day |
| 4 | Teams: browse, search, view, download | 4 | 2 days |
| 5 | Teams: publish, rename, delete, toggle | 4 | 2 days |
| 6 | Teams: my teams, versions, batch | 4 | 1 day |
| 7 | Drafts | 4 | 1–2 days |
| 8 | Builder (AI) | 4 | 1 day |
| 9 | Orgs: core (list, view, update, leave) | 4 | 1–2 days |
| 10 | Orgs: members | 3 | 1–2 days |
| 11 | Orgs: scopes | 4 | 1–2 days |
| 12 | Account: profile + password | 2 | 1–2 days |
| 13 | HUG integration | 2 | 1 day |
| 14 | Admin: dashboard + audit | 2 | 1 day |
| 15 | Admin: user CRUD + suspend | 7 | 2–3 days |
| 16 | Admin: role + password reset | 2 | 1 day |
| 17 | Admin: teams + tokens | 4 | 1 day |
| 18 | Admin: scopes | 4 | 1 day |
| 19 | Admin: orgs | 3 | 1–2 days |
| 20 | SSR + silent catch sweep | 0 | 2 days |
| 21 | CLI + nginx | 0 | 1 day |
| 22 | E2E + cleanup | 0 | 3–4 days |
| **Total** | | **64 + 1 health** | **~6–8 weeks** |

**Backend test gaps fixed along the way:** ~75 new tests spread across slices 2–16.

**Parallelization:** After slice 3 (auth complete), slices 4–13 can be
split across two developers — one takes teams+drafts+builder (4–8), the
other takes orgs+account+HUG (9–13). They converge at slice 14 (admin).

---

## Risk Checkpoints

After every slice:

| Check | Command |
|-------|---------|
| Backend tests pass | `cd cliqhub && npm test` |
| BFF tests pass | `cd cliqhub/services/bff && npm test` |
| No TS errors | `npx tsc --noEmit` in both projects |
| Browser smoke | Manual click-through of affected pages |
| CLI still works | `cliq hub search tdd` |
| Proxy fallback works | Hit any not-yet-migrated route via BFF |
