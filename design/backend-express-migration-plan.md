# Backend Express Migration Plan — Detailed Slice Breakdown

Migrates the Next.js App Router backend (`app/api/*/route.ts` + `lib/handlers/`)
to a standard Express 5 layered architecture mirroring the BFF.

Architecture: **Router → Controller → Service → Repository → Database**

---

## Where Tests Live

All new backend tests go into `cliqhub/services/backend/tests/`.

```
cliqhub/services/backend/tests/
├── helpers/
│   ├── fixtures.ts                   # ALICE, BOB, SITE_ADMIN, ORG_ADMIN, UNAUTHED
│   ├── test_container.ts             # Builds real Express app with mocked DB pool
│   └── db_mock.ts                    # vi.mock() factory for src/db/pool
├── unit/
│   ├── db/
│   │   └── pool.test.ts              # Slice 23
│   ├── auth/
│   │   ├── jwt.test.ts               # Slice 24
│   │   ├── password.test.ts          # Slice 24
│   │   └── access.test.ts            # Slice 26
│   ├── middleware/
│   │   ├── error_handler.test.ts     # Slice 23
│   │   ├── auth_middleware.test.ts    # Slice 24
│   │   ├── admin_guard.test.ts       # Slice 24
│   │   ├── builder_auth.test.ts      # Slice 24
│   │   └── rate_limit.test.ts        # Slice 24
│   ├── controllers/
│   │   ├── base_controller.test.ts   # Slice 23
│   │   ├── auth_controller.test.ts   # Slice 25
│   │   ├── teams_controller.test.ts  # Slice 26 (reads), extended Slice 27 (writes)
│   │   ├── drafts_controller.test.ts # Slice 28
│   │   ├── account_controller.test.ts # Slice 29
│   │   ├── hug_controller.test.ts    # Slice 29
│   │   ├── orgs_controller.test.ts   # Slice 30
│   │   ├── builder_controller.test.ts # Slice 31
│   │   └── admin_controller.test.ts  # Slice 32 (users+scopes), extended Slice 33
│   ├── services/
│   │   ├── auth_service.test.ts      # Slice 25
│   │   ├── token_service.test.ts     # Slice 25
│   │   ├── teams_service.test.ts     # Slice 26 (reads), extended Slice 27 (writes)
│   │   ├── package_parser.test.ts    # Slice 27
│   │   ├── drafts_service.test.ts    # Slice 28
│   │   ├── account_service.test.ts   # Slice 29
│   │   ├── hug_service.test.ts       # Slice 29
│   │   ├── orgs_service.test.ts      # Slice 30
│   │   ├── builder_service.test.ts   # Slice 31
│   │   ├── llm/
│   │   │   └── hosted_adapter.test.ts # Slice 31
│   │   ├── admin_service.test.ts     # Slice 32 (users+scopes), extended Slice 33
│   │   └── settings_service.test.ts  # Slice 32
│   ├── repositories/
│   │   ├── user_repository.test.ts   # Slice 24 (reads), extended Slice 25, 29, 32
│   │   ├── token_repository.test.ts  # Slice 24 (reads), extended Slice 25, 33
│   │   ├── scope_repository.test.ts  # Slice 24 (reads), extended Slice 25, 30, 32
│   │   ├── org_member_repository.test.ts # Slice 24 (reads), extended Slice 30
│   │   ├── team_repository.test.ts   # Slice 26 (reads), extended Slice 27, 33
│   │   ├── team_version_repository.test.ts # Slice 26, extended Slice 27, 33
│   │   ├── tag_repository.test.ts    # Slice 26 (reads), extended Slice 27
│   │   ├── role_repository.test.ts   # Slice 26 (reads), extended Slice 27
│   │   ├── download_log_repository.test.ts # Slice 27
│   │   ├── draft_repository.test.ts  # Slice 28
│   │   ├── org_repository.test.ts    # Slice 30, extended Slice 33
│   │   ├── scope_member_repository.test.ts # Slice 30
│   │   ├── audit_repository.test.ts  # Slice 32
│   │   └── settings_repository.test.ts # Slice 32
│   └── storage/
│       └── package_storage.test.ts   # Slice 27
└── integration/
    ├── health.test.ts                # Slice 23
    ├── auth.test.ts                  # Slice 25
    ├── teams_read.test.ts            # Slice 26
    ├── teams_write.test.ts           # Slice 27
    ├── drafts.test.ts                # Slice 28
    ├── account.test.ts               # Slice 29
    ├── orgs.test.ts                  # Slice 30
    ├── builder.test.ts               # Slice 31
    ├── admin_users_scopes.test.ts    # Slice 32
    └── admin_teams_tokens_orgs.test.ts # Slice 33
```

BFF gap tests (Slices 35-36) go into existing `cliqhub/services/bff/` test dirs:
- `cliqhub/services/bff/e2e/*.spec.ts` — E2E additions
- `cliqhub/services/bff/tests/integration/*.test.ts` — integration gap fills

**Rule: Every slice adds its own tests in the same PR. No slice merges without
its test file(s) passing.**

---

## Architecture Overview

```
cliqhub/services/backend/
├── src/
│   ├── server.ts
│   ├── app.ts
│   ├── container.ts
│   ├── config/
│   │   └── env.ts
│   ├── controllers/
│   │   ├── base_controller.ts
│   │   ├── auth_controller.ts
│   │   ├── teams_controller.ts
│   │   ├── drafts_controller.ts
│   │   ├── builder_controller.ts
│   │   ├── orgs_controller.ts
│   │   ├── account_controller.ts
│   │   ├── hug_controller.ts
│   │   ├── admin_controller.ts
│   │   └── health_controller.ts
│   ├── services/
│   │   ├── auth_service.ts
│   │   ├── token_service.ts
│   │   ├── teams_service.ts
│   │   ├── package_parser.ts
│   │   ├── drafts_service.ts
│   │   ├── builder_service.ts
│   │   ├── orgs_service.ts
│   │   ├── account_service.ts
│   │   ├── hug_service.ts
│   │   ├── admin_service.ts
│   │   ├── settings_service.ts
│   │   └── llm/
│   │       └── hosted_adapter.ts
│   ├── repositories/
│   │   ├── user_repository.ts
│   │   ├── team_repository.ts
│   │   ├── team_version_repository.ts
│   │   ├── scope_repository.ts
│   │   ├── org_repository.ts
│   │   ├── org_member_repository.ts
│   │   ├── scope_member_repository.ts
│   │   ├── token_repository.ts
│   │   ├── draft_repository.ts
│   │   ├── audit_repository.ts
│   │   ├── settings_repository.ts
│   │   ├── download_log_repository.ts
│   │   ├── tag_repository.ts
│   │   └── role_repository.ts
│   ├── db/
│   │   ├── pool.ts
│   │   └── migrate.ts
│   ├── schemas/
│   │   ├── auth_schemas.ts
│   │   ├── teams_schemas.ts
│   │   ├── drafts_schemas.ts
│   │   ├── builder_schemas.ts
│   │   ├── orgs_schemas.ts
│   │   ├── account_schemas.ts
│   │   ├── admin_schemas.ts
│   │   └── hug_schemas.ts
│   ├── middleware/
│   │   ├── auth_middleware.ts
│   │   ├── admin_guard.ts
│   │   ├── rate_limit.ts
│   │   ├── error_handler.ts
│   │   └── builder_auth.ts
│   ├── types/
│   │   ├── vo.ts
│   │   ├── dto.ts
│   │   └── mappers.ts
│   ├── auth/
│   │   ├── jwt.ts
│   │   ├── password.ts
│   │   └── access.ts
│   ├── storage/
│   │   └── package_storage.ts
│   └── errors/
│       └── api_error.ts
├── tests/                            # ← ALL backend tests here
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Naming Conventions

| Layer | Naming | Example |
|-------|--------|---------|
| Internal types (Value Objects) | `*VO` suffix | `UserVO`, `TeamDetailVO` |
| API response types (DTOs) | `*DTO` suffix | `UserDTO`, `TeamListItemDTO` |
| Mappers | `to_*_dto` | `to_user_dto()` |
| Zod schemas | `*_schema` | `login_schema`, `publish_team_schema` |
| Repository methods | `find_*`, `create_*`, `update_*`, `delete_*`, `count_*`, `list_*` | `find_by_username()` |
| Service methods | Action verbs | `signup()`, `publish()`, `transfer_team()` |
| Test fixtures | `SCREAMING_SNAKE` | `ALICE`, `BOB`, `SITE_ADMIN` |
| Everything else | `snake_case` | `resolve_auth`, `package_storage` |

---

## Key Differences from BFF

| Aspect | BFF | Backend |
|--------|-----|---------|
| Repository layer | Calls `ApiClient.post()` to backend | Calls `db.query()` / `db.run()` directly |
| Auth | Cookie-based sessions via `SessionStore` | JWT/API-token via `Authorization` header |
| CSRF | `X-Requested-With` header check | Not needed (Bearer token auth) |
| Session | `req.session_data` (cookie) | `req.auth` (JWT-decoded `AuthContext`) |
| Type boundary | VO (backend shape) → DTO (browser shape) | VO (DB row) → DTO (API response) |
| Storage | Not applicable | `package_storage` for team packages |

---

## Slice Execution Template

Every slice follows this exact sequence:

1. Create/update types: VOs (DB shapes) + DTOs (API shapes) + mappers
2. Create Zod validation schemas
3. Build repository methods (raw SQL → typed results)
4. Build service methods (business logic, calls repository)
5. Build controller methods (validation → auth → service → response)
6. Wire routes in `app.ts` + update `container.ts`
7. Write repository unit tests → `tests/unit/repositories/`
8. Write service unit tests (mocked repos) → `tests/unit/services/`
9. Write controller unit tests (mocked services) → `tests/unit/controllers/`
10. Write integration tests (supertest, mocked DB) → `tests/integration/`
11. Run `npm test` in `cliqhub/services/backend/` → all green → done

---

## Slice 23 — Foundation: Express Scaffold + DB Layer + Error Handling

**Goal**: Empty Express app that boots, responds to `/health`, and has the full
database abstraction + error handling + test infrastructure ready.

### Source files created

| File | What it does |
|------|--------------|
| `package.json` | Express 5, pg, zod, bcrypt, jsonwebtoken, uuid, helmet, cors, cookie-parser, vitest, supertest, typescript |
| `tsconfig.json` | ESM, strict, Node 20+, paths `@/ → src/` |
| `vitest.config.ts` | `globals: true`, `include: ['tests/**/*.test.ts']` |
| `src/server.ts` | `load_env()` → `create_container()` → `app.listen(PORT)` |
| `src/app.ts` | `helmet()`, `cors()`, `express.json({ limit: '15mb' })`, health route, `error_handler` at bottom |
| `src/container.ts` | Stub — only wires pool + health controller; grows per slice |
| `src/config/env.ts` | `EnvConfig` type: `database_url`, `jwt_secret`, `port`, `allowed_origins`, `hug_server_url`, `hug_admin_key`, `storage_backend`, `s3_*`. `load_env()` reads `process.env` |
| `src/db/pool.ts` | `create_pool(url)` → `pg.Pool`. Exports: `query<T>()`, `query_one<T>()`, `run()`, `transaction()`, `client_query<T>()`, `client_query_one<T>()`, `client_run()`, `close()`. Internal `pg_params()` converts `?` → `$N` |
| `src/errors/api_error.ts` | `class ApiError extends Error { code, status }`. `status_for_code()` map: `unauthorized→401`, `forbidden→403`, `not_found→404`, `conflict→409`, `invalid_params→422`, `rate_limited→429`. `class ParamError extends ApiError` (always 422) |
| `src/middleware/error_handler.ts` | `(err, req, res, next)`: if `ApiError` → `{ ok: false, error: { code, message } }` with `err.status`; else → 500 with generic message |
| `src/controllers/base_controller.ts` | `parse_body<T>(schema, req)`: Zod safeParse → throw `ApiError(422)`. `ok<T>(res, data, status=200)`: `res.json({ ok: true, data })`. `wrap(handler)`: `handler.catch(next)` |
| `src/controllers/health_controller.ts` | `check = this.wrap(async (req, res) => this.ok(res, { status: 'ok' }))` |
| `src/types/vo.ts` | Empty — grows per slice |
| `src/types/dto.ts` | Empty — grows per slice |
| `src/types/mappers.ts` | Empty — grows per slice |

### Test helpers created

| File | What |
|------|------|
| `tests/helpers/fixtures.ts` | Shared `AuthContext` fixtures used by ALL subsequent slices |
| `tests/helpers/db_mock.ts` | `vi.mock('@/db/pool')` factory that auto-mocks all pool exports |
| `tests/helpers/test_container.ts` | Stub — builds test app with health only; grows per slice |

### Fixture definitions (`tests/helpers/fixtures.ts`)

```typescript
ALICE: AuthContext     // { user: { id: 1, username: 'alice', role: 'user', ... }, scopes: [{ slug: 'alice', ... }], org_slugs: [] }
BOB: AuthContext       // { user: { id: 2, username: 'bob', role: 'user', ... }, scopes: [{ slug: 'bob', ... }], org_slugs: [] }
SITE_ADMIN: AuthContext // { user: { id: 99, username: 'admin', role: 'admin', ... }, scopes: [...], org_slugs: [] }
ORG_ADMIN: AuthContext // { user: { id: 3, username: 'orgadmin', role: 'user', ... }, scopes: [...], org_slugs: ['acme'] }
UNAUTHED: AuthContext  // { user: null, org_slugs: [], scopes: [] }
```

### Tests — `tests/unit/db/pool.test.ts` (8 cases)

```
describe('pool')
  it('query returns typed rows')
  it('query returns empty array when no rows')
  it('query_one returns first row or null')
  it('query_one returns null when no rows')
  it('run returns row_count')
  it('transaction commits on success')
  it('transaction rolls back on error')
  it('pg_params converts ? placeholders to $N')
```

### Tests — `tests/unit/middleware/error_handler.test.ts` (6 cases)

```
describe('error_handler')
  it('returns 401 for ApiError with code unauthorized')
  it('returns 404 for ApiError with code not_found')
  it('returns 422 for ParamError')
  it('returns custom status from ApiError')
  it('returns 500 for unknown Error')
  it('returns 500 for non-Error thrown value')
```

### Tests — `tests/unit/controllers/base_controller.test.ts` (5 cases)

```
describe('BaseController')
  it('parse_body returns validated data for valid input')
  it('parse_body throws ApiError 422 for invalid input')
  it('parse_body includes field path in error message')
  it('ok sends { ok: true, data } with status 200')
  it('wrap catches async errors and forwards to next')
```

### Tests — `tests/integration/health.test.ts` (3 cases)

```
describe('GET /health')
  it('returns 200 with { ok: true, data: { status: "ok" } }')
  it('returns correct content-type application/json')
  it('returns 404 for unknown routes')
```

### Slice 23 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — DB | `tests/unit/db/pool.test.ts` | 8 |
| Unit — Middleware | `tests/unit/middleware/error_handler.test.ts` | 6 |
| Unit — Controller | `tests/unit/controllers/base_controller.test.ts` | 5 |
| Integration | `tests/integration/health.test.ts` | 3 |
| **Total** | | **22** |

**Cumulative backend test count after Slice 23: 22**

---

## Slice 24 — Auth: JWT, Password Hashing, Auth Middleware

**Goal**: JWT sign/verify, bcrypt password hashing, auth middleware that resolves
`Authorization` header into `req.auth` (`AuthContext`). Admin guard, builder
auth, rate limiter.

### Source files created

| File | What |
|------|------|
| `src/auth/jwt.ts` | `sign_token(payload: { user_id, username, role }, secret, expires_in='30d')` → JWT string. `verify_token(token, secret)` → decoded payload or throws |
| `src/auth/password.ts` | `hash_password(plain, rounds=10)` → bcrypt hash. `verify_password(plain, hash)` → boolean |
| `src/middleware/auth_middleware.ts` | Reads `Authorization: Bearer <token>`. If JWT → verify → load user from `user_repo.find_by_id()` → build `AuthContext` with scopes + org_slugs. If `cliq_tok_*` → find by prefix → bcrypt compare → update last_used. Sets `req.auth`. If no header → `req.auth = UNAUTHED` (does NOT reject — controllers decide) |
| `src/middleware/admin_guard.ts` | `require_admin(req, res, next)`: if `!req.auth.user` → 401, if `role !== 'admin'` → 403, if `suspended_at` → 403 |
| `src/middleware/builder_auth.ts` | `create_builder_auth(allowed_origins)`: if valid JWT → pass, else if `Origin` in allowed_origins → pass, else → 401 |
| `src/middleware/rate_limit.ts` | `create_rate_limiter({ window_ms, max_requests })` → sliding window per IP. Returns 429 when exceeded |
| `src/repositories/user_repository.ts` | Created with 4 read methods: `find_by_id(id)`, `find_by_username(username)`, `find_by_username_or_email(username, email)`, `find_by_email(email, exclude_id?)` |
| `src/repositories/token_repository.ts` | Created with 2 methods: `find_by_prefix(prefix)`, `update_last_used(id)` |
| `src/repositories/scope_repository.ts` | Created with 3 methods: `find_owned_by_user(user_id)`, `find_by_org_ids(org_ids)`, `find_member_scopes(user_id)` |
| `src/repositories/org_member_repository.ts` | Created with 1 method: `find_orgs_by_user(user_id)` |
| `src/types/vo.ts` | Add: `UserVO`, `UserRowVO`, `ScopeVO`, `OrgMembershipVO`, `ApiTokenRowVO`, `AuthContextVO` |

### Tests — `tests/unit/auth/jwt.test.ts` (6 cases)

```
describe('jwt')
  it('sign_token returns a valid JWT string')
  it('verify_token decodes payload with user_id, username, role')
  it('verify_token throws for expired token')
  it('verify_token throws for invalid token string')
  it('verify_token throws for token signed with wrong secret')
  it('sign_token includes iat and exp claims')
```

### Tests — `tests/unit/auth/password.test.ts` (4 cases)

```
describe('password')
  it('hash_password returns a bcrypt hash')
  it('verify_password returns true for matching password')
  it('verify_password returns false for wrong password')
  it('hash_password produces different hashes for same input')
```

### Tests — `tests/unit/middleware/auth_middleware.test.ts` (12 cases)

```
describe('auth_middleware')
  it('sets req.auth as unauthenticated when no Authorization header')
  it('resolves JWT Bearer token to valid AuthContext')
  it('rejects expired JWT token')
  it('rejects malformed JWT token')
  it('resolves API token (cliq_tok_*) to valid AuthContext')
  it('rejects API token when prefix not found in DB')
  it('rejects API token when bcrypt compare fails')
  it('rejects suspended user from JWT auth')
  it('rejects suspended user from API token auth')
  it('loads user scopes into AuthContext')
  it('loads org_slugs into AuthContext')
  it('updates api_token last_used_at on successful API token auth')
```

### Tests — `tests/unit/middleware/admin_guard.test.ts` (4 cases)

```
describe('admin_guard')
  it('returns 401 when req.auth has no user')
  it('returns 403 when user role is not admin')
  it('calls next() when user is admin')
  it('returns 403 when admin is suspended')
```

### Tests — `tests/unit/middleware/builder_auth.test.ts` (5 cases)

```
describe('builder_auth')
  it('passes when valid JWT is present')
  it('passes when Origin header is in allowed_origins list')
  it('returns 401 when no JWT and Origin not in allowed list')
  it('returns 401 when no Authorization and no Origin headers')
  it('prefers JWT auth when both JWT and Origin are present')
```

### Tests — `tests/unit/middleware/rate_limit.test.ts` (5 cases)

```
describe('rate_limit')
  it('allows requests under the limit')
  it('returns 429 when limit is exceeded')
  it('resets count after window expires')
  it('tracks different IPs independently')
  it('includes Retry-After header on 429')
```

### Tests — `tests/unit/repositories/user_repository.test.ts` (8 cases, initial)

```
describe('UserRepository')
  it('find_by_id returns user when found')
  it('find_by_id returns null when not found')
  it('find_by_username returns user when found')
  it('find_by_username returns null when not found')
  it('find_by_username_or_email returns id when username matches')
  it('find_by_username_or_email returns id when email matches')
  it('find_by_username_or_email returns null when neither matches')
  it('find_by_email excludes given user id')
```

### Slice 24 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Auth | `jwt.test.ts` | 6 |
| Unit — Auth | `password.test.ts` | 4 |
| Unit — Middleware | `auth_middleware.test.ts` | 12 |
| Unit — Middleware | `admin_guard.test.ts` | 4 |
| Unit — Middleware | `builder_auth.test.ts` | 5 |
| Unit — Middleware | `rate_limit.test.ts` | 5 |
| Unit — Repository | `user_repository.test.ts` | 8 |
| **Total** | | **44** |

**Cumulative backend test count after Slice 24: 66**

---

## Slice 25 — Auth Endpoints: signup, login, me, tokens

**Goal**: Full auth flow — signup, login, me, token CRUD. First endpoints
wired in `app.ts`.

### Source files created/updated

| File | What |
|------|------|
| `src/services/auth_service.ts` | `signup(username, email, password)`: validate slug, reserved check, duplicate check, hash password, transaction (insert user + create user scope), sign JWT, return user+token. `login(username, password)`: find user, verify password, check suspended, sign JWT, provision HUG token (non-fatal), return token. `me(auth)`: return auth.user + auth.scopes |
| `src/services/token_service.ts` | `create_token(auth, name?)`: generate `cliq_tok_` + random hex, bcrypt hash, SHA256 prefix, insert, return token string. `revoke_token(auth, token_id)`: delete by id+user_id, return boolean. `list_tokens(auth)`: return user's tokens |
| `src/controllers/auth_controller.ts` | 6 route handlers. `signup`, `login` are public. `me`, `create_token`, `revoke_token`, `list_tokens` require `req.auth.user` |
| `src/schemas/auth_schemas.ts` | `signup_schema`: `{ username: z.string().min(2).max(64).regex(SLUG_PATTERN), email: z.string().email(), password: z.string().min(8).max(128) }`. `login_schema`: `{ username: z.string(), password: z.string() }`. `create_token_schema`: `{ name: z.string().optional() }`. `revoke_token_schema`: `{ token_id: z.number().int() }` |
| `src/repositories/user_repository.ts` | Add: `create(username, email, password_hash, display_name?, client?)` returning id. `find_by_id_detail(id)` returning full user row |
| `src/repositories/scope_repository.ts` | Add: `create(slug, owner_id, visibility, scope_type, display_name?, org_id?, client?)`. `find_by_slug(slug)` |
| `src/repositories/token_repository.ts` | Add: `create(user_id, token_hash, token_prefix, name)`. `delete_by_id_and_user(id, user_id)`. `list_by_user_id(user_id)` |
| `src/types/vo.ts` | Add: `SignupResultVO { user: UserVO, token: string }`, `LoginResultVO { token, hug_token?, hug_server_url? }` |
| `src/types/dto.ts` | Add: `UserDTO { id, username, display_name, email, role, created_at }`, `TokenDTO { id, name, created_at, last_used_at }`, `LoginDTO { token, hug_token?, hug_server_url? }` |
| `src/types/mappers.ts` | Add: `to_user_dto(vo)`, `to_token_dto(vo)`, `to_login_dto(vo)` |
| `src/app.ts` | Wire: `POST /api/auth/signup`, `/api/auth/login`, `/api/auth/me`, `/api/auth/create_token`, `/api/auth/revoke_token`, `/api/auth/list_tokens` |
| `src/container.ts` | Wire: user_repo, scope_repo, token_repo → auth_service, token_service → auth_controller |

### Tests — `tests/unit/services/auth_service.test.ts` (12 cases)

Mocks: `user_repository`, `scope_repository`, `token_repository`, `jwt`, `password`

```
describe('AuthService')
  describe('signup')
    it('creates user and scope in transaction, returns user + JWT')
    it('rejects reserved username')
    it('rejects invalid slug format')
    it('rejects duplicate username or email')
    it('rejects password shorter than 8 characters')
  describe('login')
    it('returns JWT and user on valid credentials')
    it('returns unauthorized for non-existent username')
    it('returns unauthorized when password does not match')
    it('returns unauthorized for suspended user')
    it('provisions HUG token when HUG server is configured')
  describe('me')
    it('returns user and scopes from AuthContext')
    it('returns unauthorized when auth.user is null')
```

### Tests — `tests/unit/services/token_service.test.ts` (6 cases)

Mocks: `token_repository`, `password`

```
describe('TokenService')
  it('create_token generates prefixed token and stores bcrypt hash')
  it('create_token uses default name "CLI token" when none provided')
  it('revoke_token returns true when token deleted')
  it('revoke_token returns false when token not found')
  it('list_tokens returns empty array for user with no tokens')
  it('list_tokens returns token list for user')
```

### Tests — `tests/unit/controllers/auth_controller.test.ts` (8 cases)

Mocks: `auth_service`, `token_service`

```
describe('AuthController')
  it('signup rejects missing username')
  it('signup rejects invalid email format')
  it('signup delegates to auth_service.signup')
  it('login rejects missing password')
  it('me returns 401 when not authenticated')
  it('create_token returns 401 when not authenticated')
  it('revoke_token rejects non-integer token_id')
  it('list_tokens returns 401 when not authenticated')
```

### Tests — `tests/integration/auth.test.ts` (22 cases)

Uses supertest against real app, mocks DB pool.

```
describe('POST /api/auth/signup')
  it('returns 200 with user and token on success')
  it('returns 422 for missing fields')
  it('returns 422 for invalid email')
  it('returns 422 for short password')
  it('returns 409 for duplicate username')
  it('returns 422 for reserved username')
describe('POST /api/auth/login')
  it('returns 200 with token on valid credentials')
  it('returns 401 for wrong password')
  it('returns 401 for non-existent user')
  it('returns 401 for suspended user')
describe('POST /api/auth/me')
  it('returns 200 with user profile when authenticated')
  it('returns 401 when no Authorization header')
  it('returns 401 for expired JWT')
describe('POST /api/auth/create_token')
  it('returns 200 with new API token')
  it('returns 200 with custom name')
  it('returns 200 with default name when none provided')
  it('returns 401 when not authenticated')
describe('POST /api/auth/revoke_token')
  it('returns 200 with deleted true')
  it('returns 200 with deleted false for non-existent token')
  it('returns 422 for non-integer token_id')
  it('returns 401 when not authenticated')
describe('POST /api/auth/list_tokens')
  it('returns 200 with token list')
  it('returns 401 when not authenticated')
```

### Slice 25 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Service | `auth_service.test.ts` | 12 |
| Unit — Service | `token_service.test.ts` | 6 |
| Unit — Controller | `auth_controller.test.ts` | 8 |
| Integration | `auth.test.ts` | 22 |
| **Total** | | **48** |

**Cumulative backend test count after Slice 25: 114**

---

## Slice 26 — Teams: Read Operations

**Goal**: list, get, get_version, search, get_versions, get_latest_version,
batch_latest — 7 read endpoints. Visibility logic (public/private/draft).

### Source files created/updated

| File | What |
|------|------|
| `src/auth/access.ts` | `can_view_team(auth, team)` — pure function. Public → all. Private → author or scope member. Draft → author only |
| `src/repositories/team_repository.ts` | `find_by_name_and_scope(name, scope)`, `list_filtered(filters, visibility_clause, params)`, `count_filtered(filters, visibility_clause, params)` |
| `src/repositories/team_version_repository.ts` | `find_by_team_and_version(team_id, version)`, `find_latest_version(team_id)`, `find_detail_by_team_and_version(team_id, version)`, `list_by_team_id(team_id)` |
| `src/repositories/tag_repository.ts` | `find_by_team_ids(ids)`, `find_by_team_id(id)` |
| `src/repositories/role_repository.ts` | `list_by_version_id(version_id)` |
| `src/services/teams_service.ts` | `list()`, `get()`, `get_version()`, `search()`, `get_versions()`, `get_latest_version()`, `batch_latest()`. Uses `build_visibility_clause(auth)` internal helper |
| `src/controllers/teams_controller.ts` | 7 endpoints. `list`, `search`, `get_versions`, `get_latest_version`, `batch_latest` are public (auth optional). `get`, `get_version` check `can_view_team` |
| `src/schemas/teams_schemas.ts` | `teams_list_schema`, `teams_get_schema`, `teams_search_schema`, `teams_version_schema`, `teams_get_versions_schema`, `teams_latest_schema`, `teams_batch_schema` |
| `src/types/vo.ts` | `TeamVO`, `TeamListItemVO`, `TeamDetailVO`, `TeamVersionVO`, `TeamVersionDetailVO`, `TeamTagVO`, `TeamRoleVO` |
| `src/types/dto.ts` | `TeamListItemDTO`, `TeamListResponseDTO`, `TeamDetailDTO`, `TeamVersionDTO` |
| `src/types/mappers.ts` | `to_team_list_item_dto()`, `to_team_list_response_dto()`, `to_team_detail_dto()`, `to_team_version_dto()` |

### Tests — `tests/unit/auth/access.test.ts` (6 cases)

```
describe('can_view_team')
  it('allows everyone to view public listed teams')
  it('denies unauthenticated users from private teams')
  it('allows author to view own private team')
  it('denies non-author non-scope-member from private team')
  it('allows scope member to view private org-scoped team')
  it('denies non-member from private org-scoped team')
```

### Tests — `tests/unit/repositories/team_repository.test.ts` (10 cases, initial reads)

```
describe('TeamRepository — reads')
  it('find_by_name_and_scope returns team when found with scope')
  it('find_by_name_and_scope returns team when scope is null')
  it('find_by_name_and_scope returns null when not found')
  it('list_filtered returns teams with pagination')
  it('list_filtered applies domain filter')
  it('list_filtered applies tag filter via subquery')
  it('list_filtered applies visibility clause for public')
  it('list_filtered applies visibility clause for authenticated user')
  it('count_filtered returns total matching count')
  it('count_filtered applies same filters as list_filtered')
```

### Tests — `tests/unit/repositories/team_version_repository.test.ts` (8 cases, initial reads)

```
describe('TeamVersionRepository — reads')
  it('find_by_team_and_version returns version when found')
  it('find_by_team_and_version returns null when not found')
  it('find_latest_version returns latest version string')
  it('find_latest_version returns null when no versions exist')
  it('find_detail_by_team_and_version returns full detail')
  it('find_detail_by_team_and_version returns null when not found')
  it('list_by_team_id returns versions ordered by published_at desc')
  it('list_by_team_id returns empty array when none exist')
```

### Tests — `tests/unit/services/teams_service.test.ts` (14 cases, reads)

Mocks: all repositories

```
describe('TeamsService — reads')
  it('list returns paginated teams with tags attached')
  it('list caps limit to 100')
  it('list applies domain filter')
  it('list applies tag filter')
  it('get returns team detail with versions, tags, and roles')
  it('get returns not_found for missing team')
  it('get returns not_found when access denied by can_view_team')
  it('get_version returns single version detail')
  it('get_version returns not_found for missing version')
  it('search returns matching teams with ILIKE')
  it('search escapes special LIKE characters in query')
  it('get_versions returns all versions for a team')
  it('get_latest_version returns latest version string')
  it('batch_latest returns latest for each team, null for missing')
```

### Tests — `tests/unit/controllers/teams_controller.test.ts` (10 cases, reads)

Mocks: `teams_service`

```
describe('TeamsController — reads')
  it('list accepts valid schema and delegates to service')
  it('list rejects limit > 100')
  it('get requires name field')
  it('search requires query field')
  it('search rejects limit > 100')
  it('get_version requires name and version')
  it('get_versions requires name')
  it('get_latest_version requires name')
  it('batch_latest requires teams array')
  it('batch_latest rejects array > 100 items')
```

### Tests — `tests/integration/teams_read.test.ts` (16 cases)

```
describe('Team read endpoints')
  describe('POST /api/teams/list')
    it('returns 200 with team list (public, no auth)')
    it('returns 200 with filtered by domain')
    it('returns 200 with filtered by tag')
    it('returns 200 with pagination')
  describe('POST /api/teams/get')
    it('returns 200 with team detail for public team')
    it('returns 404 for non-existent team')
    it('returns 404 for private team when unauthenticated')
  describe('POST /api/teams/get_version')
    it('returns 200 with specific version')
    it('returns 404 for missing version')
  describe('POST /api/teams/search')
    it('returns 200 with matching teams')
    it('returns 200 with empty results for no match')
  describe('POST /api/teams/get_versions')
    it('returns 200 with all versions')
    it('returns 404 for missing team')
  describe('POST /api/teams/get_latest_version')
    it('returns 200 with latest version')
    it('returns null version when none published')
  describe('POST /api/teams/batch_latest')
    it('returns 200 with batch results')
    it('returns 422 for empty array')
```

### Slice 26 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Auth | `access.test.ts` | 6 |
| Unit — Repository | `team_repository.test.ts` | 10 |
| Unit — Repository | `team_version_repository.test.ts` | 8 |
| Unit — Service | `teams_service.test.ts` (reads) | 14 |
| Unit — Controller | `teams_controller.test.ts` (reads) | 10 |
| Integration | `teams_read.test.ts` | 16 |
| **Total** | | **64** |

**Cumulative backend test count after Slice 26: 178**

---

## Slice 27 — Teams: Write Operations

**Goal**: publish, publish_check, download, delete_team, delete_version,
toggle_listed, rename_team, list_my_teams, list_all_my_teams — 9 endpoints.
Most complex slice.

### Source files created/updated

| File | What |
|------|------|
| `src/storage/package_storage.ts` | `read_package(key)` → Buffer. `write_package(key, data)`. `delete_package(key)`. `package_key(scope, name, version)`. Local FS + R2 backends |
| `src/services/package_parser.ts` | `extract_package(data_base64)` → `{ team_yml, roles, readme, agents }`. Handles JSON + ZIP formats. Size checks. YAML validation |
| `src/services/teams_service.ts` | Add 9 methods. `publish()` is the biggest — scope ownership, version resolution (explicit or bump), package extraction, transaction (upsert team + insert version + insert roles + sync tags), storage write. `rename_team()` patches YAML in zips. `download()` tracks installs |
| `src/repositories/team_repository.ts` | Add: `create()`, `update()`, `update_name()`, `update_listed()`, `update_install_count()`, `delete()`, `list_by_scope()`, `list_by_scope_list()` |
| `src/repositories/team_version_repository.ts` | Add: `create()`, `update_package_path()`, `delete_by_id()`, `find_id_and_package()`, `list_packages_by_team()`, `list_all_by_team()`, `find_latest_package()`, `find_package_by_version()` |
| `src/repositories/tag_repository.ts` | Add: `delete_by_team_id()`, `create()` |
| `src/repositories/role_repository.ts` | Add: `create()` |
| `src/repositories/download_log_repository.ts` | `find_by_team_key_date()`, `create()` |
| `src/schemas/teams_schemas.ts` | Add: `publish_schema`, `publish_check_schema`, `download_schema`, `delete_team_schema`, `delete_version_schema`, `toggle_listed_schema`, `rename_schema`, `list_mine_schema` |
| `src/types/vo.ts` | Add: `PublishResultVO`, `DownloadResultVO`, `PackageContentVO` |
| `src/types/dto.ts` | Add: `PublishResultDTO`, `DownloadResultDTO` |
| `src/types/mappers.ts` | Add: `to_publish_result_dto()`, `to_download_result_dto()` |

### Tests — `tests/unit/repositories/team_repository.test.ts` (10 additional write cases)

```
describe('TeamRepository — writes')
  it('create inserts team and returns id')
  it('update sets description, domain, license, visibility')
  it('update_name changes team name')
  it('update_listed flips listed flag')
  it('update_install_count increments by 1')
  it('delete removes team by id')
  it('list_by_scope returns teams for single scope')
  it('list_by_scope_list returns teams for multiple scopes')
  it('list_by_scope returns empty for scope with no teams')
  it('find_by_name_and_scope_conflict detects name collision')
```

### Tests — `tests/unit/repositories/download_log_repository.test.ts` (3 cases)

```
describe('DownloadLogRepository')
  it('find_by_team_key_date returns row when download exists')
  it('find_by_team_key_date returns null for new download')
  it('create inserts download log entry')
```

### Tests — `tests/unit/services/package_parser.test.ts` (10 cases)

```
describe('package_parser')
  it('extracts team.yml from JSON package')
  it('extracts team.yml from ZIP package')
  it('throws for ZIP missing team.yml')
  it('throws for invalid YAML in team.yml')
  it('throws for oversized package (>10MB)')
  it('extracts roles from team.yml phases')
  it('extracts readme from ZIP')
  it('normalizes tags to lowercase slug format')
  it('caps tags at 20')
  it('extracts agents_json from team.yml')
```

### Tests — `tests/unit/services/teams_service.test.ts` (28 additional write cases)

```
describe('TeamsService — writes')
  describe('publish')
    it('creates new team with first version in transaction')
    it('updates existing team with new version')
    it('computes patch bump from existing version')
    it('computes minor bump')
    it('computes major bump')
    it('returns 1.0.0 for first publish with bump')
    it('rejects version conflict')
    it('rejects reserved scope')
    it('rejects scope user does not own')
    it('rejects non-owner publish to existing team')
    it('stores changelog when provided')
    it('normalizes tags during publish')
  describe('publish_check')
    it('returns ok for valid new team')
    it('rejects invalid slug')
    it('rejects wrong scope')
    it('rejects version conflict')
  describe('download')
    it('returns base64 package data')
    it('returns specific version when requested')
    it('returns latest when no version specified')
    it('increments download count for new IP+day')
    it('skips increment for repeat download same day')
    it('returns error when package file missing')
  describe('delete_team')
    it('author can delete own team')
    it('admin can delete any team')
    it('returns forbidden for non-owner non-admin')
  describe('delete_version')
    it('deletes version and package file')
  describe('toggle_listed')
    it('flips listed 1 to 0')
    it('flips listed 0 to 1')
  describe('rename_team')
    it('renames team and patches YAML in all version zips')
    it('rejects rename to conflicting name')
    it('rejects same name')
    it('rejects invalid new name')
    it('rejects non-owner non-admin')
  describe('list_my_teams')
    it('returns teams for owned scope')
    it('returns forbidden for unowned scope')
    it('defaults to username when no scope given')
  describe('list_all_my_teams')
    it('returns teams grouped by scope')
    it('returns empty for user with no scopes')
```

### Tests — `tests/unit/storage/package_storage.test.ts` (6 cases)

```
describe('package_storage')
  it('write_package writes to local filesystem')
  it('read_package reads from local filesystem')
  it('delete_package removes from local filesystem')
  it('write_package uploads to R2 when configured')
  it('read_package downloads from R2 when configured')
  it('delete_package removes from R2 when configured')
```

### Tests — `tests/integration/teams_write.test.ts` (22 cases)

```
describe('Team write endpoints')
  describe('POST /api/teams/publish')
    it('returns 200 creating new team')
    it('returns 200 updating existing team')
    it('returns 401 when not authenticated')
    it('returns 422 for missing data_base64')
    it('returns 409 for version conflict')
    it('returns 403 for wrong scope')
  describe('POST /api/teams/publish_check')
    it('returns 200 for valid params')
    it('returns 422 for invalid slug')
  describe('POST /api/teams/download')
    it('returns 200 with base64 package')
    it('returns 404 for missing team')
    it('returns 404 for missing package file')
  describe('POST /api/teams/delete')
    it('returns 200 for author')
    it('returns 200 for admin')
    it('returns 403 for non-owner')
    it('returns 401 when not authenticated')
  describe('POST /api/teams/delete_version')
    it('returns 200 deleting specific version')
  describe('POST /api/teams/toggle_listed')
    it('returns 200 toggling listed')
    it('returns 403 for non-owner')
  describe('POST /api/teams/rename')
    it('returns 200 renaming team')
    it('returns 409 for conflicting name')
  describe('POST /api/teams/list_mine')
    it('returns 200 with user teams for scope')
    it('returns 403 for unowned scope')
  describe('POST /api/teams/list_mine_all')
    it('returns 200 with all scopes')
```

### Slice 27 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Repository | `team_repository.test.ts` (writes) | 10 |
| Unit — Repository | `download_log_repository.test.ts` | 3 |
| Unit — Service | `package_parser.test.ts` | 10 |
| Unit — Service | `teams_service.test.ts` (writes) | 28 |
| Unit — Storage | `package_storage.test.ts` | 6 |
| Integration | `teams_write.test.ts` | 22 |
| **Total** | | **79** |

**Cumulative backend test count after Slice 27: 257**

---

## Slice 28 — Drafts

**Goal**: Simple CRUD — 4 endpoints. `list_drafts`, `get_draft`, `save_draft`,
`delete_draft`. All require auth. Ownership enforced.

### Source files created/updated

| File | What |
|------|------|
| `src/repositories/draft_repository.ts` | 7 methods: `list_by_user_id`, `find_by_id_and_user`, `create`, `update`, `delete_by_id`, `count_by_user_id`, `count_total` |
| `src/services/drafts_service.ts` | 4 methods. `save_draft` handles create-or-update. Ownership check on get/update/delete |
| `src/controllers/drafts_controller.ts` | 4 endpoints, all `require_auth` inline |
| `src/schemas/drafts_schemas.ts` | `get_draft_schema { id: z.number().int() }`, `save_draft_schema { id?: z.number().int(), title?: z.string(), team_json: z.string() }`, `delete_draft_schema { id: z.number().int() }` |
| `src/types/vo.ts` | `DraftVO`, `DraftListItemVO` |
| `src/types/dto.ts` | `DraftDTO`, `DraftListItemDTO` |
| `src/types/mappers.ts` | `to_draft_dto()`, `to_draft_list_item_dto()` |
| `src/app.ts` | Wire: `POST /api/drafts/list`, `/api/drafts/get`, `/api/drafts/save`, `/api/drafts/delete` |

### Tests — `tests/unit/repositories/draft_repository.test.ts` (7 cases)

```
describe('DraftRepository')
  it('list_by_user_id returns drafts ordered by updated_at desc')
  it('list_by_user_id returns empty array')
  it('find_by_id_and_user returns draft when owned')
  it('find_by_id_and_user returns null for other user')
  it('create returns new draft id')
  it('update modifies team_json and title')
  it('delete_by_id removes draft')
```

### Tests — `tests/unit/services/drafts_service.test.ts` (10 cases)

```
describe('DraftsService')
  it('list_drafts returns user drafts')
  it('list_drafts returns empty for user with no drafts')
  it('get_draft returns draft for owner')
  it('get_draft returns not_found for missing draft')
  it('get_draft returns not_found for wrong user')
  it('save_draft creates new draft when no id')
  it('save_draft uses default title "Untitled" when none provided')
  it('save_draft updates existing draft when id provided')
  it('save_draft returns not_found when updating non-existent draft')
  it('save_draft returns not_found when updating other user draft')
  it('delete_draft deletes owned draft')
  it('delete_draft returns not_found for missing draft')
  it('delete_draft returns not_found for wrong user')
```

### Tests — `tests/unit/controllers/drafts_controller.test.ts` (4 cases)

```
describe('DraftsController')
  it('get rejects non-integer id')
  it('save rejects missing team_json')
  it('delete rejects non-integer id')
  it('list returns 401 when not authenticated')
```

### Tests — `tests/integration/drafts.test.ts` (17 cases)

```
describe('Draft endpoints')
  describe('POST /api/drafts/list')
    it('returns 200 with draft list')
    it('returns 200 empty when no drafts')
    it('returns 401 when not authenticated')
  describe('POST /api/drafts/get')
    it('returns 200 with draft detail')
    it('returns 404 for missing draft')
    it('returns 404 for other user draft')
    it('returns 401 when not authenticated')
    it('returns 422 for non-integer id')
  describe('POST /api/drafts/save')
    it('returns 200 creating new draft')
    it('returns 200 updating existing draft')
    it('returns 404 updating non-existent draft')
    it('returns 404 updating other user draft')
    it('returns 422 for missing team_json')
    it('returns 401 when not authenticated')
  describe('POST /api/drafts/delete')
    it('returns 200 deleting draft')
    it('returns 404 for missing draft')
    it('returns 401 when not authenticated')
```

### Slice 28 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Repository | `draft_repository.test.ts` | 7 |
| Unit — Service | `drafts_service.test.ts` | 10 |
| Unit — Controller | `drafts_controller.test.ts` | 4 |
| Integration | `drafts.test.ts` | 17 |
| **Total** | | **38** |

**Cumulative backend test count after Slice 28: 295**

---

## Slice 29 — Account + HUG

**Goal**: update_profile, change_password, generate_hug_token, get_hug_status.

### Tests — `tests/unit/services/account_service.test.ts` (12 cases)

```
describe('AccountService')
  describe('update_profile')
    it('updates display_name only')
    it('updates email only')
    it('updates both fields')
    it('rejects email conflict with another user')
    it('rejects empty display_name')
    it('rejects display_name longer than 100 chars')
    it('rejects invalid email format')
    it('normalizes email to lowercase')
  describe('change_password')
    it('changes password on valid current password')
    it('rejects wrong current password')
    it('rejects new password shorter than 8 chars')
    it('rejects when user row not found')
```

### Tests — `tests/unit/services/hug_service.test.ts` (5 cases)

```
describe('HugService')
  it('generate_hug_token returns token on success')
  it('generate_hug_token returns error when HUG server fails')
  it('generate_hug_token returns error when HUG server is unreachable')
  it('generate_hug_token returns error when HUG not configured')
  it('get_hug_status returns configured status based on env')
```

### Tests — `tests/unit/controllers/account_controller.test.ts` (4 cases)

```
describe('AccountController')
  it('update_profile returns 401 when not authenticated')
  it('update_profile rejects when no fields provided')
  it('change_password returns 401 when not authenticated')
  it('change_password rejects missing current_password')
```

### Tests — `tests/unit/controllers/hug_controller.test.ts` (2 cases)

```
describe('HugController')
  it('generate returns 401 when not authenticated')
  it('status returns 401 when not authenticated')
```

### Tests — `tests/integration/account.test.ts` (17 cases)

```
describe('Account + HUG endpoints')
  describe('POST /api/account/update_profile')
    it('returns 200 updating display_name')
    it('returns 200 updating email')
    it('returns 200 updating both')
    it('returns 409 for email conflict')
    it('returns 422 for invalid email')
    it('returns 422 for empty display_name')
    it('returns 401 when not authenticated')
  describe('POST /api/account/change_password')
    it('returns 200 on successful change')
    it('returns 401 for wrong current password')
    it('returns 422 for short new password')
    it('returns 401 when not authenticated')
  describe('POST /api/hug/generate_token')
    it('returns 200 with HUG token')
    it('returns 500 when HUG server fails')
    it('returns 400 when HUG not configured')
    it('returns 401 when not authenticated')
  describe('GET /api/hug/status')
    it('returns 200 with configured true')
    it('returns 401 when not authenticated')
```

### Slice 29 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Service | `account_service.test.ts` | 12 |
| Unit — Service | `hug_service.test.ts` | 5 |
| Unit — Controller | `account_controller.test.ts` | 4 |
| Unit — Controller | `hug_controller.test.ts` | 2 |
| Integration | `account.test.ts` | 17 |
| **Total** | | **40** |

**Cumulative backend test count after Slice 29: 335**

---

## Slice 30 — Organizations

**Goal**: 11 org endpoints. Org-admin RBAC. Last-admin protection.

### Tests — `tests/unit/repositories/org_repository.test.ts` (6 cases)

```
describe('OrgRepository')
  it('find_by_id returns org when found')
  it('find_by_id returns null when not found')
  it('find_by_slug returns id when found')
  it('create inserts org and returns id')
  it('update_display_name modifies name')
  it('delete removes org')
```

### Tests — `tests/unit/repositories/org_member_repository.test.ts` (8 cases)

```
describe('OrgMemberRepository')
  it('find_by_org_and_user returns role')
  it('find_by_org_and_user returns null for non-member')
  it('list_members_by_org returns all members')
  it('count_admins_by_org returns admin count')
  it('create inserts membership')
  it('update_role changes member role')
  it('delete_by_org_and_user removes membership')
  it('list_my_orgs returns orgs for user')
```

### Tests — `tests/unit/repositories/scope_member_repository.test.ts` (7 cases)

```
describe('ScopeMemberRepository')
  it('find_by_scope_and_user returns match')
  it('create inserts scope member')
  it('create_on_conflict_ignore skips duplicate')
  it('delete_by_scope_and_user removes member')
  it('delete_by_scope_id removes all members of scope')
  it('delete_by_user_and_org_scopes removes user from all org scopes')
  it('delete_by_org_scopes removes all members from all org scopes')
```

### Tests — `tests/unit/services/orgs_service.test.ts` (22 cases)

```
describe('OrgsService')
  it('list_my_orgs returns user orgs with counts')
  it('get_org returns org detail for member')
  it('get_org returns org detail for site admin')
  it('get_org rejects non-member')
  it('update_org updates display_name for org admin')
  it('update_org rejects non-org-admin')
  it('add_member adds user to org')
  it('add_member rejects non-existent user')
  it('add_member rejects duplicate member')
  it('add_member rejects non-org-admin')
  it('remove_member removes and cleans scope_members')
  it('remove_member rejects removing last admin')
  it('remove_member rejects non-org-admin')
  it('set_member_role promotes member to admin')
  it('set_member_role rejects demoting last admin')
  it('set_member_role rejects invalid role')
  it('leave_org removes self and cleans scope_members')
  it('leave_org rejects when last admin')
  it('create_org_scope creates scope with org prefix')
  it('create_org_scope rejects slug not matching org prefix')
  it('create_org_scope rejects duplicate slug')
  it('create_org_scope auto-assigns org admins to scope')
  it('delete_org_scope deletes scope and cleans members')
  it('delete_org_scope rejects default scope')
  it('delete_org_scope rejects scope with teams')
  it('assign_scope_member assigns org member to scope')
  it('assign_scope_member rejects non-org-member')
  it('assign_scope_member rejects duplicate assignment')
  it('unassign_scope_member removes member from scope')
  site_admin_bypass:
  it('site admin can get_org without membership')
  it('site admin can update_org without membership')
```

### Tests — `tests/unit/controllers/orgs_controller.test.ts` (6 cases)

```
describe('OrgsController')
  it('get_org rejects non-integer org_id')
  it('add_member rejects missing username')
  it('set_member_role rejects invalid role value')
  it('create_org_scope rejects missing slug')
  it('assign_scope_member rejects missing user_id')
  it('leave rejects non-integer org_id')
```

### Tests — `tests/integration/orgs.test.ts` (30 cases)

```
describe('Org endpoints')
  describe('POST /api/orgs/list')
    it('returns 200 with user orgs')
    it('returns 401 when not authenticated')
  describe('POST /api/orgs/get')
    it('returns 200 for org member')
    it('returns 200 for site admin')
    it('returns 403 for non-member')
    it('returns 401 when not authenticated')
  describe('POST /api/orgs/update')
    it('returns 200 updating display_name')
    it('returns 403 for non-admin member')
  describe('POST /api/orgs/members/add')
    it('returns 200 adding member')
    it('returns 404 for non-existent user')
    it('returns 409 for duplicate member')
    it('returns 403 for non-admin')
  describe('POST /api/orgs/members/remove')
    it('returns 200 removing member')
    it('returns 409 removing last admin')
    it('returns 403 for non-admin')
  describe('POST /api/orgs/members/set_role')
    it('returns 200 promoting to admin')
    it('returns 409 demoting last admin')
    it('returns 422 for invalid role')
  describe('POST /api/orgs/leave')
    it('returns 200 leaving org')
    it('returns 409 when last admin')
  describe('POST /api/orgs/scopes/create')
    it('returns 200 creating scope')
    it('returns 422 for slug not matching org prefix')
    it('returns 409 for duplicate slug')
  describe('POST /api/orgs/scopes/delete')
    it('returns 200 deleting empty scope')
    it('returns 409 for scope with teams')
    it('returns 409 for default scope')
  describe('POST /api/orgs/scopes/assign')
    it('returns 200 assigning member')
    it('returns 409 for non-org-member')
    it('returns 409 for duplicate')
  describe('POST /api/orgs/scopes/unassign')
    it('returns 200 unassigning member')
    it('returns 403 for non-admin')
```

### Slice 30 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Repository | `org_repository.test.ts` | 6 |
| Unit — Repository | `org_member_repository.test.ts` | 8 |
| Unit — Repository | `scope_member_repository.test.ts` | 7 |
| Unit — Service | `orgs_service.test.ts` | 22 |
| Unit — Controller | `orgs_controller.test.ts` | 6 |
| Integration | `orgs.test.ts` | 30 |
| **Total** | | **79** |

**Cumulative backend test count after Slice 30: 414**

---

## Slice 31 — Builder (No DB)

**Goal**: LLM orchestration — zero DB access. 5 endpoints.

### Tests — `tests/unit/services/builder_service.test.ts` (28 cases)

```
describe('BuilderService')
  describe('generate')
    it('returns generated team from LLM response')
    it('returns error for empty intent')
    it('returns error for missing intent')
    it('returns error when LLM throws')
    it('normalises team name to kebab-case')
    it('parses sources and targets from LLM response')
  describe('improve_role')
    it('returns improved role content')
    it('returns error for missing role_name')
    it('returns error for missing role_content')
    it('returns error when LLM throws')
  describe('suggest')
    it('returns suggestions for team')
    it('returns error for missing team_name')
  describe('validate')
    it('returns valid for well-formed team')
    it('returns errors for empty team')
    it('detects duplicate phase names')
    it('detects unknown dependency')
    it('validates pull/push phases')
    it('detects source entry with empty url')
    it('detects source entry with empty name')
    it('detects target entry with empty file')
    it('detects target entry with empty destination')
    it('validates hug phase structure')
    it('warns when hug phase has no commands')
    it('detects invalid phase type')
    it('errors when declared input not referenced')
  describe('chat')
    it('returns reply and actions on success')
    it('returns error for missing team')
    it('returns error for empty message')
    it('filters out invalid action types')
```

### Tests — `tests/unit/services/llm/hosted_adapter.test.ts` (10 cases)

```
describe('HostedLlmAdapter')
  it('calls OpenAI API with correct format')
  it('calls Anthropic API with correct format')
  it('calls Google API with correct format')
  it('throws for unsupported provider')
  it('uses custom API key from env')
  it('uses custom model from env')
  it('returns parsed content from OpenAI response')
  it('returns parsed content from Anthropic response')
  it('throws on API error response')
  it('throws on network error')
```

### Tests — `tests/unit/controllers/builder_controller.test.ts` (5 cases)

```
describe('BuilderController')
  it('generate rejects missing intent')
  it('improve_role rejects missing role_name')
  it('suggest rejects missing team_name')
  it('validate rejects missing team')
  it('chat rejects missing message')
```

### Tests — `tests/integration/builder.test.ts` (15 cases)

```
describe('Builder endpoints')
  describe('POST /api/builder/generate')
    it('returns 200 with generated team')
    it('returns 422 for empty intent')
    it('returns 401 for unauthenticated + wrong origin')
    it('returns 200 for allowed origin without JWT')
  describe('POST /api/builder/improve_role')
    it('returns 200 with improved role')
    it('returns 422 for missing fields')
  describe('POST /api/builder/suggest')
    it('returns 200 with suggestions')
    it('returns 422 for missing team_name')
  describe('POST /api/builder/validate')
    it('returns 200 with valid result')
    it('returns 200 with errors for invalid team')
    it('returns 422 for missing team')
  describe('POST /api/builder/chat')
    it('returns 200 with reply')
    it('returns 422 for missing message')
    it('returns 422 for missing team')
    it('returns 200 with history forwarded')
```

### Slice 31 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Service | `builder_service.test.ts` | 28 |
| Unit — Service | `hosted_adapter.test.ts` | 10 |
| Unit — Controller | `builder_controller.test.ts` | 5 |
| Integration | `builder.test.ts` | 15 |
| **Total** | | **58** |

**Cumulative backend test count after Slice 31: 472**

---

## Slice 32 — Admin: Users + Scopes

**Goal**: 15 admin endpoints — user CRUD + scope CRUD + stats + audit log.

### Tests — `tests/unit/repositories/audit_repository.test.ts` (4 cases)

```
describe('AuditRepository')
  it('create inserts audit log entry')
  it('list_paginated returns entries ordered by created_at desc')
  it('count_filtered returns total count')
  it('count_filtered applies action and admin_id filters')
```

### Tests — `tests/unit/repositories/settings_repository.test.ts` (4 cases)

```
describe('SettingsRepository')
  it('find_by_key returns value when found')
  it('find_by_key returns null when not found')
  it('create inserts new setting')
  it('update_by_key modifies existing setting')
```

### Tests — `tests/unit/services/admin_service.test.ts` (36 cases, users + scopes)

```
describe('AdminService — users + scopes')
  describe('list_users')
    it('returns paginated users')
    it('applies search filter on username and email')
  describe('get_user')
    it('returns user with scope/team/token/draft counts and orgs')
    it('returns not_found for missing user')
  describe('suspend_user')
    it('suspends user and logs audit')
    it('rejects self-suspension')
    it('rejects protected username')
    it('returns not_found for missing user')
  describe('unsuspend_user')
    it('unsuspends user and logs audit')
    it('returns not_found for missing user')
  describe('delete_user')
    it('deletes user with cascade counts and logs audit')
    it('rejects self-deletion')
    it('rejects protected username')
    it('returns not_found for missing user')
    it('calls HUG server to revoke user tokens')
  describe('reset_password')
    it('resets password and logs audit')
    it('rejects short password')
    it('returns not_found for missing user')
  describe('set_role')
    it('promotes user to admin and logs')
    it('demotes admin when more than one exists')
    it('rejects self-demotion')
    it('rejects removing last admin')
    it('rejects demoting protected username')
    it('returns not_found for missing user')
  describe('create_user')
    it('creates user with scope and logs audit')
    it('rejects duplicate username or email')
    it('rejects invalid slug format')
    it('rejects reserved slug')
    it('rejects short password')
    it('rejects invalid email')
  describe('update_user')
    it('updates email and display_name')
    it('rejects email conflict')
    it('rejects empty display_name')
    it('returns false when no changes')
    it('returns not_found for missing user')
  describe('list_scopes')
    it('returns paginated scopes')
  describe('create_scope')
    it('creates scope and logs audit')
    it('rejects duplicate slug')
    it('rejects reserved slug')
    it('rejects invalid slug format')
  describe('update_scope')
    it('updates visibility and logs')
    it('returns not_found for missing scope')
  describe('delete_scope')
    it('deletes empty scope and logs')
    it('rejects scope with teams')
```

### Tests — `tests/unit/services/settings_service.test.ts` (5 cases)

```
describe('SettingsService')
  it('get_setting returns null for missing key')
  it('get_setting returns cached value within TTL')
  it('get_setting refreshes after TTL expires')
  it('set_setting inserts when key does not exist')
  it('set_setting updates and invalidates cache')
```

### Tests — `tests/unit/controllers/admin_controller.test.ts` (8 cases, users + scopes)

```
describe('AdminController — users + scopes')
  it('list_users rejects limit > 100')
  it('suspend_user rejects missing user_id')
  it('create_user rejects missing username')
  it('create_user rejects invalid email')
  it('create_scope rejects missing slug')
  it('create_scope rejects non-integer owner_id')
  it('delete_scope rejects missing scope_id')
  it('set_role rejects invalid role value')
```

### Tests — `tests/integration/admin_users_scopes.test.ts` (35 cases)

```
describe('Admin user + scope endpoints')
  describe('POST /api/admin/users/list')
    it('returns 200 with user list')
    it('returns 200 with search filter')
    it('returns 403 for non-admin')
  describe('POST /api/admin/users/get')
    it('returns 200 with user detail')
    it('returns 404 for missing user')
  describe('POST /api/admin/users/suspend')
    it('returns 200 suspending user')
    it('returns 403 for self-suspension')
    it('returns 403 for protected user')
  describe('POST /api/admin/users/unsuspend')
    it('returns 200 unsuspending user')
  describe('POST /api/admin/users/delete')
    it('returns 200 deleting user')
    it('returns 403 for self-deletion')
    it('returns 403 for protected user')
  describe('POST /api/admin/users/reset_password')
    it('returns 200 resetting password')
    it('returns 422 for short password')
  describe('POST /api/admin/users/set_role')
    it('returns 200 promoting to admin')
    it('returns 200 demoting admin')
    it('returns 403 for self-demotion')
    it('returns 409 for last admin')
  describe('POST /api/admin/users/create')
    it('returns 200 creating user')
    it('returns 409 for duplicate')
    it('returns 422 for reserved slug')
    it('returns 422 for invalid email')
  describe('POST /api/admin/users/update')
    it('returns 200 updating user')
    it('returns 409 for email conflict')
  describe('POST /api/admin/scopes/list')
    it('returns 200 with scope list')
  describe('POST /api/admin/scopes/create')
    it('returns 200 creating scope')
    it('returns 409 for duplicate slug')
    it('returns 422 for reserved slug')
  describe('POST /api/admin/scopes/update')
    it('returns 200 updating visibility')
  describe('POST /api/admin/scopes/delete')
    it('returns 200 deleting empty scope')
    it('returns 409 for scope with teams')
  describe('POST /api/admin/stats')
    it('returns 200 with aggregate stats')
  describe('POST /api/admin/audit')
    it('returns 200 with audit entries')
    it('returns 200 with action filter')
```

### Slice 32 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Repository | `audit_repository.test.ts` | 4 |
| Unit — Repository | `settings_repository.test.ts` | 4 |
| Unit — Service | `admin_service.test.ts` (users+scopes) | 36 |
| Unit — Service | `settings_service.test.ts` | 5 |
| Unit — Controller | `admin_controller.test.ts` (users+scopes) | 8 |
| Integration | `admin_users_scopes.test.ts` | 35 |
| **Total** | | **92** |

**Cumulative backend test count after Slice 32: 564**

---

## Slice 33 — Admin: Teams + Tokens + Orgs + Stats + Audit

**Goal**: Remaining 10 admin endpoints.

### Tests — `tests/unit/services/admin_service.test.ts` (32 additional cases)

```
describe('AdminService — teams + tokens + orgs')
  describe('admin_list_teams')
    it('returns paginated teams')
    it('filters by scope')
    it('filters by listed status')
    it('applies search filter')
  describe('admin_set_listed')
    it('force-lists team and logs')
    it('force-unlists team and logs')
    it('returns not_found for missing team')
  describe('admin_delete_team')
    it('deletes team and logs with version count')
    it('returns not_found for missing team')
  describe('admin_transfer_team')
    it('transfers team to new author')
    it('transfers with scope change')
    it('rejects name conflict in new scope')
    it('returns not_found for missing team')
    it('returns not_found for missing new author')
    it('rejects non-existent new scope')
  describe('admin_list_tokens')
    it('returns paginated tokens')
    it('filters by user_id')
  describe('admin_revoke_token')
    it('revokes token and logs')
    it('returns not_found for missing token')
  describe('admin_list_orgs')
    it('returns paginated orgs')
    it('applies search filter')
  describe('admin_create_org')
    it('creates org with existing user')
    it('creates org with new user inline')
    it('rejects duplicate org slug')
    it('rejects reserved slug')
    it('rejects if scope slug taken')
    it('rejects missing email when creating user')
  describe('admin_delete_org')
    it('deletes empty org and cascades')
    it('rejects org with teams')
    it('returns not_found for missing org')
  describe('admin_stats')
    it('returns aggregated counts across all tables')
  describe('admin_audit_log')
    it('returns paginated entries')
    it('filters by admin_id')
```

### Tests — `tests/unit/controllers/admin_controller.test.ts` (6 additional cases)

```
describe('AdminController — teams + tokens + orgs')
  it('admin_set_listed rejects missing team_id')
  it('admin_transfer_team rejects missing new_author_id')
  it('admin_revoke_token rejects missing token_id')
  it('admin_create_org rejects missing slug')
  it('admin_create_org rejects invalid slug format')
  it('admin_delete_org rejects missing org_id')
```

### Tests — `tests/integration/admin_teams_tokens_orgs.test.ts` (30 cases)

```
describe('Admin teams + tokens + orgs endpoints')
  describe('POST /api/admin/teams/list')
    it('returns 200 with teams')
    it('returns 200 filtered by scope')
    it('returns 200 filtered by listed')
    it('returns 403 for non-admin')
  describe('POST /api/admin/teams/set_listed')
    it('returns 200 setting listed')
    it('returns 404 for missing team')
  describe('POST /api/admin/teams/delete')
    it('returns 200 deleting team')
    it('returns 404 for missing team')
  describe('POST /api/admin/teams/transfer')
    it('returns 200 transferring team')
    it('returns 409 for name conflict')
    it('returns 404 for missing author')
  describe('POST /api/admin/tokens/list')
    it('returns 200 with tokens')
    it('returns 200 filtered by user_id')
    it('returns 403 for non-admin')
  describe('POST /api/admin/tokens/revoke')
    it('returns 200 revoking token')
    it('returns 404 for missing token')
  describe('POST /api/admin/orgs/list')
    it('returns 200 with orgs')
    it('returns 200 with search filter')
    it('returns 403 for non-admin')
  describe('POST /api/admin/orgs/create')
    it('returns 200 creating org with existing user')
    it('returns 200 creating org with new user')
    it('returns 409 for duplicate slug')
    it('returns 422 for reserved slug')
    it('returns 409 for existing scope slug')
  describe('POST /api/admin/orgs/delete')
    it('returns 200 deleting empty org')
    it('returns 409 for org with teams')
    it('returns 404 for missing org')
  describe('POST /api/admin/stats')
    it('returns 200 with all stats')
    it('returns 403 for non-admin')
  describe('POST /api/admin/audit')
    it('returns 200 with audit entries')
    it('returns 200 filtered by action')
```

### Slice 33 totals

| Layer | File | Cases |
|-------|------|-------|
| Unit — Service | `admin_service.test.ts` (teams+tokens+orgs) | 32 |
| Unit — Controller | `admin_controller.test.ts` (teams+tokens+orgs) | 6 |
| Integration | `admin_teams_tokens_orgs.test.ts` | 30 |
| **Total** | | **68** |

**Cumulative backend test count after Slice 33: 632**

---

## Slice 34 — Cutover: Nginx + Docker + BFF Rewire

**Goal**: Route all API traffic to new Express backend.

### Changes

| File | Change |
|------|--------|
| `docker-compose.yml` | Add `backend` service. Update `bff` `BACKEND_URL` → `http://backend:4000` |
| `services/nginx/nginx.conf.template` | Update `$api_upstream` for CLI to point to Express backend |
| `cliq/src/commands/hub_command.ts` | No change — CLI already talks to `/api/*` via nginx |
| Root `package.json` | Add `dev:backend` script, update `dev` to run all three |

### Tests — `tests/integration/proxy.test.ts` (5 cases)

Location: `cliqhub/services/backend/tests/integration/proxy.test.ts`

```
describe('proxy routing')
  it('BFF can reach backend /api/auth/me')
  it('BFF can reach backend /api/teams/list')
  it('health endpoint responds on backend port')
  it('404 for non-existent route')
  it('error_handler returns JSON for backend errors')
```

### Smoke tests (10 manual/E2E)

Run existing E2E suite + BFF integration suite + CLI tests against new backend.

### Slice 34 totals

| Layer | File | Cases |
|-------|------|-------|
| Integration | `proxy.test.ts` | 5 |
| E2E (existing suite) | re-run | 10 |
| **Total** | | **15** |

**Cumulative backend test count after Slice 34: 647**

---

## Slice 35 — Frontend Validation Bug Fixes

**Goal**: Fix 6 confirmed frontend bugs. Tests go into BFF's E2E dir.

### Bug fixes (in `cliqhub/app/`)

| Bug | File | Fix |
|-----|------|-----|
| Empty display_name bypass | `account/settings/page.tsx` | Use `validate_display_name()` |
| Email can be cleared | `account/settings/page.tsx` | Use `validate_email()`, require non-empty |
| 1-char + reserved slugs | `admin/orgs/page.tsx` | Use `validate_slug()` |
| NaN owner_id | `admin/scopes/page.tsx` | Add `Number.isNaN()` check |
| No validation on user create | `admin/users/page.tsx` | Add `validate_slug()`, `validate_email()`, `validate_password()` |
| No validation on user edit | `admin/users/page.tsx` | Add `validate_display_name()`, `validate_email()` |

### Tests — `cliqhub/services/bff/e2e/account.spec.ts` (8 new cases)

```
describe('account settings validation')
  it('rejects empty display name with error banner')
  it('rejects display name over 100 chars')
  it('rejects empty email')
  it('rejects invalid email format')
  it('saves valid display name')
  it('saves valid email')
  it('saves both display name and email')
  it('preserves values on validation error')
```

### Tests — `cliqhub/services/bff/e2e/admin.spec.ts` (12 new cases)

```
describe('admin form validation')
  it('create user rejects empty username')
  it('create user rejects invalid email')
  it('create user rejects short password')
  it('create user rejects reserved username')
  it('edit user rejects empty display name')
  it('edit user rejects invalid email')
  it('create org rejects 1-char slug')
  it('create org rejects reserved slug')
  it('create scope rejects 1-char slug')
  it('create scope rejects reserved slug')
  it('create scope rejects non-numeric owner_id')
  it('create scope accepts valid inputs')
```

### Slice 35 totals

| Layer | Location | Cases |
|-------|----------|-------|
| E2E | `bff/e2e/account.spec.ts` | 8 |
| E2E | `bff/e2e/admin.spec.ts` | 12 |
| **Total** | | **20** |

---

## Slice 36 — E2E Test Expansion

**Goal**: Fill 65 missing E2E scenarios. All in `cliqhub/services/bff/e2e/`.

### Tests — `bff/e2e/tokens.spec.ts` (8 cases, new file)

```
describe('token management')
  it('creates API token from account page')
  it('lists tokens after creation')
  it('revokes token')
  it('revoked token no longer appears in list')
  it('rejects empty token name gracefully')
  it('shows token value only once after creation')
  it('multiple tokens can be created')
  it('cannot revoke already revoked token')
```

### Tests — `bff/e2e/auth.spec.ts` (6 additional cases)

```
  it('signup rejects empty username')
  it('signup rejects duplicate username')
  it('signup rejects reserved username')
  it('login rejects wrong password')
  it('expired session redirects to login')
  it('signup rejects short password')
```

### Tests — `bff/e2e/teams.spec.ts` (12 additional cases)

```
  it('publish team from builder')
  it('download published team')
  it('rename team from account page')
  it('toggle listed from account page')
  it('delete version from team detail')
  it('search teams by keyword')
  it('search teams by domain filter')
  it('browse teams with pagination')
  it('view team detail page')
  it('view specific version')
  it('private team hidden from public browse')
  it('scope member can see private team')
```

### Tests — `bff/e2e/drafts.spec.ts` (6 additional cases)

```
  it('save new draft from builder')
  it('resume draft in builder')
  it('update draft title')
  it('delete draft from account page')
  it('draft appears in account teams list')
  it('other user cannot access draft')
```

### Tests — `bff/e2e/admin.spec.ts` (18 additional cases)

```
  it('create user from admin panel')
  it('suspend user from admin panel')
  it('unsuspend user')
  it('delete user')
  it('reset user password')
  it('promote user to admin')
  it('create scope')
  it('update scope visibility')
  it('delete empty scope')
  it('transfer team to different user')
  it('force-list team')
  it('admin delete team')
  it('revoke API token from admin')
  it('view stats dashboard')
  it('filter audit log by action')
  it('create org from admin')
  it('delete empty org')
  it('admin user list pagination')
```

### Tests — `bff/e2e/orgs.spec.ts` (10 additional cases)

```
  it('create org and see it in list')
  it('add member to org')
  it('remove member from org')
  it('promote member to org admin')
  it('leave org as non-admin member')
  it('cannot leave org as last admin')
  it('create org scope')
  it('delete empty org scope')
  it('assign member to org scope')
  it('unassign member from org scope')
```

### Tests — `bff/e2e/rbac.spec.ts` (5 additional cases)

```
  it('user cannot access other org resources')
  it('user cannot access admin panel')
  it('scope member can publish to shared scope')
  it('non-scope member cannot publish to scope')
  it('draft is only visible to owner')
```

### Slice 36 totals

| Layer | Location | Cases |
|-------|----------|-------|
| E2E | `tokens.spec.ts` | 8 |
| E2E | `auth.spec.ts` | 6 |
| E2E | `teams.spec.ts` | 12 |
| E2E | `drafts.spec.ts` | 6 |
| E2E | `admin.spec.ts` | 18 |
| E2E | `orgs.spec.ts` | 10 |
| E2E | `rbac.spec.ts` | 5 |
| **Total** | | **65** |

---

## Slice 37 — Cleanup: Remove Next.js API Layer

**Goal**: Delete all `app/api/` routes, `lib/handlers/`, and supporting files
that have been migrated to Express backend.

### Deletions from `cliqhub/`

| Path | Count |
|------|-------|
| `app/api/**/*.ts` | ~65 route.ts files |
| `lib/handlers/*.ts` | 9 handler modules |
| `lib/route_helper.ts` | 1 |
| `lib/admin.ts` | 1 |
| `lib/auth.ts` | 1 |
| `lib/rate_limit.ts` | 1 |
| `lib/storage.ts` | 1 |
| `lib/access.ts` | 1 |
| `lib/db.ts` | 1 |
| `tests/handlers/**/*.test.ts` | 14 old test files (replaced by backend service tests) |
| `tests/access.test.ts` | 1 |

### Kept in `cliqhub/`

| Path | Why |
|------|-----|
| `app/` (pages, layouts, components) | SSR + client rendering |
| `lib/bff-fetch.ts` | SSR calls to BFF |
| `lib/validation.ts` | Frontend validation |
| `lib/types.ts` | Frontend types (pruned) |
| `lib/team-export.ts` | Builder YAML export |
| `lib/config.ts` | Keep if frontend imports `SLUG_PATTERN` etc. |
| `tests/store.test.ts` | Frontend state tests |
| `tests/team-export.test.ts` | Frontend export tests |
| `tests/hosted-adapter.test.ts` | Move to backend service |

### Verification

| Check | Command |
|-------|---------|
| Backend tests | `cd cliqhub/services/backend && npm test` |
| BFF tests | `cd cliqhub/services/bff && npm test` |
| CLI tests | `cd cliq && npm test` |
| Next.js build | `cd cliqhub && npm run build` |
| TypeScript | `cd cliqhub && npx tsc --noEmit` |
| E2E | `cd cliqhub/services/bff && npm run test:e2e` |

---

## Grand Test Count Summary

### Backend tests by slice (cumulative)

| After Slice | Unit | Integration | Cumulative |
|-------------|------|-------------|------------|
| 23 | 19 | 3 | **22** |
| 24 | 63 | 3 | **66** |
| 25 | 89 | 25 | **114** |
| 26 | 137 | 41 | **178** |
| 27 | 184 | 63 | **257** ← after this, teams fully covered |
| 28 | 205 | 80 | **295** |
| 29 | 228 | 97 | **335** |
| 30 | 277 | 127 | **414** |
| 31 | 320 | 142 | **472** |
| 32 | 377 | 177 | **564** |
| 33 | 415 | 207 | **632** |
| 34 | 415 | 212 | **647** |

### Full project after all slices

| Area | Count |
|------|-------|
| New backend unit tests | 415 |
| New backend integration tests | 212 |
| BFF unit + integration tests | ~475 |
| CLI unit tests | ~50 |
| Frontend tests (store, export) | ~50 |
| E2E tests | ~124 (29 existing + 20 bug-fix + 65 expansion + 10 smoke) |
| **Grand total** | **~1,326** |

---

## Parallelization

```
Slice 23 (Foundation)                          ← must be first
  ↓
Slice 24 (Auth middleware)                     ← must be second
  ↓
Slice 25 (Auth endpoints)                     ← unblocks all domain slices
  ↓
  ├──→ Slice 26 (Teams read)
  │      ↓
  │    Slice 27 (Teams write)
  │
  ├──→ Slice 28 (Drafts)       ← parallel with 29, 31
  ├──→ Slice 29 (Account+HUG)  ← parallel with 28, 31
  ├──→ Slice 30 (Orgs)         ← parallel with 28, 29, 31
  └──→ Slice 31 (Builder)      ← parallel with 28, 29, 30
  ↓
Slice 32 (Admin users+scopes)                 ← needs user + scope repos from earlier
  ↓
Slice 33 (Admin teams+tokens+orgs)            ← needs team + token + org repos
  ↓
Slice 34 (Cutover)                            ← all endpoints must exist
  ↓
  ├──→ Slice 35 (Frontend bug fixes)          ← parallel with 36
  └──→ Slice 36 (E2E expansion)              ← parallel with 35
  ↓
Slice 37 (Cleanup)                            ← last
```

---

## Execution Rules

1. **Every slice merges with its own tests passing** — no test debt carried forward
2. **Old Next.js backend stays running** until Slice 34 cutover completes
3. **BFF is unchanged** — continues calling `/api/*` which routes to Express after cutover
4. **snake_case everywhere** — all variables, functions, methods
5. **Early returns only** — no else/else-if
6. **Shared fixtures** — `ALICE`, `BOB`, `SITE_ADMIN` from `tests/helpers/fixtures.ts`
7. **`npm test` must pass** in `cliqhub/services/backend/` after every slice
