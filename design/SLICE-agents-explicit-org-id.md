# SLICE: Agents explicit `org_id` + Hub identity

**Status:** in progress — Core AG-1a…AG-1d green on `slice/agents-explicit-org-id`; callers (AG-2+) next  
**Location:** `cliqhub-core/design/` (Hub design SoT; legacy `cliqhub` monorepo retired)  
**Depends on:** `SLICE-agents-api-dto-envelope.md` (envelope `{ ok, data }` already done)  
**Rule:** hard-cut — **no** `X-Org-Id` / `current_org_id` for agents; missing body `org_id` → **400**  
**No new product resources.** One hard-cut rename: `get_by_id` → `get_details` (no alias).

---

## Refactoring rules (mandatory)

Implementation of this slice **must** follow the workspace refactor / Hub API rules — not “best effort.” Cite and audit against these before claiming done:

| Rule / SoT | What it forces on this slice |
|------------|------------------------------|
| **`architecture-endpoints-before-impl`** | No new product endpoints beyond the locked rename; no temporary aliases; consolidate before adding. |
| **Hard-cut (Hub API style)** | No dual paths, no shims, no “compat” `get_by_id` beside `get_details`, no header **and** body tenancy. One contract; callers move in the same release window as Core. |
| **`backend-mvc-layers`** | `routes → controllers → services → schemas` only. No business logic in routes; no `req`/`res` in services; one agents resource file set. |
| **`hub-core-api-standards`** | Zod `*Input` / `*Data` with `.describe` on every field; envelope `{ ok, data }`; early returns / **no `else`**; snake_case; class methods only (no module-level helpers in controllers/services); in-function step comments; one-line params; OpenAPI regen when I/O changes. |
| **`uuid-primary-keys`** | `org_id` and catalog `id` are UUID strings on the wire (`z.string().uuid()`). |
| **`endpoint-cli-contract-tests`** | Trace CLI/daemon Hub callers; real envelope; Bearer hydrate; wire proofs C1–C5 — package unit green alone is not enough. |
| **`verify-before-claiming-fixed`** | Full suites for **every** changed surface; fix **all** failures; re-run before claim; print `EXIT:$?`; no “e2e later.” |
| **`docs-must-update-on-push`** | OpenAPI + MDX in the same session; push `documentation/` so Mintlify redeploys. |
| **Focused change** | Only agents org-id / identity / caller cleanup in this slice. No drive-by refactors of unrelated resources. |
| **Plan close-loop** (`hub-core-api-standards` § Plan verification) | Diff vs this doc → mark done/pending → finish pending → rule-compliance audit on every changed file → then green-gate. |

**Do not:**

- Leave Core on body `org_id` while SPA still depends on `X-Org-Id` for agents (or the reverse).
- Keep `get_by_id` as an alias “for a bit.”
- Skip docs, callers, or contract proofs for a follow-up.
- Waive red tests as pre-existing.

---

## Architecture answers

1. **Needed?** Yes — catalog/settings are org-owned; ambient header tenancy is multi-org-unsafe. Hub one-agent settings must key by catalog UUID; `get_by_id` is a misnomer once name XOR exists.
2. **Merged?** No extra routes beyond renaming `get_by_id` → `get_details`. Same six concerns, clearer names.
3. **Model?**
   - **Auth (who):** `Authorization: Bearer` only (`cliq_tok_…` / session-hydrated PAT, or `cliq_dt_…`).
   - **Tenancy (which org):** explicit `org_id` in JSON body — never from header for agents.
   - **Authz:** credential’s allowed orgs must include `body.org_id` (see Auth below).
   - **Catalog identity:** UUID for settings; `get_details` / `deregister` share `id` XOR `name`(+`version`).
   - **Daemon local:** JIT `get_by_id` by name stays on the daemon plane (unchanged).
4. **Hard-cut?** Yes — no header fallback, no dual path name for `get_by_id`.

---

## Auth (locked)

Orgs are **not** “in the header.” Header carries the credential; Core loads memberships (or realm) and intersects with body `org_id`.

```
Authorization: Bearer <token>
        ↓
auth middleware → req.auth
        ↓
┌─ PAT / session (auth_via = pat | jwt)
│     live DB: org memberships for user
│     req.auth.org_ids = [ … ]
│     assert: body.org_id ∈ auth.org_ids  → else 403
│
└─ Daemon token (auth_via = daemon_token)
      token bound to realm_id
      load realm; assert realm.org_id === body.org_id  → else 403
      (if body.realm_id also sent: must match token’s realm)
        ↓
service runs in body.org_id scope
```

| Piece | Role |
|-------|------|
| `Authorization` | Who you are |
| `body.org_id` | Which org this call targets (client must send; Core never invents for agents) |
| `auth.org_ids` | Live membership list for PAT (from `org_member_repo`, not JWT-alone SoT) |
| `X-Org-Id` / `current_org_id` | **Ignored** on agents controllers |

Controller sequence (every agents route):

1. Parse body (Zod) — `org_id` required UUID.
2. `assert_org_authorized(req.auth, body.org_id)` as above.
3. If `realm_id` on settings: realm exists and `realm.org_id === body.org_id`.
4. After load-by-`id`: custom row’s `org_id` must equal `body.org_id` (else 404/403); system rows readable for settings, not deregisterable.
5. Service → `{ ok, data }`.

**Do not** call `require_org_id(req)` / `resolve_current_org_id` from `AgentsController`.

---

## Branching

| Repo | Branch |
|------|--------|
| `cliqhub-core` | `slice/agents-explicit-org-id` |
| `cliqhub-frontend` | `slice/agents-explicit-org-id` |
| `cliqhub-bff` | `slice/agents-explicit-org-id` |
| `cliq-platform` | `slice/agents-explicit-org-id` |
| `documentation` | `slice/agents-explicit-org-id` |

Core first (or same release window as SPA/daemon). Missing `org_id` → 400 once Core lands.

---

## Locked wire contract

### Shared field

```ts
org_id: z.string().uuid().describe(
  'Organization this call targets. Caller must be authorized for this org '
  + 'via the Bearer credential (PAT membership or daemon realm org).',
)
```

### Per route

| Path | Required | Agent selector | Optional |
|------|----------|----------------|----------|
| **`POST /v1/agents/get`** | `org_id` | — (list) | `query` (ILIKE name\|description), `names` (IN), `agent_type`, `include_manifest` |
| **`POST /v1/agents/get_details`** *(was `get_by_id`)* | `org_id` + XOR | **`id`** **XOR** (`name` + optional `version`) | `include_manifest` |
| **`POST /v1/agents/register`** | `org_id`, `name`, `manifest` | create `(org, name, version)` | `version`, `description`, `agent_type`, `force` |
| **`POST /v1/agents/deregister`** | `org_id` + XOR | **`id`** **XOR** (`name` + optional `version`) | — |
| **`POST /v1/agents/get_settings`** | `org_id` | omit selector → summary list; **`id`** → one agent | `realm_id` |
| **`POST /v1/agents/update_settings`** | `org_id`, **`id`**, `settings` | UUID only | `realm_id` |

### XOR rule (`get_details`, `deregister`)

- Exactly one of `id` or `name`.
- If `id`: `version` must not be sent; load that catalog row.
- If `name`: optional `version` (omit = newest active for `get_details`; omit = all org versions for `deregister`).

### Identity split

| Concern | Hub | Daemon local |
|---------|-----|--------------|
| Catalog detail | `get_details` (id XOR name) | `/v1/agents/get_by_id` by name (JIT) — unchanged |
| Settings get/update | **`id` only** | N/A |
| Deregister | id XOR name(+version) | CLI `unregister <name>` → Hub name arm + `org_id` |
| Register | name + manifest | same → Hub |
| List | `get` + filters | Hub `get` |

### Response

Unchanged envelope: `{ ok: true, data: T }`.  
`AgentData.id` is what SPA round-trips into settings / id-path detail.

### Storage note

Settings tables still key by `agent_name`. Service resolves `id` → name for writes. FK to `agent_catalog.id` = follow-up **AG-SET-FK**.

---

## MVC

```
routes/v1/agents.ts  →  AgentsController  →  AgentService
schemas/agents/inputs.ts
schemas/agents/data.ts
```

- Routes: wire only; register `get_details`, remove `get_by_id`.
- Controller: parse → `assert_org_authorized` → service → `this.ok`. Early returns; snake_case; typed.
- Shared XOR helper (Zod refine or `z.union`) reused by `get_details` + `deregister`.

---

## Caller cleanup — stop using `X-Org-Id` for agents

**Rule for this slice:** every Hub `/v1/agents/*` caller must (1) put `org_id` in the JSON body and (2) **not** rely on `X-Org-Id` for agents tenancy. Prefer **not sending** `X-Org-Id` on agents requests at all.

`useOrgFetch` today attaches `X-Org-Id` to *every* call. That stays valid for realms/runs/reviews/etc. until those slices migrate (**HDR-1**). For **agents**, callers switch off that header path.

### How SPA cleans agents calls

| Pattern | Use |
|---------|-----|
| **Agents-only pages/panels** | `useAuthFetch` (Bearer only) + `org_id: current_id` from `useOrg()` in body. **Do not** use `useOrgFetch`. |
| **Mixed pages** (e.g. install wizard also hits teams/realms) | Keep `useOrgFetch` for non-agents routes. For `/v1/agents/*` only: use Bearer fetch **without** setting `X-Org-Id`, body carries `org_id`. |
| Fail closed | If `current_id` missing → do not call agents APIs. |

Optional helper (same slice OK): `fetch_agents(path, body)` = auth fetch + merge `{ org_id: current_id }` + assert no `X-Org-Id` header — keeps cleanup consistent.

### Inventory — clean each site

#### Core (`cliqhub-core`) — AG-ORG-1

| Site | Today | Cleanup |
|------|-------|---------|
| `AgentsController.require_org_id` | reads `req.user.current_org_id` (from `X-Org-Id` / default) | **Delete**; use `body.org_id` + `assert_org_authorized` only |
| Agents unit/integration tests | may set `X-Org-Id` or rely on default org | Bodies include `org_id`; tests that only set header for agents → **rewrite** to body; assert **400** without body `org_id` even if header present |

#### SPA (`cliqhub-frontend`) — AG-ORG-2

| File | Agents paths | Today | Cleanup |
|------|--------------|-------|---------|
| `agents_settings_panel.tsx` | `get_settings`, `update_settings` | `useOrgFetch` → header only | `useAuthFetch` + body `{ org_id, id?, settings? }`; no `X-Org-Id` |
| `realm_agent_settings_page.tsx` | `get_settings`, `update_settings` | `useOrgFetch` | same + `realm_id`; no `X-Org-Id` on agents |
| `install_team_wizard.tsx` | `get`, `get_settings`, `update_settings` | shared `auth_fetch` (org) | agents calls: Bearer-only + `org_id` (+ `id`); teams/realms may keep org fetch |
| `team_detail_page.tsx` | `get_settings` | `useOrgFetch` | Bearer-only + `org_id` / `id` for agents |
| SPA tests mocking agents | fixtures without `org_id` | add `org_id`; assert agents requests have **no** `X-Org-Id` (or at least body is SoT and Core ignores header) |

#### Daemon / CLI (`cliq-platform`) — AG-ORG-3

| Site | Today | Cleanup |
|------|-------|---------|
| `AgentHubService.hub_headers` | Bearer + `x-client` only — **already no `X-Org-Id`** | Keep; **never** add `X-Org-Id` for agents |
| `list_registered` / `register` / `unregister` bodies | no `org_id` | add `org_id` from `hub.org_id` / enrolled realm |
| `team.service` Hub `agents/get` (if any) | check call site | body `org_id`; no org header |
| CLI login / org switch | may lack `hub.org_id` | write durable `hub.org_id` |

#### BFF (`cliqhub-bff`) — AG-ORG-4

| Site | Today | Cleanup |
|------|-------|---------|
| `hub_passthrough` | forwards client `X-Org-Id` if present | **Do not inject** org header. If SPA stops sending it on agents, nothing to forward. Optional: strip `x-org-id` when path starts with `/v1/agents/` (belt-and-suspenders; document why) |
| Allowlist | `get_by_id` | → `get_details` |
| Fixtures / e2e hitting agents | header and/or empty body | body `org_id` (+ `id`); prefer **no** `X-Org-Id` on agents cases |

#### Docs (`documentation`) — AG-ORG-5

| Site | Cleanup |
|------|---------|
| Hub OpenAPI / agents MDX | Bearer + body `org_id`; **remove** examples that show `X-Org-Id` for agents |
| Auth note | Header = credential; body = org; membership check |

### What we are *not* cleaning in this slice

- Global `useOrgFetch` / Core `resolve_current_org_id` for **non-agents** APIs (realms, runs, reviews, notifications, …) — **HDR-1** / later resource slices.
- BFF still *may* forward `X-Org-Id` for those other paths.

Agents are the first hard-dep cleaned end-to-end: Core ignores header → callers stop sending it for agents → docs match.

---

## Out of scope

- Global drop of `X-Org-Id` middleware / `useOrgFetch` (**HDR-1**).
- Realms org-id hard-cut (**RM-ORG-1** → `SLICE-realms-explicit-org-id.md`).
- Settings table FK (**AG-SET-FK**).
- Renaming daemon-local `get_by_id`.
- Auth envelope DTO slice.

---

## Micro-slices

Each micro-slice is **independently stable**: coding standards + unit tests (+ coverage for new code) green before starting the next. Feature branch may be mid-cut across packages until AG-2/AG-3 land; **do not merge to main** until Core + SPA + platform callers are co-shipped.

| ID | Scope | Deliverable | Gate before next |
|----|-------|-------------|------------------|
| **AG-0** | design | This doc (micro-slices + test plan + refactor rules) | Doc committed on branch |
| **AG-1a** | Core | `org_id` on every `Agents*Input`; `assert_org_authorized`; delete `require_org_id` / header tenancy; **selectors unchanged** (still name where today) | ✅ `npm test` EXIT 0 |
| **AG-1b** | Core | Rename `get_by_id` → `get_details`; XOR `id` \| `name`(+`version`); route inventory | ✅ |
| **AG-1c** | Core | `get_settings` / `update_settings` by catalog **`id`**; `SettingsData.id`; realm_id org match | ✅ |
| **AG-1d** | Core | `deregister` XOR `id` \| `name`(+`version`) | ✅ |
| **AG-2** | SPA | Body `org_id` + settings by `id`; no `X-Org-Id` on agents calls | ✅ `npm test` EXIT 0 |
| **AG-3** | platform | `hub.org_id` + AgentHubService bodies; no org header | ✅ PLATFORM_EXIT 0 |
| **AG-4** | BFF | Allowlist `get_details`; fixtures; optional strip | ✅ unit + e2e EXIT 0 |
| **AG-5** | docs | OpenAPI + MDX; push | OpenAPI + agents.mdx updated on branch — **commit/push pending** |

**Order:** AG-0 → AG-1a → AG-1b → AG-1c → AG-1d → AG-2 + AG-3 (same window) → AG-4 → AG-5.

**Per-slice coding gate:** `hub-core-api-standards` + refactoring rules table; early returns; Zod `.describe`; no `else`; class methods; in-function comments; plan close-loop for that slice only.

**Merge to main:** after AG-5 (or AG-2+AG-3+AG-1* co-ready); never Core-only on production.

---

## Test plan

Rules: `verify-before-claiming-fixed` + `endpoint-cli-contract-tests`.  
**Done only when every suite below for every changed package is exit 0 / 0 failed in the claiming turn** — re-run, do not cite memory. Print `EXIT:$?` per command. Fix every failure (including unrelated) before moving on.

### A. What we test (by concern)

#### A1. Tenancy / authz (Core)

| Case | Expect |
|------|--------|
| Missing `org_id` on any of the six routes | **400** |
| `org_id` present + valid PAT member | **200** (happy path) |
| `org_id` not in PAT `auth.org_ids` | **403** |
| Only `X-Org-Id` header, no body `org_id` | **400** (header must not authorize agents) |
| Body `org_id` A + header `X-Org-Id` B (member of both) | Uses **body** A; still **200** if authorized for A |
| Daemon token + `org_id` = realm’s org | **200** on allowlisted agents paths |
| Daemon token + `org_id` ≠ realm’s org | **403** |
| `realm_id` on settings whose realm.org ≠ body `org_id` | **403** |

#### A2. Identity / selectors (Core)

| Case | Expect |
|------|--------|
| `get_details` with `id` | Returns that `AgentData` |
| `get_details` with `name` (+ optional `version`) | Same XOR semantics as today-by-name |
| `get_details` with both `id` and `name` | **400** Zod |
| `get_by_id` path | **404** (removed; no alias) |
| `get_settings` without `id` | Summary list for org (+ system) |
| `get_settings` / `update_settings` with `id` | Detail / mutate that row |
| `get_settings` / `update_settings` with `name` only | **400** (UUID required) |
| `deregister` by `id` | Soft-delete that row |
| `deregister` by `name` (+ optional `version`) | Existing multi-version behavior |
| `deregister` system agent | **403** |
| `register` creates row; response `id` usable on settings | Round-trip |

#### A3. Caller cleanup (SPA / BFF / daemon)

| Case | Expect |
|------|--------|
| SPA agents panel / realm agents / install wizard agents calls | Body has `org_id`; request **omits `X-Org-Id`** |
| SPA settings open/save | Body has catalog **`id`**, not `name` as selector |
| BFF allowlist | `get_details` present; `get_by_id` absent |
| `AgentHubService` Hub HTTP | Body `org_id`; headers have no `x-org-id` |
| CLI after login | `hub.org_id` set; unregister body includes it |

#### A4. Act-as / take over (SPA + BFF session)

| Case | Expect |
|------|--------|
| Admin take over → Agents tab | Bearer is target PAT; body `org_id` ∈ **target** memberships; list/settings work |
| Take over + `org_id` of admin-only org (not target’s) | **403** from Core |
| Exit take over | Agents work again as actor with actor’s `org_id` |

(Automated where session harness exists; otherwise documented live smoke in C3.)

### B. Automated suites (must pass)

Run **full** package suites for every changed surface — not a single-file subset as the final claim.

```bash
# AG-ORG-1
cd cliqhub-core && npm test; echo "BACKEND_EXIT:$?"

# AG-ORG-2
cd cliqhub-frontend && npm test; echo "SPA_EXIT:$?"

# AG-ORG-3
cd cliq-platform && npm test; echo "PLATFORM_EXIT:$?"   # or package scripts as configured for daemon/cli

# AG-ORG-4
cd cliqhub-bff && npm test; echo "BFF_UNIT_EXIT:$?"
cd cliqhub-bff && npm run test:e2e; echo "BFF_E2E_EXIT:$?"

# AG-ORG-5
# OpenAPI regen + docs review; push documentation; confirm not ahead of origin
```

#### B1. Core — unit / integration to add or extend

- Zod: `org_id` required; XOR refine for `get_details` / `deregister`; settings reject `name`.
- Controller/service: matrix in A1–A2 (supertest or existing agents test files).
- Route inventory: path is `get_details`, not `get_by_id`.
- Explicit test: `X-Org-Id` alone does not satisfy agents tenancy.

#### B2. SPA — unit

- Agents settings panel / realm agents: fetch mocks assert body `{ org_id, id }` and **no** `X-Org-Id` in headers.
- Install wizard / team detail: same for agents calls.
- Fail closed when `current_id` null (no agents request fired).

#### B3. Platform — unit + contract

- `AgentHubService` tests: bodies include `org_id`; `hub_headers` snapshot has no `x-org-id`.
- CLI login / settings: `hub.org_id` written (unit or integration).
- Grep-backed contract: every Hub `/v1/agents/` string in daemon/CLI updated.

#### B4. BFF — unit + Playwright

- Allowlist / route surface audit includes `get_details`.
- Any Playwright/agents fixture: body `org_id`; prefer no org header on agents.
- Passthrough does not inject `org_id`; optional strip test if implemented.

### C. Wire / contract proof (required before “done”)

Package green alone is insufficient (`endpoint-cli-contract-tests`).

| ID | Proof | Pass criteria |
|----|-------|---------------|
| **C1** | SPA manual or browser: Org Agents tab + open settings + save | Network: `POST …/agents/get_settings` & `update_settings` JSON has `org_id` + `id`; **no** `X-Org-Id` request header; UI saves |
| **C2** | Core curl/supertest: same path with header org only | **400** |
| **C3** | Act-as (if admin env): take over → Agents tab | Loads under target; wrong org → 403 |
| **C4** | Daemon: `hub.org_id` set → list/register or unregister smoke | EXIT 0 / success logs; Hub body has `org_id` |
| **C5** | CLI: login → read `hub.org_id`; `cliq agent unregister …` (or dry harness) | Setting present; Hub deregister body has `org_id` + name |

Record which proofs ran and `EXIT:$?` / success lines in the PR / session claim.

### D. Docs verification

- [ ] `scripts/generate_hub_openapi.py` (or project generator) regenerated; agents schemas show `org_id`, `get_details`, XOR, settings `id`.
- [ ] Mintlify MDX examples match Zod (no agents `X-Org-Id`).
- [ ] `documentation` pushed; not ahead of `origin` after push.

### E. Claim checklist (print before saying done)

```text
[ ] BACKEND_EXIT:0
[ ] SPA_EXIT:0
[ ] PLATFORM_EXIT:0
[ ] BFF_UNIT_EXIT:0
[ ] BFF_E2E_EXIT:0
[ ] C1–C5 contract proofs noted
[ ] Docs pushed (AG-ORG-5)
[ ] Caller inventory: every agents site cleaned
[ ] No AgentsController current_org_id / X-Org-Id read
[ ] Refactoring rules audited (hard-cut / MVC / hub-core-api-standards / contracts / docs)
```

---

## Coding standards

- [ ] **Refactoring rules** section above audited (hard-cut, MVC, Hub API standards, contract tests, verify gate, docs push)
- [ ] snake_case; early returns; no `any` / no `else` after return
- [ ] Zod `.describe` on `org_id` / `id` / XOR fields (inputs **and** response data touched)
- [ ] UUID `org_id` and catalog `id`
- [ ] No agents header tenancy; no `get_by_id` alias
- [ ] Every agents caller cleaned off `X-Org-Id` (inventory above)
- [ ] Docs regenerated and pushed
- [ ] Test plan A–E satisfied in the claiming turn
- [ ] Plan close-loop: every slice item done/pending resolved before next task

---

## Follow-up

| ID | Item |
|----|------|
| **RM-ORG-1** | Realms body `org_id` + drop header tenancy — see `SLICE-realms-explicit-org-id.md` |
| **HDR-1** | Drop `X-Org-Id` from Core / SPA `useOrgFetch` once all hard deps migrated |
| **SESS-1** | BFF session `active_org_id` for list filters only |
| **AG-SET-FK** | Settings tables key by `agent_id` UUID |

---

## Done definition

- **Refactoring rules** followed and audited (hard-cut, MVC, `hub-core-api-standards`, contracts, verify gate, docs).
- All agents routes require body `org_id` and run `assert_org_authorized` (PAT: ∈ `auth.org_ids`; daemon: realm org match).
- `get_by_id` removed; `get_details` live with shared XOR.
- Settings get (detail) / update by catalog **UUID** only.
- **Every** inventoried agents caller sends body `org_id` and does **not** use `X-Org-Id` for agents tenancy.
- **Test plan** sections A–E green in the claiming turn (full package suites + C1–C5 wire proofs + docs).
- OpenAPI/docs match Zod.
- No agents controller path reads `current_org_id` / `X-Org-Id`.
