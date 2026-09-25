# BFF Session Management

## Overview

This document describes the migration from stateless client-side JWT
authentication to server-side session management in the CliqHub BFF. The BFF
becomes the session boundary: it stores JWTs server-side, issues opaque
HttpOnly session cookies to browsers, and injects the JWT into proxied
requests transparently. The Next.js application and CLI auth flows are
unaffected.

---

## Problem

The current model stores JWTs in browser `localStorage`:

- **XSS vulnerability** — any injected script can read `localStorage` and
  exfiltrate the JWT.
- **No server-side revocation** — logout removes the token from the browser
  but the JWT remains valid for up to 30 days. A stolen token cannot be
  invalidated.
- **No idle timeout** — a session stays alive for the full 30-day JWT expiry
  regardless of user activity.
- **No session visibility** — admins cannot see or force-terminate active
  sessions.

---

## Solution

Move session state into the BFF backed by PostgreSQL. The JWT never reaches
the browser. Browsers receive only an opaque, HttpOnly, Secure session cookie.

### Request Flow

```
Browser ──cookie──▶ nginx ──▶ BFF ──Bearer JWT──▶ Next.js app
                                │
                          bff.session
                          (PostgreSQL)
```

### CLI / API Token Flow (Unchanged)

```
CLI ──Bearer token──▶ nginx ──▶ BFF ──pass-through──▶ Next.js app
```

Requests that already carry an `Authorization` header bypass session
management entirely. The BFF only injects a JWT from the session when no
`Authorization` header is present.

### CLI Login Flow

```
CLI ──credentials + X-Client: cli──▶ nginx ──▶ BFF ──pass-through──▶ Next.js app
```

The CLI sends `X-Client: cli` on login requests. The BFF detects this
header and passes the full upstream response through without creating a
session or stripping any fields. The CLI needs the raw JWT, `hug_token`,
and `hug_server_url` from the login response (see
`design/hug-token-management.md`).

---

## Database Schema Isolation

BFF tables live in a dedicated `bff` schema, separate from the CliqHub
application tables in the default `public` schema. This keeps ownership
boundaries clear — the BFF owns its tables, the app owns its tables.

```sql
CREATE SCHEMA IF NOT EXISTS bff;
```

The session table is auto-created by `connect-pg-simple` in the `bff` schema:

```sql
bff.session (
    sid     VARCHAR NOT NULL PRIMARY KEY,
    sess    JSON NOT NULL,
    expire  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_session_expire ON bff.session (expire);
```

If other services (e.g. HUG server) share the same PostgreSQL instance in the
future, they should follow the same pattern with their own schema (e.g.
`hug`).

---

## Session Policies

All configurable via environment variables on the BFF service.

| Var | Default | Description |
|-----|---------|-------------|
| `SESSION_SECRET` | (required) | Secret for signing the session cookie. Must be a strong random string. |
| `SESSION_MAX_AGE` | `2592000000` (30 days) | Absolute session lifetime in milliseconds. The session is destroyed after this time regardless of activity. |
| `SESSION_IDLE_TIMEOUT` | `7200000` (2 hours) | Destroy the session after this many milliseconds of inactivity. |
| `SESSION_ROLLING` | `true` | When `true`, the idle timer resets on every request. When `false`, the cookie expiry is fixed from creation. |
| `SESSION_COOKIE_NAME` | `cliqhub_sid` | Name of the session cookie. |

### Policy Behavior

- **Absolute expiry** (`SESSION_MAX_AGE`) — hard upper bound. Even with
  continuous activity, the session expires after this duration. The user must
  re-authenticate.
- **Idle timeout** (`SESSION_IDLE_TIMEOUT`) — if the user is inactive for
  this duration, the session is destroyed on the next request. Prevents
  abandoned sessions from staying alive.
- **Rolling** (`SESSION_ROLLING`) — when enabled, the cookie's `Max-Age` is
  reset on every request, effectively extending the session as long as the
  user is active (up to the absolute expiry).

### Cookie Security

| Attribute | Value | Rationale |
|-----------|-------|-----------|
| `httpOnly` | `true` | JavaScript cannot read the cookie — prevents XSS exfiltration. |
| `secure` | `true` in production | Cookie only sent over HTTPS. |
| `sameSite` | `lax` | Prevents CSRF on cross-origin POST while allowing normal navigation. |
| `path` | `/` | Cookie sent on all paths. |

---

## Session Lifecycle

### Login

1. Browser POSTs `{ username, password }` to `/api/auth/login`.
2. BFF session router intercepts the request.
3. **CLI check**: if the request has `X-Client: cli` header, the BFF
   forwards to upstream and returns the full response unmodified (JWT,
   `hug_token`, `hug_server_url` — all included). No session created.
4. Otherwise (browser), BFF forwards to the Next.js upstream.
5. Next.js validates credentials, returns
   `{ ok: true, data: { token, user, hug_token?, hug_server_url? } }`.
6. BFF stores the JWT in the session: `req.session.jwt = token`.
7. BFF stores a `created_at` timestamp for absolute expiry enforcement.
8. BFF strips `token`, `hug_token`, and `hug_server_url` from the
   response body. Browsers don't need any of these — the JWT lives in
   the session, and HUG status is available via `GET /api/hug/token`.
9. BFF returns `{ ok: true, data: { user } }` — no secrets exposed.
10. `express-session` sets the `cliqhub_sid` HttpOnly cookie automatically.

### Signup

Same flow as login. The signup response includes a JWT which is stored in
the session and stripped from the response. The `X-Client: cli` bypass
applies here too — CLI signup (if supported) receives the full response.

### Authenticated Request

1. Browser sends request. The session cookie is included automatically.
2. `express-session` middleware loads the session from PostgreSQL.
3. BFF checks idle timeout: if `now - last_active > SESSION_IDLE_TIMEOUT`,
   destroy the session and return 401.
4. BFF checks absolute expiry: if `now - created_at > SESSION_MAX_AGE`,
   destroy the session and return 401.
5. BFF updates `last_active` timestamp in the session.
6. BFF's proxy `onProxyReq` hook reads `req.session.jwt` and sets
   `Authorization: Bearer <jwt>` on the proxied request.
7. Next.js validates the JWT as usual — no changes needed.

### Logout

1. Browser POSTs to `/api/auth/logout`.
2. BFF destroys the session in PostgreSQL.
3. Session cookie is cleared.
4. Response: `{ ok: true }`.
5. Revocation is instant — the JWT is gone from the session store.

### CLI / API Token Request

1. Request arrives with `Authorization: Bearer <token>` header.
2. BFF proxy's `onProxyReq` hook sees an existing `Authorization` header
   and does not inject a session JWT.
3. Request passes through to Next.js unchanged.
4. No session is created or consulted.

---

## NPM Packages

| Package | Purpose |
|---------|---------|
| `express-session` | Standard Express session middleware. Manages session lifecycle, cookie handling, store integration. |
| `connect-pg-simple` | PostgreSQL session store for `express-session`. Auto-creates the session table. Handles reads, writes, and periodic pruning of expired sessions. |

Both are mature, well-maintained, and widely used in production Express
applications.

---

## Future Extensions (Not Implementing Now)

- **Active sessions UI** — query `bff.session` to show the user their active
  sessions (device, last active, location). Add "Revoke" buttons.
- **Admin force-logout** — admin deletes a user's sessions from the table,
  forcing immediate re-authentication.
- **Session limits** — cap concurrent sessions per user (e.g. max 5). On
  login, if the limit is exceeded, destroy the oldest session.
- **Session events** — emit audit log entries on login, logout, session
  expiry, and forced revocation.

---

## Detailed Implementation

### 1. Add dependencies: `services/bff/package.json`

Add to `dependencies`:

```json
"express-session": "^1.18.0",
"connect-pg-simple": "^10.0.0"
```

Add to `devDependencies`:

```json
"@types/express-session": "^1.18.0"
```

### 2. New file: `services/bff/src/session.ts`

Session middleware factory. Reads policy configuration from environment
variables.

```typescript
import session from 'express-session';
import connect_pg from 'connect-pg-simple';
import { get_logger } from './logging.js';
```

Exports: `create_session_middleware()`.

Implementation:

- Creates the `connect-pg-simple` store:
  ```typescript
  const PgStore = connect_pg(session);
  const store = new PgStore({
      conString: process.env.DATABASE_URL,
      schemaName: 'bff',
      tableName: 'session',
      createTableIfMissing: true,
  });
  ```

- Reads environment variables with defaults:
  ```typescript
  const secret = process.env.SESSION_SECRET;
  const max_age = parseInt(process.env.SESSION_MAX_AGE || '2592000000', 10);
  const cookie_name = process.env.SESSION_COOKIE_NAME || 'cliqhub_sid';
  const rolling = process.env.SESSION_ROLLING !== 'false';
  const is_production = process.env.NODE_ENV === 'production';
  ```

- Validates that `SESSION_SECRET` is set. Logs fatal and exits if missing.

- Returns configured `session()` middleware:
  ```typescript
  return session({
      store,
      name: cookie_name,
      secret,
      resave: false,
      saveUninitialized: false,
      rolling,
      cookie: {
          maxAge: max_age,
          httpOnly: true,
          secure: is_production,
          sameSite: 'lax',
          path: '/',
      },
  });
  ```

### 3. New file: `services/bff/src/session_routes.ts`

Express router that intercepts auth endpoints before the proxy. Manages the
session ↔ JWT mapping.

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { get_logger } from './logging.js';
```

Exports: `create_session_routes(upstream: string)`.

The router handles four routes:

#### `POST /api/auth/login`

1. Check for `X-Client: cli` header. If present, proxy the request to
   upstream unchanged and return the full response (no session, no
   stripping). This lets the CLI receive the JWT, `hug_token`, and
   `hug_server_url` it needs.
2. Otherwise, forward the request body to
   `http://${upstream}/api/auth/login` using `fetch()`.
3. Parse the upstream JSON response.
4. If `response.ok` and `response.data.token` exists:
   - Store in session: `req.session.jwt = response.data.token`.
   - Store in session: `req.session.created_at = Date.now()`.
   - Store in session: `req.session.last_active = Date.now()`.
   - Delete `response.data.token` from the response body.
   - Delete `response.data.hug_token` from the response body (if present).
   - Delete `response.data.hug_server_url` from the response body (if
     present).
5. Return the modified response to the browser.

#### `POST /api/auth/signup`

Same logic as login including the `X-Client: cli` bypass. The signup
response also contains a `token` field that gets stored in the session
and stripped from the response.

#### `POST /api/auth/logout`

1. Call `req.session.destroy()`.
2. Clear the cookie: `res.clearCookie(cookie_name)`.
3. Return `{ ok: true }`.

Does not proxy to upstream — logout is handled entirely by the BFF.

#### `GET /api/auth/me`

1. Check if `req.session.jwt` exists. If not, return 401.
2. Forward to `http://${upstream}/api/auth/me` with
   `Authorization: Bearer ${req.session.jwt}`.
3. If upstream returns 401 (JWT expired), destroy the session and return 401.
4. Otherwise, return the upstream response.

### 4. New file: `services/bff/src/session_guard.ts`

Middleware that enforces idle timeout and absolute expiry on every request
that has an active session.

```typescript
import type { Request, Response, NextFunction } from 'express';
import { get_logger } from './logging.js';
```

Exports: `create_session_guard()`.

Implementation:

```typescript
export function create_session_guard() {
    const idle_timeout = parseInt(
        process.env.SESSION_IDLE_TIMEOUT || '7200000', 10,
    );
    const max_age = parseInt(
        process.env.SESSION_MAX_AGE || '2592000000', 10,
    );

    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.session?.jwt) {
            next();
            return;
        }

        const now = Date.now();

        if (req.session.created_at && now - req.session.created_at > max_age) {
            req.session.destroy(() => {});
            res.status(401).json({
                ok: false,
                error: { code: 'session_expired', message: 'Session expired. Please log in again.' },
            });
            return;
        }

        if (req.session.last_active && now - req.session.last_active > idle_timeout) {
            req.session.destroy(() => {});
            res.status(401).json({
                ok: false,
                error: { code: 'idle_timeout', message: 'Session timed out due to inactivity.' },
            });
            return;
        }

        req.session.last_active = now;
        next();
    };
}
```

### 5. Modify: `services/bff/src/proxy.ts`

Update the proxy middleware to inject the JWT from the session into proxied
requests.

Current `create_proxy` function creates a `createProxyMiddleware` with an
`on.error` handler.

Add an `on.proxyReq` handler:

```typescript
on: {
    proxyReq(proxy_req, req) {
        if (req.session?.jwt && !req.headers.authorization) {
            proxy_req.setHeader('Authorization', `Bearer ${req.session.jwt}`);
        }
    },
    error(err, req, res) {
        // ... existing error handler unchanged ...
    },
},
```

Key: the `!req.headers.authorization` guard ensures CLI/API token requests
pass through unchanged. The BFF only injects a session JWT when no
`Authorization` header is already present.

TypeScript note: `req` in the `proxyReq` callback is typed as
`http.IncomingMessage`. To access `req.session`, extend the type or cast:
`(req as express.Request).session?.jwt`.

### 6. Modify: `services/bff/src/index.ts`

Add session middleware, session guard, and session routes to the middleware
stack. The order matters:

```typescript
import express from 'express';
import { request_logger, get_logger } from './logging.js';
import { health_router } from './health.js';
import { beta_router } from './beta_page.js';
import { beta_gate } from './beta_gate.js';
import { create_session_middleware } from './session.js';
import { create_session_routes } from './session_routes.js';
import { create_session_guard } from './session_guard.js';
import { create_proxy } from './proxy.js';

const logger = get_logger('server');

const port = parseInt(process.env.PORT || '3001', 10);
const upstream = process.env.UPSTREAM;

if (!upstream) {
    logger.fatal('UPSTREAM environment variable is required');
    process.exit(1);
}

const app = express();

app.use(request_logger());
app.use(health_router);
app.use(beta_router);
app.use(beta_gate());
app.use(create_session_middleware());
app.use(create_session_guard());
app.use(create_session_routes(upstream));
app.use(create_proxy(upstream));

app.listen(port, '::', () => {
    logger.info(`bff listening on [::]:${port}, upstream=${upstream}`);
    if (process.env.BETA_ENABLED === 'true') {
        logger.info('beta gate is ENABLED');
    }
    if (process.env.SESSION_SECRET) {
        logger.info('session management is ENABLED');
    }
});
```

Middleware order explanation:

1. `request_logger` — log every request.
2. `health_router` — health checks bypass everything.
3. `beta_router` / `beta_gate` — beta gate runs before sessions (you need
   beta access before you can log in).
4. `create_session_middleware` — load/create session from Postgres.
5. `create_session_guard` — enforce idle timeout and absolute expiry.
6. `create_session_routes` — intercept `/api/auth/*` to manage session ↔ JWT.
7. `create_proxy` — proxy everything else, injecting JWT from session.

### 7. Modify: `services/bff/src/logging.ts`

Add a `session` category:

```typescript
session: { appenders: ['stdout'], level: 'info' },
```

### 8. Modify: `lib/auth-context.tsx` (Next.js frontend)

Major simplification. The frontend no longer manages tokens.

**Remove:**
- `TOKEN_KEY` constant
- All `localStorage.getItem/setItem/removeItem` calls
- `token` from `AuthState`
- `Authorization` header construction in `api_post` and `api_get`
- `useAuthFetch` Bearer token injection

**New behavior:**

- `api_post` and `api_get` use `credentials: 'include'` (or `'same-origin'`)
  to ensure the session cookie is sent automatically:
  ```typescript
  async function api_post(path: string, body: Record<string, unknown>) {
      const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
      });
      return res.json();
  }

  async function api_get(path: string) {
      const res = await fetch(path, { credentials: 'same-origin' });
      return res.json();
  }
  ```

- `login` / `signup`: call the endpoint, response has user data but no token.
  On success, set user state. No localStorage write.

- `hydrate` on mount: GET `/api/auth/me`. If 200, set user state. If 401, set
  user to null. No token to check.

- `logout`: POST `/api/auth/logout`. Clear user state.

- `useAuthFetch`: simplified — just adds `credentials: 'same-origin'` and
  `Content-Type`, no `Authorization` header:
  ```typescript
  export function useAuthFetch() {
      return useCallback(
          (url: string, init?: RequestInit) => {
              const headers = new Headers(init?.headers);
              headers.set('Content-Type', 'application/json');
              return fetch(url, {
                  ...init,
                  headers,
                  credentials: 'same-origin',
              });
          },
          [],
      );
  }
  ```

### 9. Modify: `services/bff/src/beta_gate.ts`

Add `/api/auth/login`, `/api/auth/signup`, and `/api/auth/logout` to
`OPEN_PREFIXES` so that authentication endpoints are accessible before a
session exists:

```typescript
const OPEN_PREFIXES = [
    '/beta',
    '/bff-health',
    '/nginx-health',
    '/api/health/check',
    '/api/auth/login',
    '/api/auth/signup',
    '/api/auth/logout',
];
```

### 10. New environment variables on BFF service (Railway)

| Var | Value |
|-----|-------|
| `DATABASE_URL` | Same Postgres connection string used by the CliqHub app |
| `SESSION_SECRET` | A strong random string (e.g. `openssl rand -hex 32`) |
| `SESSION_MAX_AGE` | `2592000000` (30 days) or as desired |
| `SESSION_IDLE_TIMEOUT` | `7200000` (2 hours) or as desired |
| `SESSION_ROLLING` | `true` |
| `SESSION_COOKIE_NAME` | `cliqhub_sid` |

### 11. TypeScript session type augmentation

Create `services/bff/src/types.d.ts` to extend the `express-session` types
with the custom session fields:

```typescript
import 'express-session';

declare module 'express-session' {
    interface SessionData {
        jwt: string;
        created_at: number;
        last_active: number;
    }
}
```

---

## Files Touched — Summary

| Component | File | Action |
|-----------|------|--------|
| BFF | `services/bff/package.json` | Add `express-session`, `connect-pg-simple`, `@types/express-session` |
| BFF | `services/bff/src/session.ts` | New — session middleware factory |
| BFF | `services/bff/src/session_routes.ts` | New — auth endpoint interception |
| BFF | `services/bff/src/session_guard.ts` | New — idle timeout + absolute expiry enforcement |
| BFF | `services/bff/src/types.d.ts` | New — TypeScript session type augmentation |
| BFF | `services/bff/src/proxy.ts` | Modify — inject JWT from session into proxied requests |
| BFF | `services/bff/src/index.ts` | Modify — mount session middleware, guard, and routes |
| BFF | `services/bff/src/logging.ts` | Modify — add `session` log category |
| BFF | `services/bff/src/beta_gate.ts` | Modify — add auth endpoints to open prefixes |
| Frontend | `lib/auth-context.tsx` | Modify — remove localStorage, simplify to cookie-based auth |

## What Doesn't Change

| Component | Reason |
|-----------|--------|
| `lib/auth.ts` (Next.js) | Still validates JWTs and API tokens on every request |
| `lib/route_helper.ts` (Next.js) | Still calls `resolve_auth()` with Bearer tokens |
| `lib/handlers/auth.ts` (Next.js) | Still issues JWTs on login/signup (response now includes `hug_token` and `hug_server_url` per HUG token design) |
| CLI (`cliq hub login`) | Sends `X-Client: cli` header on login; BFF passes full response through without session creation |
| CLI (subsequent requests) | Sends `Authorization: Bearer` directly, bypasses sessions |
| API tokens (`cliq_tok_*`) | Pass through BFF unchanged |
| Admin routes | JWT validation is server-side in Next.js, unaffected |

## Implementation Order

1. Add npm dependencies to BFF `package.json`.
2. Create `types.d.ts` for session type augmentation.
3. Create `session.ts` — middleware factory with Postgres store.
4. Create `session_guard.ts` — idle timeout + absolute expiry.
5. Create `session_routes.ts` — auth endpoint interception.
6. Modify `proxy.ts` — JWT injection from session.
7. Modify `beta_gate.ts` — add auth endpoints to open prefixes.
8. Modify `logging.ts` — add session log category.
9. Modify `index.ts` — mount new middleware in correct order.
10. Add environment variables to BFF service in Railway.
11. Deploy BFF, verify session creation and auth flow.
12. Modify `auth-context.tsx` — remove localStorage, switch to cookie-based.
13. Deploy Next.js app, verify end-to-end browser auth flow.
14. Verify CLI auth still works unchanged.
