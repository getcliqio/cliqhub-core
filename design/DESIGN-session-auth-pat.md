# DESIGN — Session auth via user PAT (no Hub JWT)

**Status:** in progress  
**Author:** sapan  
**Companion implementation:** [`DESIGN-session-auth-pat-IMPLEMENTATION.md`](./DESIGN-session-auth-pat-IMPLEMENTATION.md)

---

## 1. Goal

Replace Hub **session JWTs** with **session-scoped user PATs** (`cliq_tok_…`).

- **BFF** owns the browser session (`session_id` cookie).
- **Core** accepts exactly two Bearer forms: **user PAT** (`cliq_tok_…`) and **realm token** (`cliq_dt_…`).
- Act-as (formerly impersonate) is **session update**, not a Core RPC.
- **No backward compatibility** — no aliases, no `cliq_dk_…`, no `hub.token`, no empty-grant “full power” PATs.

---

## 2. Credential model

| Kind | Prefix | Who mints | Used by |
|------|--------|-----------|---------|
| User PAT (incl. session-scoped) | `cliq_tok_…` | Core (`generate_token` or internal session mint) | BFF→Core, CLI `hub.session`, automation `cliq.api_key` |
| Realm token | `cliq_dt_…` | Core `generate_token` type=realm | Daemon enroll / realm-scoped Hub calls |

**Rejected:** Hub session JWT, `cliq_dk_…`, any non-prefixed JWT Bearer on Hub `/v1`.

---

## 3. Session model (BFF)

Every session stores **both** token fields:

```
user_id              // who authenticated (immutable for this login)
act_as_user_id       // who the UI / Core runs as
user_token           // session PAT for user_id — set at login; never replaced on act-as
target_token         // session PAT for act_as_user_id — ALWAYS used as Bearer to Core
```

| Event | Behavior |
|-------|----------|
| **Login** | Mint one session PAT → `user_token = target_token`; `user_id = act_as_user_id` |
| **Act-as** | Mint session PAT for target → update **only** `target_token` + `act_as_user_id`; `user_token` unchanged |
| **Exit act-as** | Revoke `target_token` if distinct from `user_token`; set `target_token = user_token`; `act_as_user_id = user_id` |
| **Logout** | Revoke both if distinct; destroy session; clear cookie |

Cookie carries **only** `session_id`. The browser never holds Hub PATs.

CLI may receive `target_token` once from `session/create` (`X-Client: cli`) and store it as `hub.session`.

---

## 4. API contracts

### 4.1 Core — internal only

| Endpoint | Body | Response |
|----------|------|----------|
| `POST /internal/auth/authenticate_user` | `{ username, password }` | `{ user_id, username, role, token, default_realm_*, enroll_token?, … }` |
| `POST /internal/auth/issue_session_token` | `{ user_id }` | `{ user_id, token }` — mint session-scoped PAT **as** that user |
| `POST /internal/auth/revoke_session_token` | `{ token }` | `{ ok: true }` |
| `POST /internal/auth/signup` | existing | session PAT (not JWT) |

`issue_session_token` requires site-admin actor (Bearer = admin’s `user_token` / current admin PAT).

### 4.2 BFF — session resource

| Endpoint | Body | Behavior |
|----------|------|----------|
| `POST /v1/session/create` | `{ username, password }` | authenticate → persist session → Set-Cookie; CLI may get `{ token }` |
| `POST /v1/session/get` | `{}` | identity for `act_as_user_id`; `acting_as` when unequal |
| `POST /v1/session/update` | `{ act_as_user_id: number \| null }` | null = exit act-as |
| `POST /v1/session/delete` | `{}` | revoke PAT(s); destroy session; clear cookie |

All BFF→Core **data-plane** calls use `Authorization: Bearer <target_token>`.  
Admin check before act-as may use `user_token`.

### 4.3 Core — public token APIs (unchanged paths)

Keep: `generate_token`, `get_tokens`, `revoke_token`, `rotate_token`, `validate_token` (and scopes/acl as applicable).

### 4.4 Hard deletes

- Core: `/v1/auth/login`, `/me`, `/refresh`, `/impersonate`, `/impersonate/exit`
- BFF: `/v1/auth/login`, `/me`, `/logout`, `/impersonate`, `/impersonate/exit`
- JWT Hub auth path; `cliq_dk_` acceptance; `hub.token`; empty-scope full-power bypass

---

## 5. Surfaces

| Surface | Change |
|---------|--------|
| **Core** | Internal authenticate/issue/revoke; PAT\|realm middleware only; remove JWT session routes |
| **BFF** | Session CRUD + `user_token`/`target_token`; proxies use `target_token` |
| **SPA** | `/v1/session/*`; act-as via `session/update` |
| **CLI** | Login → session/create; `hub.session` = `cliq_tok_…`; drop JWT refresh + `hub.token` |
| **Daemon** | `hub.session` PAT only; no `/v1/auth/me` dependency |
| **Docs / OpenAPI** | Two Bearers + BFF session model |
| **SDK** | N/A unless a client hardcodes login JWT |

---

## 6. Non-goals

- Backward-compatible aliases  
- Supporting `cliq_dk_…` or Hub session JWT  
- Merging `hub.session` and `cliq.api_key` setting keys (optional later)

---

## 7. Done means

Core comments state the model; session always drives Core via `target_token`; act-as only swaps `target_token`; unit + e2e/Playwright green; legacy forms and old auth URLs rejected (404/401).
