# SLICE: Agents API `{ ok, data }` DTO hard-cut

**Status:** implemented (agents first)  
**Rule:** hard-cut only — **no** dual response shapes, no `{ ok, agents }` aliases.  
**Envelope:** every success is `OkResponse<T> = { ok: true, data: T }`.

---

## 1. Envelope + naming

| Rule | Detail |
|------|--------|
| Success | `{ ok: true, data: T }` via `BaseController.ok` |
| Error | `{ ok: false, error: { code, message } }` via `error_handler` |
| Types | PascalCase `type` (not interface); fields snake_case |
| Entity body | One `AgentData` for list **or** single — never `AgentGetData` / `AgentListData` |
| Array vs object | List → `data: AgentData[]`; one → `data: AgentData` |

Shared types live in `cliqhub-core/src/types/`:

- `api_response.ts` — `OkResponse<T>`, `ErrResponse`, `ApiResponse<T>`
- `dto.ts` — wire DTOs
- `vo.ts` — internal value objects
- `mappers.ts` — VO/row → DTO (`to_agent_data`)

---

## 2. Agent schemas + types (together, not inferred)

Same module owns **explicit** PascalCase types and Zod **request** schemas.
Response DTOs are written as `type` — not `z.infer`. Zod is for runtime
request validation only.

| Module | Types (explicit) | Zod (requests / optional parse) |
|--------|------------------|----------------------------------|
| `settings_schemas.ts` | `SettingDef`, `SettingsData` | `setting_def_schema`, `settings_data_schema` (`z.ZodType<…>`) |
| `agents_schemas.ts` | `AgentData`, `AgentsData` | `agents_*_input` |
| `api_response.ts` | `BooleanData`, `OkResponse<T>` | — |

```ts
export type AgentData = { id: string; name: string; … };

export type AgentsData =
  | AgentData | AgentData[]
  | SettingsData | SettingsData[]
  | BooleanData;

export const agents_register_input = z.object({ … }); // validate body only
```

---

## 3. Endpoint → `data` mapping (hard-cut)

| Method | Path | `data` | Notes |
|--------|------|--------|-------|
| POST | `/v1/agents/get` | `AgentData[]` | was `{ ok, agents }` |
| POST | `/v1/agents/get_by_id` | `AgentData` | was `{ ok, agent }` |
| POST | `/v1/agents/register` | `AgentData` | was `{ ok, agent, updated }`; **201** create / **200** force-update |
| POST | `/v1/agents/deregister` | `BooleanData` | was flat `{ ok, deregistered, removed_count }` |
| POST | `/v1/agents/get_settings` | `SettingsData` \| `SettingsData[]` | detail already used `data`; list was `{ ok, agents }` |
| POST | `/v1/agents/update_settings` | `BooleanData` | was flat `{ ok, applied }` |

Inputs stay Zod in `schemas/agents_schemas.ts` (request bodies only — no output Zod envelopes).

---

## 4. Controller consolidation (agents)

**One resource → one controller → one route file.**

```
routes/v1/agents.ts  →  AgentsController  →  AgentService
```

| Route method | Controller method |
|--------------|-------------------|
| `/agents/get` | `get` |
| `/agents/get_by_id` | `get_by_id` |
| `/agents/register` | `register` |
| `/agents/deregister` | `deregister` |
| `/agents/get_settings` | `get_settings` (name absent → list) |
| `/agents/update_settings` | `update_settings` |

Rules applied:

- Instance methods + `wrap` / `parse_body` / `ok` from `BaseController`
- Early returns only (no `else` after returnable branches)
- No business logic in the route file
- Deprecated alias `AgentController = AgentsController` only until call sites are gone

**No further agents split** (do not invent `/agents/settings/*` or separate settings controller).

---

## 5. Callers updated in this slice

| Caller | Change |
|--------|--------|
| Daemon `AgentHubService.list_registered` | `data` array of agents |
| Daemon `AgentHubService.register` | `updated` from HTTP 200 vs 201; errors from `error.message` |
| Daemon `AgentHubService.unregister` | `data.deregistered` / `data.removed_count` |
| Daemon `TeamService._check_unregistered_agents` | `data` array |
| SPA `install_team_wizard` | catalog from `data` |
| SPA `agents_settings_panel` / `realm_agent_settings_page` | list from `data` |
| SPA `team_detail_page` | registered names from `data` |

Detail `get_settings` / `update_settings` already used `data.*` in the SPA.

---

## 6. Broader controller consolidation map (next resources)

Same pattern after agents: **routes 1:1 with controller**, envelope `{ ok, data }`, one entity DTO (+ small apply/removal results).

| Resource | Controller today | Envelope status | Consolidation notes |
|----------|------------------|-----------------|---------------------|
| **agents** | `AgentsController` | **done** (envelope) | Explicit body `org_id` tenancy: `SLICE-agents-explicit-org-id.md` (branch `slice/agents-explicit-org-id`) |
| **notifications** | `NotificationsController` | **done (DTO envelope)** | Paths locked; `{ok,data}` — see `SLICE-notifications-api-dto-envelope.md` |
| reviews | `ReviewsController` | mostly `data` already | Flat paths locked in `SLICE-reviews-api-flat-hard-cut` |
| teams | `TeamsController` + `TeamsInstallController` | mixed | Keep install as sub-resource or fold into teams body — decide before coding |
| drafts | `DraftsController` | likely `data` | Align DTOs to PascalCase |
| users / orgs / scopes | respective controllers | mixed | Follow `api-consolidation-plan.md` paths |
| daemons | `DaemonsController` | flat `{ daemon }` | → `data: DaemonData` |
| realms | `RealmsController` + realm_* controllers | split across files | Candidate merge: realm team_list / a2a / dispatch_key into `RealmsController` **only if** still one resource |
| runs / events / logs | separate | mixed | Keep separate resources |
| auth / tokens | `AuthController` / `TokensController` | — | Tokens stay under users per consolidation plan |
| system / dashboard / telemetry | operational | ad-hoc ok fields | Lower priority |

**Do not** invent endpoints while migrating envelopes. Prefer consolidating response shapes first; path merges only when a locked slice says so.

---

## 7. Explicit non-goals

- Do **not** keep `{ ok, agents }` / `{ ok, agent, updated }` shims.
- Do **not** add `AgentListData` / `AgentGetByIdData` wrapper types.
- Do **not** put `updated: boolean` inside `AgentData` — use HTTP status on register.
- Do **not** invent per-endpoint `*ApplyResult` / `*RemovalResult` — use `BooleanData`.
- Do **not** change path names in this slice (already flat `/v1/agents/*`).
