# Design: cliqd-first boot + cliq login overhaul

> Status: **proposed**
> Date: 2026-10-01

## Summary

Flip the startup order so `cliqd` starts first and `cliq login` talks to
the running daemon. Eliminate `~/.cliqrc/settings.json` entirely — the
daemon's SQLite store becomes the single source of truth for all
credentials, identity, and configuration.

Add realm-lock semantics so a system daemon can't be accidentally moved
to a different realm by a user login. Add an interactive realm picker
to `cliq login` for users with multiple authorized realms.

---

## Motivation

Today the boot sequence is:

```
cliq login  →  writes hub.session to settings.json
cliqd       →  reads settings.json, imports session, auto-enrolls
```

Problems:

1. **Two credential stores.** `settings.json` holds bootstrap keys
   (`hub.session`, `cliq.api_url`, `daemon.id`, `daemon.name`,
   `daemon.db_path`, `cliq.api_key`). The daemon's SQLite holds
   everything else. `cliqd` has a `_import_hub_session_from_cliqrc()`
   shim to bridge the gap — fragile and surprising.

2. **No realm protection.** A user login auto-enrolls the daemon into
   the user's default realm. On a shared/system daemon, this silently
   moves the machine to a different realm.

3. **Ordering dependency.** `cliq login` must run before `cliqd`. If the
   daemon is already running, `cliq login` writes to a file that the
   daemon doesn't re-read until restart.

---

## Design

### Principle

Two credentials, two owners:

| Credential | Type | Belongs to | Survives logout? |
|-----------|------|-----------|-----------------|
| Daemon token `cliq_dt_…` | Machine | The daemon | Yes |
| User session `cliq_tok_…` | Person | The logged-in user | No |

### New boot sequence

```
cliqd                    ← starts first (local-only until login)
cliq login               ← authenticates user via daemon RPC
                           daemon enrolls / stays enrolled
```

### `cliqd` changes

#### New flag: `--hub <url>`

Daemon owns the Hub API URL. Persisted in SQLite on first use.

| Source | Priority |
|--------|----------|
| `--hub <url>` | 1 (highest) |
| `CLIQ_API_URL` env | 2 |
| Value in SQLite from prior boot | 3 |
| `https://api.cliqhub.io` | 4 (default) |

#### New flag: `--allow-realm-override`

Controls whether a user login can change the daemon's realm.

- **Off (default):** Daemon realm is locked after first enrollment.
  Subsequent logins succeed only if the user is a member of the
  daemon's current realm. The realm does not change.

- **On:** User login can switch the daemon to a different realm
  (via the interactive picker or `cliq login --realm`).

Personal laptop: `cliqd --allow-realm-override`.
Shared/CI daemon: `cliqd` (locked by default).

#### Removed flag: `--realm`

Realm selection is a user operation. It moves to `cliq login --realm`.

#### Removed: `_import_hub_session_from_cliqrc()`

No settings.json to import from.

### `cliq login` changes

#### New endpoint: daemon RPC

`cliq login` no longer writes to a file. It sends an RPC to the running
daemon. The daemon authenticates the user with Hub and stores the
session PAT in SQLite.

```
CLI                          Daemon                       Hub
 │                             │                            │
 │  login_request              │                            │
 │  {username, password}  ───► │                            │
 │     or {headless: true}     │  POST /v1/session/create   │
 │                             │  ─────────────────────►    │
 │                             │  ◄─────────────────────    │
 │                             │  session PAT + profile     │
 │                             │                            │
 │                             │  (realm selection logic)   │
 │                             │  (enrollment if needed)    │
 │                             │                            │
 │  ◄──────────────────────    │                            │
 │  {ok, realm, user}         │                            │
```

#### Realm picker (interactive)

After authentication, the daemon fetches the user's authorized realms.

**Virgin daemon (no realm yet):**

```
Authenticated as alice@acme.com

Select a realm:
  ❯ acme.ops
    acme.staging
    acme.dev

Enrolled in acme.ops.
```

If the user has exactly one realm, skip the picker.

**Enrolled daemon, `--allow-realm-override`:**

```
Authenticated as alice@acme.com

Daemon is enrolled in acme.ops.
Select a realm:
  ❯ acme.ops (active)
    acme.staging
    acme.dev

Keeping acme.ops.
```

**Enrolled daemon, realm locked (default):**

```
Authenticated as alice@acme.com
Daemon is enrolled in acme.ops.
Logged in.
```

No picker. No option to change.

**Enrolled daemon, user is NOT a member:**

```
Login failed: you are not a member of realm acme.ops.
```

#### New flag: `--realm <org.slug>`

Skip the interactive picker. Explicit realm selection.

```bash
cliq login --realm acme.staging
```

On a locked daemon, `--realm` is rejected if it differs from the
enrolled realm:

```
error: daemon realm is locked to acme.ops.
Start cliqd with --allow-realm-override to permit realm changes.
```

#### Removed flag: `--hub <url>`

Hub URL is now a daemon concern (`cliqd --hub`).

#### Headless / CI

```bash
cliq login --headless username:bot password:… --realm acme.ops
```

No picker. If `--realm` is omitted on a virgin daemon, uses the
user's default realm. On an enrolled daemon, keeps the current realm.

### `cliq logout`

1. Revoke user session PAT on Hub.
2. Clear `hub.session` and `hub.username` from daemon SQLite.
3. **Daemon token stays.** Daemon keeps heartbeating, running pipelines,
   stays in its realm.
4. User-level operations (publish, token management, builder) return
   "not logged in" until the next `cliq login`.

The daemon is a server. Users come and go.

### `cliq whoami`

No change. Already talks to daemon only (`daemon_status` RPC).

---

## Daemon state machine

```
                         cliq login
   ┌──────────┐        (first user)       ┌──────────────┐
   │  VIRGIN  │ ───────────────────────►  │  ENROLLED    │
   │ no token │   authenticate            │ has cliq_dt  │
   │ no realm │   pick/specify realm      │ realm locked │
   │          │   mint token, enroll      │              │
   └──────────┘                           └──────┬───────┘
        ▲                                        │
        │                                        │ cliq login
        │ cliqd --reset-id                       │ (subsequent)
        │                                        ▼
        │                                 ┌──────────────┐
        │                                 │ user in      │
        │                                 │ daemon realm? │
        │                                 └──────┬───────┘
        │                                   │         │
        │                                  yes        no
        │                                   │         │
        │                                   ▼         ▼
        │                              store      reject
        │                              session    login
        │                                   │
        │                                   │ (if --allow-realm-override
        │                                   │  and user picks new realm)
        │                                   ▼
        │                              re-enroll
        │                              into new realm
        └────────────────────────────────────┘
```

---

## `settings.json` elimination

Every key migrates or becomes unnecessary:

| Key | Current home | New home |
|-----|-------------|----------|
| `hub.session` | settings.json → daemon imports | Daemon SQLite (written by `cliq login` RPC) |
| `hub.username` | settings.json | Daemon SQLite |
| `hub.default_realm_*` | settings.json | Daemon SQLite (from login/enroll) |
| `cliq.api_url` | settings.json | `cliqd --hub` / `CLIQ_API_URL` / SQLite |
| `cliq.api_key` | settings.json | `CLIQ_API_KEY` env or `cliq auth token` → daemon SQLite |
| `daemon.id` | settings.json (redundant copy) | Daemon SQLite (`ensure_self`) |
| `daemon.name` | settings.json | `cliqd --name` / `CLIQ_DAEMON_NAME` / SQLite |
| `daemon.db_path` | settings.json | Fixed `~/.cliqrc/data/daemon.db` + `CLIQ_STORE_SQLITE_PATH` env |

After migration, `settings.json` is not read or written by any
component. The file can be ignored (existing files are harmless).

---

## Daemon boot table

| Has `cliq_dt_…`? | Has user session? | `--hub` | What happens |
|:-:|:-:|:-:|---|
| Yes | any | any | Enroll with existing token, same realm. Daemon is connected. |
| No | Yes | any | Auto-enroll using stored session (realm from last login). |
| No | No | any | Start local-only. Waits for `cliq login`. |

---

## Token lifecycle

### Happy path

```
cliqd                               starts local-only (virgin)
cliq login                          user authenticates
                                    daemon mints cliq_dt_…
                                    daemon registers with Hub
                                    heartbeat begins (30s interval)
...
cliq logout                         user session cleared
                                    daemon token stays
                                    daemon keeps heartbeating
...
cliq login                          new user (must be realm member)
                                    session stored, daemon unchanged
```

### Token revocation (realm admin revokes daemon token)

```
heartbeat returns 401               daemon enters degraded mode
                                    local pipelines still run
                                    Hub sync/outbox paused
                                    logs warning
...
cliq login                          user authenticates
                                    daemon re-enrolls, mints new token
                                    Hub sync resumes
```

### Identity reset

```
cliqd --reset-id --yes              wipe SQLite, daemon identity, token
                                    daemon starts virgin
cliq login                          fresh enrollment
```

---

## Daemon RPC endpoints

### Existing: `POST /v1/login` (modify)

Already exists in `hub.controller.ts` → `HubService.login()`. Currently
accepts `{ credentials: { username, password } }` or
`{ credentials: { token } }`, authenticates with Hub, and stores the
session PAT in SQLite.

**Changes required:**

1. **Add realm-awareness to the response.** After authentication, fetch
   the user's authorized realms from Hub (reuse the existing
   `POST /v1/realms/get` call from `DaemonService`). Return them to the
   CLI so the realm picker can render.

2. **Accept optional `realm` field.** If provided, authenticate and
   enroll in one call (skip-picker shortcut for `--realm` flag, single
   realm, or enrolled daemon). If omitted on a virgin daemon, return
   the realm list without enrolling — the CLI renders the picker and
   calls `POST /v1/set_realm` to complete.

3. **Enforce realm lock.** If the daemon has a `cliq_dt_…` and
   `--allow-realm-override` is not set:
   - Check that the authenticated user is a member of the daemon's
     current realm.
   - If not, reject with `403 "you are not a member of realm X"`.
   - If yes, store the session but do not change the realm.
   - If `realm` is specified and differs from the current realm,
     reject with `403 "daemon realm is locked to X — start cliqd
     with --allow-realm-override to permit realm changes"`.

4. **Defer `refresh_after_login()`** (daemon registration) to only run
   when enrollment completes. Skip it when returning the realm list
   without enrollment.

**Request (updated):**

```json
{
  "credentials": {
    "username": "alice",
    "password": "…"
  },
  "realm": "acme.ops"
}
```

`realm` is optional. Omit it to get the realm list (virgin daemon) or
keep the current realm (enrolled daemon).

**Response (updated):**

```json
{
  "ok": true,
  "data": {
    "identity": "alice",
    "expires_at": null,
    "realm": "acme.ops",
    "realm_locked": true,
    "enrolled": true,
    "authorized_realms": [
      { "slug": "acme.ops", "qualified_slug": "acme.ops", "active": true },
      { "slug": "acme.staging", "qualified_slug": "acme.staging", "active": false }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `identity` | Authenticated username |
| `expires_at` | Session expiry (epoch ms), or null |
| `realm` | The realm the daemon is enrolled in, or null if virgin and no realm selected |
| `realm_locked` | True if daemon has a token and `--allow-realm-override` is not set |
| `enrolled` | True if enrollment completed on this call |
| `authorized_realms` | User's realms from Hub. Always returned. `active: true` marks the daemon's current realm. |

### New: `POST /v1/set_realm`

Completes the interactive realm picker flow. Called after `login`
returns `authorized_realms` without enrolling (virgin daemon, no
`realm` in the request).

Requires a valid session in the daemon (from the preceding `login`
call). No credentials — the user already authenticated. No Hub
round-trip for auth — just enrollment.

**Request:**

```json
{
  "realm": "acme.ops"
}
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "realm": "acme.ops",
    "enrolled": true
  }
}
```

**Error cases:**

| Condition | Response |
|-----------|----------|
| No session stored | `401 "not logged in — run cliq login first"` |
| `realm` not in user's authorized list | `403 "you are not a member of realm acme.ops"` |
| Daemon realm locked, realm differs | `403 "daemon realm is locked to X"` |

### Interactive picker flow (full sequence)

```
CLI                              Daemon                          Hub
 │                                 │                               │
 │  POST /v1/login                 │                               │
 │  { credentials }           ───► │  POST /v1/session/create  ──► │
 │                                 │  ◄── session PAT + profile    │
 │                                 │  POST /v1/realms/get      ──► │
 │                                 │  ◄── realm list               │
 │  ◄── { authorized_realms,      │                               │
 │        enrolled: false }        │                               │
 │                                 │                               │
 │  (render picker)                │                               │
 │                                 │                               │
 │  POST /v1/set_realm       │                               │
 │  { realm: "acme.ops" }    ───►  │  auto_enroll(realm)       ──► │
 │                                 │  ◄── cliq_dt_… + dispatch key │
 │  ◄── { enrolled: true }        │                               │
```

### Skip-picker shortcuts (single call)

| Scenario | What the CLI sends | Result |
|----------|-------------------|--------|
| `cliq login --realm acme.ops` | `{ credentials, realm: "acme.ops" }` | Auth + enroll in one call |
| User has exactly one realm | CLI reads `authorized_realms[0]`, calls `set_realm` automatically | No picker shown |
| Daemon already enrolled, realm locked | `{ credentials }` (no realm) | Auth only, keep current realm |

### Existing: `POST /v1/logout` (modify)

Already exists. Currently clears `hub.session` and login-time defaults.

**Changes:**

1. Revoke the session PAT on Hub (`POST /v1/session/delete`) before
   clearing locally.
2. Daemon token (`cliq_dt_…`) is explicitly **not** cleared. Daemon
   stays enrolled and keeps heartbeating.

**Response (unchanged):**

```json
{
  "ok": true,
  "data": { "cleared": true }
}
```

### Existing: `daemon_status` (no change)

Already returns `hub_logged_in`, `hub_profile`, `realm`, `realm_id`,
etc. No modifications needed.

---

## CLI command changes summary

| Command | Change |
|---------|--------|
| `cliqd` | Add `--hub <url>`, `--allow-realm-override`. Remove `--realm`. |
| `cliq login` | Sends RPC to daemon instead of writing file. Add `--realm <org.slug>`. Add interactive realm picker. Remove `--hub`. |
| `cliq logout` | Sends RPC to daemon. Clears user session only, daemon token stays. |
| `cliq whoami` | No change. |
| `cliq settings` | No change (already talks to daemon). |
| `cliq auth token` | No change (already talks to daemon). |

---

## Implementation

Single cut — no phased migration or backward compatibility.

1. Add `login`/`logout` daemon RPC endpoints.
2. Rewrite `cliq login` to talk to the daemon. Add `--realm` flag and
   interactive realm picker. Remove `--hub`. Fail if daemon is not
   running.
3. Rewrite `cliq logout` to talk to the daemon. Clear user session
   only.
4. Add `--hub` and `--allow-realm-override` to `cliqd`. Remove
   `--realm` from `cliqd`.
5. Delete all `settings.json` reads/writes. Delete
   `_import_hub_session_from_cliqrc()`. Delete `load_global_settings`
   / `save_global_settings` in the CLI.
6. Update docs, QUICKSTART, get-started, cli.mdx, cliqd.mdx.

---

## Amendments (2026-10-05, after the Krupali incident) — approved by Sapan

Incident: a restart / re-login re-ran auto-enroll (every boot without
`CLIQ_DAEMON_TOKEN` re-enrolled into the *user's default* realm), so a
daemon in `measureone` moved to `krupali.default` mid-run. Core then
refused the in-flight run's updates (`404 daemon_other_realm`) and sent 48
team uninstalls. Constraints for the build: **CLI + daemon only — no new
endpoints (Hub or daemon), no Core change.**

1. **No `POST /v1/set_realm`.** The picker completes through the existing
   `POST /v1/login`: `{ realm }` without `credentials` is accepted when the
   daemon already holds the session from the preceding call.
2. **Boot reuses the stored daemon token** (`hub.daemon_token`) and stays in
   its realm. Auto-enroll runs only when there is no token.
3. **Never move a daemon with active runs.** A realm change (override on)
   is refused while runs are `running` / `awaiting_input` / `paused`:
   `409 "N run(s) in progress on this daemon — wait or cancel them first"`.
4. **Show what a switch removes.** The login reply carries
   `teams_to_remove` (installed teams not in the target realm's team list);
   the CLI confirms before switching.
5. **`--reset-db` keeps the daemon token and realm keys** (identity +
   enrollment survive; only local state is wiped). `--reset-id` still wipes
   everything.
6. **Revoked / missing token → re-enroll into the same realm** (stored
   `hub.realm_slug`), never the user's default.
7. **Boot without token and without session starts local-only** (no exit);
   `cliq login` enrolls it.

## Decisions

1. **`cliq login` without a running daemon fails.** No auto-start.
   Error: "daemon is not running — start cliqd first."

2. **`--allow-realm-override` is boot-time only, not persisted.**
   Each `cliqd` invocation must explicitly opt in. Also available as
   `CLIQ_ALLOW_REALM_OVERRIDE=1` env var for Docker/systemd configs
   where the flag can't be passed interactively.

3. **Single user session.** One login at a time. A second `cliq login`
   replaces the previous session. No multi-user support.
