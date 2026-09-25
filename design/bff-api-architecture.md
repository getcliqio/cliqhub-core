# BFF API Architecture — Layered Refactor

## Overview

This document describes the architectural refactor of the CliqHub BFF from a
thin reverse proxy into a properly layered Express API gateway. The BFF
serves the React frontend exclusively — it owns session management,
validation, and type mapping for browser clients. The cliq CLI continues to
talk directly to the Next.js backend, as it does today.

```
┌──────────────────┐
│  React Frontend  │
│  (Next.js, UI)   │T
└───────┬──────────┘
        │
        │  POST /api/*
        │  Cookie: cliqhub_sid
        ▼
┌─────────────────────────────────────────────────┐
│              BFF  (Express 5)                   │
│                                                 │
│   routes.ts  ──▶  controllers/  ──▶  services/  │
│                                        │        │
│                                   repositories/ │
│                                        │        │
│                                   ┌────▼─────┐  │
│                                   │ api_client│  │
│                                   └────┬─────┘  │
│                                        │        │
│   ┌──────────────┐                     │        │
│   │  PostgreSQL   │  (bff.sessions)    │        │
│   └──────────────┘                     │        │
└────────────────────────────────────────┼────────┘
                                         │
                              fetch POST /api/*
                              Authorization: Bearer <jwt>
                                         │
┌──────────────────┐                     │
│  cliq CLI        │                     │
│                  │                     │
└───────┬──────────┘                     │
        │                                │
        │  POST /api/*                   │
        │  Authorization: Bearer <token> │
        ▼                                ▼
       ┌──────────────────────────────────┐
       │        Next.js Backend           │
       │        (existing routes)         │
       │             │                    │
       │       PostgreSQL + R2            │
       └──────────────────────────────────┘
```

### Why the CLI Bypasses the BFF

The BFF exists to solve browser-specific problems:

- **Session management** — HttpOnly cookies, idle timeout, CSRF protection.
  The CLI uses Bearer tokens stored in `~/.cliqrc/settings.json`. It has no
  use for cookies or sessions.
- **Type mapping** — DTOs protect the frontend from backend changes.
  The CLI has its own response types in `hub_command.ts` and doesn't consume
  the BFF's DTOs.
- **Validation** — zod schemas at the BFF catch malformed browser requests
  early. The CLI is a controlled client that already sends well-formed
  requests, and the backend validates too.

Routing the CLI through the BFF would add an extra HTTP hop for zero
benefit. The CLI talks to the backend directly — one hop, no overhead.

---

## Problem

The current architecture has several structural issues:

1. **70 Next.js route files**, each 4–6 lines of boilerplate delegating to a
   handler function. The route layer adds no value.
2. **Everything is POST** with verbs encoded in paths (`/teams/delete`,
   `/admin/users/suspend`), but there is no input validation at the route level.
3. **The BFF is a pass-through proxy** (~300 lines) that only intercepts 4 auth
   routes. It adds an HTTP hop but almost no functionality.
4. **Next.js serves both UI and API** in one process — frontend and backend are
   coupled at deployment, testing, and scaling boundaries.
5. **SSR pages bypass the API** with direct DB queries (`get_team()`,
   `query()`) — two data paths for the same data.
6. **No DTO boundary** — the React frontend consumes raw backend types
   directly, making future API evolution brittle.
7. **No parameter validation** — `route_helper.ts` casts `params as { ... }`
   with zero runtime checking.
8. **11 API routes have no callers** — dead code in production.

---

## Solution

Rebuild the BFF as a properly layered Express API gateway:

- **Routes** → **Controllers** → **Services** → **Repositories**
- Repositories call the existing Next.js backend API via HTTP
- PostgreSQL for BFF session storage (reuses the existing database, isolated in `bff` schema)
- DTOs with explicit `to_*_dto` mappers (even when 1:1 today)
- Zod validation on every route
- Remove the 11 dead routes
- All routes are POST with flat `snake_case` paths

The Next.js backend stays as-is — it continues to own PostgreSQL and R2.
The BFF sits in front as the client-facing API for browser clients. The
cliq CLI bypasses the BFF and talks directly to the backend.

---

## Directory Structure

```
cliqhub/services/bff/
├── src/
│   ├── server.ts
│   ├── app.ts
│   ├── routes.ts
│   │
│   ├── config/
│   │   └── env.ts
│   │
│   ├── middleware/
│   │   ├── session_auth.ts
│   │   ├── error_handler.ts
│   │   ├── csrf_guard.ts
│   │   └── rate_limit.ts
│   │
│   ├── controllers/
│   │   ├── base_controller.ts
│   │   ├── auth_controller.ts
│   │   ├── teams_controller.ts
│   │   ├── builder_controller.ts
│   │   ├── drafts_controller.ts
│   │   ├── orgs_controller.ts
│   │   ├── account_controller.ts
│   │   ├── admin_controller.ts
│   │   └── hug_controller.ts
│   │
│   ├── services/
│   │   ├── auth_service.ts
│   │   ├── teams_service.ts
│   │   ├── builder_service.ts
│   │   ├── drafts_service.ts
│   │   ├── orgs_service.ts
│   │   ├── account_service.ts
│   │   ├── admin_service.ts
│   │   └── hug_service.ts
│   │
│   ├── repositories/
│   │   ├── api_client.ts
│   │   ├── api_error.ts
│   │   ├── auth_repository.ts
│   │   ├── teams_repository.ts
│   │   ├── builder_repository.ts
│   │   ├── drafts_repository.ts
│   │   ├── orgs_repository.ts
│   │   ├── account_repository.ts
│   │   ├── admin_repository.ts
│   │   ├── hug_repository.ts
│   │   └── session_store.ts       (PostgreSQL-backed)
│   │
│   └── types/
│       ├── api_types.ts
│       ├── dto.ts
│       └── mappers.ts
│
├── tests/
│   ├── unit/
│   │   ├── controllers/
│   │   ├── services/
│   │   └── repositories/
│   ├── integration/
│   └── e2e/
│
├── .env                     (gitignored, DATABASE_URL etc.)
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── Dockerfile
```

---

## Layer Responsibilities

### Routes (`routes.ts`)

A single file that wires paths to controllers with zod validation middleware.
Contains zero business logic. Defines the public API contract.

- All paths are POST except `GET /health`
- Flat paths: `/api/teams/get_latest_version`, not `/api/teams/latest-version`
- All names use `snake_case`
- Public routes (no session required) are registered before the session guard
- Protected routes are registered after the session guard

### Controllers (`controllers/`)

Thin glue between HTTP and business logic. A controller method:

1. Reads `req.body` and `req.session_data`
2. Calls a service method
3. Calls `this.send_ok(res, data)` or lets the error handler catch errors

Controllers never access repositories directly. Controllers never contain
business logic, SQL, or HTTP calls to the backend.

Every controller extends `BaseController` which provides:

- `send_ok(res, data, status?)` — sends `{ ok: true, ...data }`
- `send_error(res, message, status, code?)` — sends `{ ok: false, error, code }`
- `AuthenticatedRequest` type with `session_data` attached

### Services (`services/`)

Business logic layer. A service:

1. Receives typed parameters from the controller (no `req`/`res` objects)
2. Calls one or more repository methods
3. Applies business rules (authorization, transformation, orchestration)
4. Maps API types to DTOs using `mappers.ts`
5. Returns DTOs to the controller

Services are stateless classes. They receive config and repositories via
constructor injection.

### Repositories (`repositories/`)

Data access layer. Each repository wraps HTTP calls to the Next.js backend
API via `ApiClient`. A repository method:

1. Calls `this._client.post<T>(path, body, token)`
2. Returns the raw API response typed as `api_types.ts`

Repositories contain no business logic and no type mapping.

### Session Store (`repositories/session_store.ts`)

The sole exception to the "repositories call the backend" rule. The session
store manages BFF sessions in PostgreSQL (`bff.sessions` table). It does not
call the backend API — sessions are a BFF concern, not a backend concern.

---

## Types

### `vo.ts` — Value Objects (Backend API Contract)

Types that mirror exactly what the Next.js backend returns. These are
Value Objects (VOs) — the "raw" types. Named with a `*VO` suffix.

```typescript
export interface TeamListItemVO {
    name: string;
    scope: string | null;
    description: string;
    domain: string;
    author: string | null;
    latest_version: string;
    install_count: number;
    tags: string[];
    listed?: boolean;
}

export interface TeamDetailVO extends TeamListItemVO {
    license: string;
    visibility: 'public' | 'private' | 'draft';
    created_at: string;
    updated_at: string;
    versions: { version: string; changelog: string; published_at: string }[];
    roles: { name: string; content_md: string }[];
    workflow: { phases: WorkflowPhaseVO[]; support?: WorkflowPhaseVO[] };
    agents: Record<string, AgentDefVO>;
    readme: string;
    cliq_version: string | null;
    tools: string[];
    inputs?: { name: string; description?: string }[];
    use_when?: string[];
    not_for?: string[];
}

export interface UserVO {
    id: number;
    username: string;
    display_name: string;
    email: string;
    role: 'user' | 'admin';
    suspended_at: string | null;
    suspended_reason: string;
    created_at: string;
}

export interface LoginResponseVO {
    token: string;
    user: UserVO;
    scopes: ScopeVO[];
}

// ... one interface per backend response shape
```

### `dto.ts` — Data Transfer Objects (BFF Public Contract)

Types that the BFF exposes to the React frontend. These are DTOs — Data
Transfer Objects that define the shape of data crossing the BFF boundary.
Named with a `DTO` suffix. Even when 1:1 with API types today, they exist
as a separate layer so the BFF can evolve its public contract independently
of the backend.

```typescript
export interface TeamListItemDTO {
    name: string;
    scope: string | null;
    description: string;
    domain: string;
    author: string | null;
    latest_version: string;
    install_count: number;
    tags: string[];
    listed?: boolean;
}

export interface UserDTO {
    id: number;
    username: string;
    display_name: string;
    email: string;
    role: 'user' | 'admin';
}

export interface SessionUserDTO {
    user_id: number;
    username: string;
    email: string;
    role: 'user' | 'admin';
}
```

Value Objects (VOs) are used within the service layer for internal domain
concepts that carry no identity — e.g., `ScopeVO`, `SessionPolicyVO`. VOs
are not exposed across the BFF boundary.

### `mappers.ts` — Type Conversion

Explicit conversion functions. Every field is mapped, even when the names
and types are identical. This makes the conversion visible and greppable,
and provides the insertion point when types diverge. Mapper functions
convert VOs (from the backend) into DTOs (for the frontend).

```typescript
import type { TeamListItemVO, UserVO } from './vo.js';
import type { TeamListItemDTO, UserDTO } from './dto.js';

export function to_team_list_item_dto(vo: TeamListItemVO): TeamListItemDTO {
    return {
        name: vo.name,
        scope: vo.scope,
        description: vo.description,
        domain: vo.domain,
        author: vo.author,
        latest_version: vo.latest_version,
        install_count: vo.install_count,
        tags: vo.tags,
        listed: vo.listed,
    };
}

export function to_user_dto(vo: UserVO): UserDTO {
    return {
        id: vo.id,
        username: vo.username,
        display_name: vo.display_name,
        email: vo.email,
        role: vo.role,
    };
}
```

---

## Session Management

### Storage: PostgreSQL

Sessions live in the existing PostgreSQL database under the `bff` schema
(`bff.sessions` table). This reuses the database the app already depends on,
avoids introducing a second data store, and supports horizontal scaling if
the BFF is ever run as multiple instances.

### Schema

```sql
CREATE SCHEMA IF NOT EXISTS bff;

CREATE TABLE IF NOT EXISTS bff.sessions (
    session_id    TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    username      TEXT NOT NULL,
    email         TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    token         TEXT NOT NULL,
    scopes_json   TEXT NOT NULL DEFAULT '[]',
    org_slugs_json TEXT NOT NULL DEFAULT '[]',
    created_at    BIGINT NOT NULL,
    last_active   BIGINT NOT NULL,
    expires_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON bff.sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON bff.sessions(user_id);
```

### `SessionStore` API

```typescript
export class SessionStore {
    constructor(pool: pg.Pool, config: EnvConfig);

    async init(): Promise<void>;  // creates schema + table if missing
    async create(record: SessionRecord): Promise<string>;
    async find(session_id: string): Promise<SessionRecord | null>;
    async touch(session_id: string): Promise<void>;
    async destroy(session_id: string): Promise<void>;
    async destroy_user(user_id: number): Promise<void>;
    async prune_expired(): Promise<number>;
    async close(): Promise<void>;
}
```

`prune_expired()` is called on a 5-minute interval to clean up stale rows.

### Session Policies

| Env Var | Default | Description |
|---------|---------|-------------|
| `SESSION_SECRET` | (required in production) | Secret for generating session IDs |
| `SESSION_TTL_SECONDS` | `2592000` (30 days) | Absolute session lifetime |
| `SESSION_IDLE_SECONDS` | `7200` (2 hours) | Idle timeout |
| `SESSION_COOKIE_NAME` | `cliqhub_sid` | HttpOnly cookie name |

### Cookie Security

| Attribute | Value | Rationale |
|-----------|-------|-----------|
| `httpOnly` | `true` | JS cannot read the cookie |
| `secure` | `true` in production | HTTPS only |
| `sameSite` | `lax` | CSRF protection |
| `path` | `/` | Sent on all paths |

---

## Auth Flows

### Browser Login

1. Browser `POST /api/auth/login` with `{ username, password }`.
2. `routes.ts` validates body with `LoginSchema`.
3. `AuthController.login()` calls `AuthService.login()`.
4. `AuthService.login()` calls `AuthRepository.login()`.
5. `AuthRepository.login()` calls backend `POST /api/auth/login` via
   `ApiClient`.
6. Backend validates credentials, returns `{ ok: true, data: { token, user, scopes } }`.
7. `AuthService` creates a PostgreSQL session via `SessionStore.create()`:
   - Generates a random session ID (`crypto.randomUUID()`)
   - Stores the backend JWT (`token`) in the session
   - Stores user metadata for session introspection
8. `AuthService` returns `{ session_id, user }` (no token).
9. `AuthController` sets the HttpOnly cookie:
   ```typescript
   res.cookie(config.cookie_name, session_id, {
       httpOnly: true,
       secure: config.node_env === 'production',
       sameSite: 'lax',
       maxAge: config.session_ttl_seconds * 1000,
       path: '/',
   });
   ```
10. `AuthController` responds with `{ ok: true, user }`. The JWT never
    reaches the browser.

### Browser Authenticated Request

1. Browser sends `POST /api/teams/list` with cookie `cliqhub_sid=abc123`.
2. `SessionAuthMiddleware.authenticate()` reads the cookie, looks up the
   session in PostgreSQL.
3. If session not found or expired → 401.
4. If idle timeout exceeded → destroy session, 401.
5. Otherwise, attaches `req.session_data`:
   ```typescript
   req.session_data = {
       session_id: session.session_id,
       user_id: session.user_id,
       username: session.username,
       email: session.email,
       role: session.role,
       token: session.token,       // backend JWT — used by repositories
       scopes: JSON.parse(session.scopes_json),
   };
   ```
6. Touches `last_active` timestamp in PostgreSQL (fire-and-forget).
7. Request proceeds to controller → service → repository.
8. Repository calls backend with `Authorization: Bearer <session.token>`.

### Browser Logout

1. Browser `POST /api/auth/logout`.
2. `AuthController.logout()` reads cookie, calls `SessionStore.destroy()`.
3. Clears cookie: `res.clearCookie(config.cookie_name)`.
4. Returns `{ ok: true }`.

### Browser Me (Session Introspection)

1. Browser `POST /api/auth/me`.
2. `AuthController.me()` reads `req.session_data` (attached by session
   middleware) and returns user info directly from the session — no backend
   call needed.
3. If the session middleware did not attach `session_data` (no cookie or
   expired session), the request was already rejected with 401 before
   reaching the controller.

### CLI Login (Direct to Backend — Bypasses BFF)

1. CLI `POST /api/auth/login` with `{ username, password }` directly to the
   Next.js backend.
2. Backend validates credentials, returns
   `{ ok: true, data: { token, user, scopes } }`.
3. CLI stores the token in `~/.cliqrc/settings.json`.

The CLI never touches the BFF. All subsequent CLI requests go directly to
the backend with `Authorization: Bearer <token>`.

### HUG Server Token

1. Authenticated user `POST /api/hug/generate_token`.
2. `HugController` → `HugService` → `HugRepository` calls backend
   `POST /api/hug/token/generate` with the session's backend JWT.
3. Backend generates a scoped HUG token and returns it.
4. BFF returns the token to the caller.

The HUG server uses its own Bearer token for subsequent requests. It does
not go through the BFF session layer.

---

## Route Map

All POST unless noted. All validated with zod schemas.

### Auth — Public (4 routes)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `POST /api/auth/login` | `LoginSchema` | `auth_ctrl.login` |
| `POST /api/auth/signup` | `SignupSchema` (rate-limited) | `auth_ctrl.signup` |
| `POST /api/auth/me` | — | `auth_ctrl.me` |
| `POST /api/auth/logout` | — | `auth_ctrl.logout` |

`/api/auth/me` is registered before the session guard but the controller
reads the cookie manually and returns 401 if no session exists.

### Auth — Authenticated (3 routes)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `POST /api/auth/create_token` | `z.object({ name: z.string().max(100).optional() })` | `auth_ctrl.create_token` |
| `POST /api/auth/revoke_token` | `z.object({ token_id: z.number().int().positive() })` | `auth_ctrl.revoke_token` |
| `POST /api/auth/list_tokens` | — | `auth_ctrl.list_tokens` |

### Teams (12 routes)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `POST /api/teams/list` | `z.object({ domain: z.string().optional(), tag: z.string().optional(), limit: z.number().int().max(100).optional(), offset: z.number().int().optional() })` | `teams_ctrl.list` |
| `POST /api/teams/get` | `z.object({ name: z.string().min(1), scope: z.string().optional() })` | `teams_ctrl.get` |
| `POST /api/teams/search` | `z.object({ query: z.string(), domain: z.string().optional(), limit: z.number().int().max(100).optional() })` | `teams_ctrl.search` |
| `POST /api/teams/download` | `z.object({ name: z.string().min(1), scope: z.string().optional(), version: z.string().optional() })` | `teams_ctrl.download` |
| `POST /api/teams/publish` | `z.object({ name: z.string().min(1), scope: z.string().optional(), version: z.string().optional(), bump: z.enum(['patch','minor','major']).optional(), data_base64: z.string().min(1), ... })` | `teams_ctrl.publish` |
| `POST /api/teams/delete` | `z.object({ name: z.string().min(1), scope: z.string().optional() })` | `teams_ctrl.delete` |
| `POST /api/teams/toggle_listed` | `z.object({ name: z.string().min(1), scope: z.string().optional() })` | `teams_ctrl.toggle_listed` |
| `POST /api/teams/rename` | `z.object({ name: z.string().min(1), scope: z.string().min(1), new_name: z.string().min(1) })` | `teams_ctrl.rename` |
| `POST /api/teams/list_mine` | `z.object({ scope: z.string().optional() })` | `teams_ctrl.list_mine` |
| `POST /api/teams/list_mine_all` | — | `teams_ctrl.list_mine_all` |
| `POST /api/teams/get_latest_version` | `z.object({ name: z.string().min(1), scope: z.string().optional() })` | `teams_ctrl.get_latest_version` |
| `POST /api/teams/batch_latest` | `z.object({ teams: z.array(z.object({ name: z.string(), scope: z.string().optional() })).min(1).max(100) })` | `teams_ctrl.batch_latest` |

### Builder (4 routes, rate-limited)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `POST /api/builder/generate` | `z.object({ intent: z.string().min(1) })` | `builder_ctrl.generate` |
| `POST /api/builder/improve_role` | `z.object({ role_name: z.string().min(1), content_md: z.string().min(1), team_context: z.unknown().optional() })` | `builder_ctrl.improve_role` |
| `POST /api/builder/validate` | `z.object({ team: z.unknown() })` | `builder_ctrl.validate` |
| `POST /api/builder/chat` | `z.object({ message: z.string().min(1), team: z.unknown(), history: z.array(z.unknown()).optional() })` | `builder_ctrl.chat` |

### Drafts (4 routes)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `POST /api/drafts/list` | — | `drafts_ctrl.list` |
| `POST /api/drafts/get` | `z.object({ id: z.number().int().positive() })` | `drafts_ctrl.get` |
| `POST /api/drafts/save` | `z.object({ id: z.number().int().optional(), title: z.string().optional(), team_json: z.string().min(1) })` | `drafts_ctrl.save` |
| `POST /api/drafts/delete` | `z.object({ id: z.number().int().positive() })` | `drafts_ctrl.delete` |

### Orgs (11 routes)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `POST /api/orgs/list` | — | `orgs_ctrl.list` |
| `POST /api/orgs/get` | `z.object({ org_id: z.number().int().positive() })` | `orgs_ctrl.get` |
| `POST /api/orgs/update` | `z.object({ org_id: z.number().int().positive(), display_name: z.string().min(1) })` | `orgs_ctrl.update` |
| `POST /api/orgs/leave` | `z.object({ org_id: z.number().int().positive() })` | `orgs_ctrl.leave` |
| `POST /api/orgs/add_member` | `z.object({ org_id: z.number().int().positive(), username: z.string().min(1) })` | `orgs_ctrl.add_member` |
| `POST /api/orgs/remove_member` | `z.object({ org_id: z.number().int().positive(), user_id: z.number().int().positive() })` | `orgs_ctrl.remove_member` |
| `POST /api/orgs/set_member_role` | `z.object({ org_id: z.number().int().positive(), user_id: z.number().int().positive(), role: z.enum(['admin','member']) })` | `orgs_ctrl.set_member_role` |
| `POST /api/orgs/create_scope` | `z.object({ org_id: z.number().int().positive(), slug: z.string().min(1), display_name: z.string().optional(), visibility: z.enum(['public','private']).optional() })` | `orgs_ctrl.create_scope` |
| `POST /api/orgs/delete_scope` | `z.object({ org_id: z.number().int().positive(), scope_id: z.number().int().positive() })` | `orgs_ctrl.delete_scope` |
| `POST /api/orgs/assign_scope_member` | `z.object({ org_id: z.number().int().positive(), scope_id: z.number().int().positive(), user_id: z.number().int().positive() })` | `orgs_ctrl.assign_scope_member` |
| `POST /api/orgs/unassign_scope_member` | `z.object({ org_id: z.number().int().positive(), scope_id: z.number().int().positive(), user_id: z.number().int().positive() })` | `orgs_ctrl.unassign_scope_member` |

### Account (2 routes)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `POST /api/account/update_profile` | `z.object({ display_name: z.string().optional(), email: z.string().email().optional() })` | `account_ctrl.update_profile` |
| `POST /api/account/change_password` | `z.object({ current_password: z.string().min(1), new_password: z.string().min(8) })` | `account_ctrl.change_password` |

### Admin (22 routes)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `POST /api/admin/stats` | — | `admin_ctrl.stats` |
| `POST /api/admin/audit` | `z.object({ action: z.string().optional(), target_type: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() })` | `admin_ctrl.audit` |
| `POST /api/admin/list_users` | `z.object({ search: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() })` | `admin_ctrl.list_users` |
| `POST /api/admin/get_user` | `z.object({ user_id: z.number().int().positive() })` | `admin_ctrl.get_user` |
| `POST /api/admin/create_user` | `z.object({ username: z.string().min(1), email: z.string().email(), password: z.string().min(8), role: z.enum(['user','admin']).optional() })` | `admin_ctrl.create_user` |
| `POST /api/admin/update_user` | `z.object({ user_id: z.number().int().positive(), display_name: z.string().optional(), email: z.string().email().optional() })` | `admin_ctrl.update_user` |
| `POST /api/admin/suspend_user` | `z.object({ user_id: z.number().int().positive(), reason: z.string().optional() })` | `admin_ctrl.suspend_user` |
| `POST /api/admin/unsuspend_user` | `z.object({ user_id: z.number().int().positive() })` | `admin_ctrl.unsuspend_user` |
| `POST /api/admin/delete_user` | `z.object({ user_id: z.number().int().positive() })` | `admin_ctrl.delete_user` |
| `POST /api/admin/set_user_role` | `z.object({ user_id: z.number().int().positive(), role: z.enum(['user','admin']) })` | `admin_ctrl.set_user_role` |
| `POST /api/admin/reset_user_password` | `z.object({ user_id: z.number().int().positive(), new_password: z.string().min(8) })` | `admin_ctrl.reset_user_password` |
| `POST /api/admin/list_teams` | `z.object({ search: z.string().optional(), scope: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() })` | `admin_ctrl.list_teams` |
| `POST /api/admin/set_team_listed` | `z.object({ team_id: z.number().int().positive(), listed: z.boolean() })` | `admin_ctrl.set_team_listed` |
| `POST /api/admin/list_scopes` | `z.object({ search: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() })` | `admin_ctrl.list_scopes` |
| `POST /api/admin/create_scope` | `z.object({ slug: z.string().min(1), display_name: z.string().optional(), owner_id: z.number().int().positive(), visibility: z.enum(['public','private']).optional() })` | `admin_ctrl.create_scope` |
| `POST /api/admin/update_scope` | `z.object({ scope_id: z.number().int().positive(), display_name: z.string().optional(), visibility: z.enum(['public','private']).optional() })` | `admin_ctrl.update_scope` |
| `POST /api/admin/delete_scope` | `z.object({ scope_id: z.number().int().positive() })` | `admin_ctrl.delete_scope` |
| `POST /api/admin/list_orgs` | `z.object({ search: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() })` | `admin_ctrl.list_orgs` |
| `POST /api/admin/create_org` | `z.object({ slug: z.string().min(1), display_name: z.string().optional(), admin_username: z.string().min(1), admin_email: z.string().email().optional() })` | `admin_ctrl.create_org` |
| `POST /api/admin/delete_org` | `z.object({ org_id: z.number().int().positive() })` | `admin_ctrl.delete_org` |
| `POST /api/admin/list_tokens` | `z.object({ user_id: z.number().int().positive().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() })` | `admin_ctrl.list_tokens` |
| `POST /api/admin/revoke_token` | `z.object({ token_id: z.number().int().positive() })` | `admin_ctrl.revoke_token` |

### HUG (2 routes)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `POST /api/hug/get_token_status` | — | `hug_ctrl.get_token_status` |
| `POST /api/hug/generate_token` | — | `hug_ctrl.generate_token` |

### Health (1 route)

| Path | Schema | Controller Method |
|------|--------|-------------------|
| `GET /health` | — | Inline in `app.ts` |

**Total: 64 routes** (down from 70 — 6 removed).

---

## Removed Routes (6)

These routes have no callers in the frontend, CLI, or any other client.
The handler code stays in the Next.js backend (dormant) but no BFF route
is created.

| Old Path | Handler | Reason |
|----------|---------|--------|
| `/api/teams/get_version` | `teams.get_version` | No caller found |
| `/api/teams/versions` | `teams.get_versions` | No caller found |
| `/api/teams/delete-version` | `teams.delete_version` | No caller found |
| `/api/builder/suggest` | `builder.suggest` | No caller found |
| `/api/admin/teams/delete` | `admin.admin_delete_team` | No UI (use `/api/teams/delete` with admin check) |
| `/api/admin/teams/transfer` | `admin.admin_transfer_team` | No UI wired |

Note: Admin user action routes (`suspend`, `unsuspend`, `delete`,
`set-role`, `reset-password`) ARE used by `app/admin/users/page.tsx` via
`do_action()` and are included in the Admin domain (Slices 15–16).

---

## Renamed Routes

Routes where the path changes from the old format to flat `snake_case`:

| Old Path | New Path |
|----------|----------|
| `/api/teams/mine` | `/api/teams/list_mine` |
| `/api/teams/mine-all` | `/api/teams/list_mine_all` |
| `/api/teams/latest-version` | `/api/teams/get_latest_version` |
| `/api/teams/batch-latest` | `/api/teams/batch_latest` |
| `/api/teams/toggle-listed` | `/api/teams/toggle_listed` |
| `/api/teams/delete-version` | (removed) |
| `/api/builder/improve-role` | `/api/builder/improve_role` |
| `/api/account/update-profile` | `/api/account/update_profile` |
| `/api/account/change-password` | `/api/account/change_password` |
| `/api/orgs/members/add` | `/api/orgs/add_member` |
| `/api/orgs/members/remove` | `/api/orgs/remove_member` |
| `/api/orgs/members/set-role` | `/api/orgs/set_member_role` |
| `/api/orgs/scopes/create` | `/api/orgs/create_scope` |
| `/api/orgs/scopes/delete` | `/api/orgs/delete_scope` |
| `/api/orgs/scopes/assign` | `/api/orgs/assign_scope_member` |
| `/api/orgs/scopes/unassign` | `/api/orgs/unassign_scope_member` |
| `/api/admin/users` (list) | `/api/admin/list_users` |
| `/api/admin/users/get` | `/api/admin/get_user` |
| `/api/admin/users/create` | `/api/admin/create_user` |
| `/api/admin/users/update` | `/api/admin/update_user` |
| `/api/admin/users/suspend` | `/api/admin/suspend_user` |
| `/api/admin/users/unsuspend` | `/api/admin/unsuspend_user` |
| `/api/admin/users/delete` | `/api/admin/delete_user` |
| `/api/admin/users/set-role` | `/api/admin/set_user_role` |
| `/api/admin/users/reset-password` | `/api/admin/reset_user_password` |
| `/api/admin/teams` (list) | `/api/admin/list_teams` |
| `/api/admin/teams/set-listed` | `/api/admin/set_team_listed` |
| `/api/admin/scopes` (list) | `/api/admin/list_scopes` |
| `/api/admin/scopes/create` | `/api/admin/create_scope` |
| `/api/admin/scopes/update` | `/api/admin/update_scope` |
| `/api/admin/scopes/delete` | `/api/admin/delete_scope` |
| `/api/admin/orgs` (list) | `/api/admin/list_orgs` |
| `/api/admin/orgs/create` | `/api/admin/create_org` |
| `/api/admin/orgs/delete` | `/api/admin/delete_org` |
| `/api/admin/tokens` (list) | `/api/admin/list_tokens` |
| `/api/admin/tokens/revoke` | `/api/admin/revoke_token` |
| `/api/admin/users/suspend` | `/api/admin/suspend_user` |
| `/api/admin/users/unsuspend` | `/api/admin/unsuspend_user` |
| `/api/admin/users/delete` | `/api/admin/delete_user` |
| `/api/admin/users/set-role` | `/api/admin/set_user_role` |
| `/api/admin/users/reset-password` | `/api/admin/reset_user_password` |
| `/api/admin/stats` | `/api/admin/stats` (unchanged) |
| `/api/admin/audit` | `/api/admin/audit` (unchanged) |
| `/api/hug/token` (GET) | `/api/hug/get_token_status` (POST) |
| `/api/hug/token/generate` | `/api/hug/generate_token` |
| `/api/auth/me` (GET) | `/api/auth/me` (POST) |
| `/api/auth/list_tokens` (GET) | `/api/auth/list_tokens` (POST) |

---

## Backend Path Mapping

The BFF routes use new flat paths but the backend still has the old paths.
Repositories handle the translation. Example:

| BFF Route (new) | Backend API Path (unchanged) |
|------------------|------------------------------|
| `/api/teams/list_mine` | `/api/teams/mine` |
| `/api/teams/toggle_listed` | `/api/teams/toggle-listed` |
| `/api/orgs/add_member` | `/api/orgs/members/add` |
| `/api/admin/list_users` | `/api/admin/users` |

The repository layer is the only place that knows about the backend path
scheme. If the backend is eventually consolidated, only the repository
implementations change.

---

## Config (`config/env.ts`)

```typescript
export interface EnvConfig {
    port: number;
    backend_url: string;             // http://localhost:3000
    session_secret: string;
    session_ttl_seconds: number;     // 2592000 (30 days)
    session_idle_seconds: number;    // 7200 (2 hours)
    database_url: string;            // postgres://...
    cookie_name: string;             // cliqhub_sid
    cors_origins: string;            // comma-separated
    node_env: string;
    rate_limit_builder_anon: number; // 5
    rate_limit_builder_auth: number; // 30
    rate_limit_window_ms: number;    // 60000
}
```

---

## Middleware

### `session_auth.ts`

Runs on all `/api/*` routes after the public auth routes are registered.

Single authentication mode:

1. Reads the `cliqhub_sid` cookie, looks up the session in PostgreSQL, attaches
   `req.session_data` with the stored backend JWT and user metadata.

If the cookie is missing or the session is not found / expired, returns 401.

The BFF does not accept Bearer tokens. The CLI and HUG server talk directly
to the backend and never hit the BFF.

### `error_handler.ts`

Global Express error handler (4-arg). Maps error types to HTTP responses:

| Error Type | Status | Code |
|------------|--------|------|
| `ZodError` (validation) | 400 | `VALIDATION_ERROR` |
| `ApiError` with code `unauthorized` | 401 | `UNAUTHORIZED` |
| `ApiError` with code `forbidden` | 403 | `FORBIDDEN` |
| `ApiError` with code `not_found` | 404 | `NOT_FOUND` |
| `ApiError` with code `conflict` | 409 | `CONFLICT` |
| `ApiError` with code `rate_limited` | 429 | `RATE_LIMITED` |
| All other `Error` | 500 | `INTERNAL_ERROR` |

### `csrf_guard.ts`

Checks the `Origin` header on POST requests from browsers. If the origin is
not in the allowed list, returns 403. Since the CLI bypasses the BFF
entirely, no special CSRF exemption logic is needed in the BFF.

### `rate_limit.ts`

In-memory rate limiter for builder endpoints. Uses a sliding window counter
per user ID (authenticated) or IP (anonymous).

---

## `api_client.ts` — Backend HTTP Client

Shared by all repositories. Handles the HTTP transport to the Next.js
backend.

```typescript
export class ApiClient {

    private _base_url: string;

    constructor(base_url: string) {
        this._base_url = base_url;
    }

    async post<T>(
        path: string,
        body: unknown,
        token?: string,
    ): Promise<T> {

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const url = `${this._base_url}/api${path}`;

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        const data = await res.json() as {
            ok: boolean;
            data?: T;
            error?: { code: string; message: string };
        };

        if (!data.ok) {
            throw new ApiError(
                data.error?.code ?? 'unknown',
                data.error?.message ?? 'Backend request failed',
                res.status,
            );
        }

        return data.data as T;
    }

    async post_raw(
        path: string,
        body: unknown,
        token?: string,
    ): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const url = `${this._base_url}/api${path}`;

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        return res.json();
    }
}


export class ApiError extends Error {
    code: string;
    status: number;

    constructor(code: string, message: string, status: number) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.status = status;
    }
}
```

`post<T>()` unwraps the `{ ok, data }` envelope and throws on error.
`post_raw()` returns the raw response for cases where the controller needs
the full envelope (e.g., forwarding errors as-is).

---

## SSR Pages

Four Next.js pages currently bypass the API with direct DB queries:

| Page | Current | After |
|------|---------|-------|
| `/teams` (browse) | `query()` on DB | `fetch('http://bff/api/teams/list')` server-side |
| `/teams/[scope]/[name]` | `get_team()` → DB | `fetch('http://bff/api/teams/get')` server-side |
| `/admin/teams/[scope]/[name]` | `get_team()` → DB | `fetch('http://bff/api/teams/get')` server-side |
| `/account/teams/[scope]/[name]` | `get_team()` → DB | `fetch('http://bff/api/teams/get')` server-side |

After the refactor, these pages call the BFF like any other client. The
`lib/get-team.ts` and direct `lib/db` imports are removed from Next.js.

For SSR requests from Next.js to the BFF, the session cookie is not
available (server-side rendering is not a browser). Two options:

1. **Public data** — the `/teams` browse page and team detail pages show
   public data. The BFF's backend calls for public team data don't require
   auth. The SSR fetch can call the BFF without a session.
2. **Authenticated SSR** — for `/account/teams/[scope]/[name]` and admin
   pages, Next.js can forward the browser's cookie by reading it from the
   incoming request headers and passing it along in the SSR fetch.

---

## Frontend Changes

### Updated Fetch URLs

All components and pages that call the API need their paths updated. The
`auth-context.tsx` module (`useAuthFetch`) already uses `credentials:
'same-origin'` and passes the cookie automatically.

Files that need URL updates:

| File | Old Path | New Path |
|------|----------|----------|
| `components/builder/phase-editor.tsx` | `/api/builder/improve-role` | `/api/builder/improve_role` |
| `components/builder/role-editor.tsx` | `/api/builder/improve-role` | `/api/builder/improve_role` |
| `app/account/teams/page.tsx` | `/api/teams/mine-all` | `/api/teams/list_mine_all` |
| `app/account/teams/page.tsx` | `/api/teams/toggle-listed` | `/api/teams/toggle_listed` |
| `app/account/settings/page.tsx` | `/api/account/update-profile` | `/api/account/update_profile` |
| `app/account/settings/page.tsx` | `/api/account/change-password` | `/api/account/change_password` |
| `app/account/settings/page.tsx` | `/api/hug/token` | `/api/hug/get_token_status` |
| `app/account/settings/page.tsx` | `/api/hug/token/generate` | `/api/hug/generate_token` |
| `app/teams/s/[slug]/page.tsx` | `/api/teams/mine` | `/api/teams/list_mine` |
| `app/admin/users/page.tsx` | `/api/admin/users` | `/api/admin/list_users` |
| `app/admin/users/page.tsx` | `/api/admin/users/get` | `/api/admin/get_user` |
| `app/admin/users/page.tsx` | `/api/admin/users/create` | `/api/admin/create_user` |
| `app/admin/users/page.tsx` | `/api/admin/users/update` | `/api/admin/update_user` |
| `app/admin/users/page.tsx` | `/api/admin/users/${action}` (via `do_action`) | `/api/admin/suspend_user`, `/api/admin/unsuspend_user`, `/api/admin/delete_user`, `/api/admin/set_user_role`, `/api/admin/reset_user_password` |
| `app/admin/tokens/page.tsx` | `/api/admin/tokens` | `/api/admin/list_tokens` |
| `app/admin/tokens/page.tsx` | `/api/admin/tokens/revoke` | `/api/admin/revoke_token` |
| `app/admin/teams/page.tsx` | `/api/admin/teams` | `/api/admin/list_teams` |
| `app/admin/teams/page.tsx` | `/api/admin/teams/set-listed` | `/api/admin/set_team_listed` |
| `app/admin/scopes/page.tsx` | `/api/admin/scopes` | `/api/admin/list_scopes` |
| `app/admin/scopes/page.tsx` | `/api/admin/scopes/create` | `/api/admin/create_scope` |
| `app/admin/scopes/page.tsx` | `/api/admin/scopes/update` | `/api/admin/update_scope` |
| `app/admin/scopes/page.tsx` | `/api/admin/scopes/delete` | `/api/admin/delete_scope` |
| `app/admin/orgs/page.tsx` | `/api/admin/orgs` | `/api/admin/list_orgs` |
| `app/admin/orgs/page.tsx` | `/api/admin/orgs/create` | `/api/admin/create_org` |
| `app/admin/orgs/[id]/page.tsx` | `/api/admin/orgs/delete` | `/api/admin/delete_org` |
| `app/admin/orgs/[id]/page.tsx` | `/api/orgs/members/add` | `/api/orgs/add_member` |
| `app/admin/orgs/[id]/page.tsx` | `/api/orgs/members/remove` | `/api/orgs/remove_member` |
| `app/admin/orgs/[id]/page.tsx` | `/api/orgs/members/set-role` | `/api/orgs/set_member_role` |
| `app/admin/orgs/[id]/page.tsx` | `/api/orgs/scopes/create` | `/api/orgs/create_scope` |
| `app/admin/orgs/[id]/page.tsx` | `/api/orgs/scopes/delete` | `/api/orgs/delete_scope` |
| `app/admin/orgs/[id]/page.tsx` | `/api/orgs/scopes/assign` | `/api/orgs/assign_scope_member` |
| `app/admin/orgs/[id]/page.tsx` | `/api/orgs/scopes/unassign` | `/api/orgs/unassign_scope_member` |
| `app/account/orgs/[id]/page.tsx` | `/api/orgs/members/add` | `/api/orgs/add_member` |
| `app/account/orgs/[id]/page.tsx` | `/api/orgs/members/remove` | `/api/orgs/remove_member` |
| `app/account/orgs/[id]/page.tsx` | `/api/orgs/members/set-role` | `/api/orgs/set_member_role` |
| `app/account/orgs/[id]/page.tsx` | `/api/orgs/scopes/create` | `/api/orgs/create_scope` |
| `app/account/orgs/[id]/page.tsx` | `/api/orgs/scopes/delete` | `/api/orgs/delete_scope` |
| `app/account/orgs/[id]/page.tsx` | `/api/orgs/scopes/assign` | `/api/orgs/assign_scope_member` |
| `app/account/orgs/[id]/page.tsx` | `/api/orgs/scopes/unassign` | `/api/orgs/unassign_scope_member` |
| `components/builder/publish-dialog.tsx` | `/api/teams/latest-version` | `/api/teams/get_latest_version` |
| `components/rename-team-button.tsx` | `/api/teams/rename` | `/api/teams/rename` (unchanged) |
| `components/danger-zone.tsx` | `/api/teams/delete` | `/api/teams/delete` (unchanged) |

### `auth-context.tsx` Changes

- `api_get('/api/auth/me')` changes to `api_post('/api/auth/me', {})`
- `api_post('/api/auth/logout', {})` — unchanged
- The `GET` call to `/api/auth/list_tokens` changes to POST

---

## CLI Changes

### `hub_command.ts`

The CLI talks **directly to the Next.js backend** — it does not go through
the BFF. The `DEFAULT_REGISTRY` stays `https://cliqhub.io`. In production,
nginx routes CLI requests (identified by path or `X-Client: cli` header)
directly to the Next.js backend.

The only code change required in the CLI is a path rename:

| CLI Method | Current Path | New Path |
|------------|--------------|----------|
| `search` | `/teams/search` | same |
| `info` | `/teams/get` | same |
| `install` | `/teams/download` | same |
| `browse` | `/teams/list` | same |
| `publish` | `/teams/publish` | same |
| `update` | `/teams/batch-latest` | `/teams/batch_latest` |
| `login` | `/auth/login` | same |
| `create_token` | `/auth/create_token` | same |

Only `batch-latest` → `batch_latest` changes. The CLI's `_post` method
prepends `/api` to the path, so the CLI code changes from
`'/teams/batch-latest'` to `'/teams/batch_latest'`.

No `X-Client: cli` header is needed for login since the CLI is not going
through the BFF. The backend already returns the JWT in the response body.

---

## Testing, Validation & Implementation

The full testing strategy, frontend validation plan, existing backend test
gaps, and slice-by-slice implementation order are in the companion document:

**→ [`bff-implementation-plan.md`](./bff-implementation-plan.md)**

### Summary

- **22 slices** (Slice 1–22), each self-contained and independently mergeable
- **3 test tiers:** Unit (Vitest, mocked), Integration (supertest), E2E (Playwright)
- **RBAC test matrix** for every endpoint: unauthed, wrong role, correct role, owner/non-owner, admin bypass
- **Frontend validation** fixed per slice — shared `lib/validation.ts`, `ApiError` component, `useAuthFetch` improvements
- **Backend test gaps fixed within each domain slice** — not as a separate upfront phase (~75 new tests spread across slices)
- Each slice delivers browser-testable functionality

| Slice | Scope | Routes | Est. Duration |
|-------|-------|--------|---------------|
| 1 | Scaffold BFF + utilities | 1 | 2–3 days |
| 2 | Auth: login/signup/logout/me | 4 | 2–3 days |
| 3 | Auth: token management | 3 | 1 day |
| 4 | Teams: browse/search/view/download | 4 | 2 days |
| 5 | Teams: publish/rename/delete/toggle | 4 | 2 days |
| 6 | Teams: my teams/versions/batch | 4 | 1 day |
| 7 | Drafts | 4 | 1–2 days |
| 8 | Builder (AI) | 4 | 1 day |
| 9 | Orgs: core | 4 | 1–2 days |
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
| 22 | E2E + cleanup (29 Playwright tests) | 0 | 3–4 days |

**Total: ~6–8 weeks** (single developer). After slice 3, slices 4–13
parallelizable across two developers.


---

## Deployment

### Production (Railway)

| Service | Port | Purpose |
|---------|------|---------|
| nginx | 8080 | TLS termination, static assets, routing |
| BFF | 3001 | API gateway — browser `/api/*` traffic |
| Next.js | 3000 | UI rendering + backend APIs |
| PostgreSQL | 5432 | Application data |

nginx routes:
- `/api/*` with `X-Client: cli` header → Next.js:3000 (CLI direct)
- `/api/*` (all other) → BFF:3001 (browser clients)
- Everything else → Next.js:3000 (UI rendering)

### Development

```bash
npm run dev
```

Starts concurrently:
- BFF on :3001 (`BACKEND_URL=http://localhost:3000`)
- Next.js on :3000
- PostgreSQL via Docker

---

## Implementation Order — Slice-Based

The full slice-by-slice implementation plan — including every route, schema,
frontend change, backend test gap, and BFF test for each slice — is in the
companion document:

**→ [`bff-implementation-plan.md`](./bff-implementation-plan.md)**

The plan is structured so that backend test gaps are fixed within each
domain slice (not as a separate upfront phase), and each slice delivers
browser-testable functionality.

---

## Dependencies

### BFF `package.json`

```json
{
  "name": "@getcliqio/bff",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "express": "^5.1.0",
    "cors": "^2.8.5",
    "helmet": "^8.1.0",
    "cookie-parser": "^1.4.7",
    "pg": "^8.16.0",
    "zod": "^3.24.4",
    "uuid": "^11.1.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.2",
    "@types/cors": "^2.8.17",
    "@types/cookie-parser": "^1.4.8",
    "@types/pg": "^8.11.0",
    "@types/uuid": "^10.0.0",
    "typescript": "^5.8.3",
    "vitest": "^3.1.3",
    "supertest": "^7.1.0",
    "@types/supertest": "^6.0.2",
    "@playwright/test": "^1.52.0"
  }
}
```

---

## What Doesn't Change

| Component | Reason |
|-----------|--------|
| Next.js backend API routes | Stay as-is — the BFF calls them |
| `lib/handlers/*.ts` | Business logic stays on the backend |
| `lib/db.ts`, `lib/storage.ts` | Backend data layer, untouched |
| `lib/auth.ts` (JWT validation) | Backend still validates JWTs |
| `lib/builder/store.tsx` | Client-side React state, stays in frontend |
| `components/*` (except fetch URLs) | UI components, untouched |
| PostgreSQL schema | No migrations needed |
| R2 storage | Accessed by backend, not BFF |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Double HTTP hop adds latency | BFF and Next.js are co-located on Railway. Intra-service latency is <1ms. |
| Session table in shared Postgres | Isolated in `bff` schema — no collision with application tables. Schema auto-created on startup. |
| Backend API paths are frozen because the BFF depends on them | Only the repository layer knows about backend paths. Changing a backend path requires updating one repository method. |
| Frontend SSR pages need auth context for private data | Forward the browser's session cookie in SSR fetch headers. |
| Stale sessions after crash | `prune_expired()` runs on startup and every 5 minutes. Session TTL ensures eventual cleanup. |
