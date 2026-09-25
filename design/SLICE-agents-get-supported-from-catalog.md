# Slice plan: Supported agents from `agent_catalog` → unified `/v1/agents/*` → retire registry + org/realms agent resources

**Program:** Hub agent configuration SoT  
**Repos:** cliqhub (primary), documentation, cliq-agents (publish already seeds catalog)  
**Depends on:** Hub `agent_catalog` populated with manifests+bundles (release CI `publish_pack_to_hub`)  
**Related design:** [DESIGN-settings-hierarchy.md](../../cliq-platform/design/DESIGN-settings-hierarchy.md) (later: generic settings tables)  
**Status:** implemented — R0–R9 complete (2026-09-18)  

---

## R0 decisions (locked 2026-09-18)

| ID | Decision |
|----|----------|
| R0.1 | Path `POST /v1/agents/get_supported` (not `/internal`). |
| R0.2 | Response agents include settings schema; **never** `bundle`. |
| R0.3 | Schema via `resolve_agent_settings(manifest)`. |
| R0.4 | Empty catalog ⇒ `agents: []`. |
| R0.5 | No separate agent_settings API — `settings` on `register` / `update` only. |
| R0.6 | `update` = update_agent; optional `realm_id` scopes settings; **partial** catalog update; settings-only via `id` **or** `name`. |
| R0.7 | Zod in `agents_schemas.ts` → OpenAPI/MDX co-shipped. |
| R0.8 | `/v1/org/agents/*` and `/v1/realms/agents/*` removed in R9. |
| R0.9 | `get` + `realm_id` ⇒ scoped config; `get` + `name` (no realm) ⇒ org detail; else catalog list. |

---

## Goal

1. **Delete** static `agent_registry.json` and `sync:agents`.  
2. **Supported-agent schema** comes **only** from `cliq.agent_catalog.manifest` via **`POST /v1/agents/get_supported`**.  
3. **One Agents surface** — no separate `agent_settings` / org-agents / realms-agents resources.  
4. **Mutations are create + update only:** `register` and `update` take a **combined payload** (catalog fields ± scoped `settings`). No per-key `set` / `remove` / `reset` HTTP verbs.  
5. Scope via optional **`realm_id`** on `get` / `register` / `update`.  
6. **Zod is SoT** — every contract change updates `agents_schemas.ts` **and** documentation OpenAPI/MDX in the same PR.  
7. After review gate: **remove `/v1/org/agents` and `/v1/realms/agents`**.  
8. End with architecture/design re-review + code review + full tests.

Non-goals: daemon local `cliq.agents`; agent-pack pull format; settings-hierarchy single-table (follow-on).

---

## Unified endpoint model (lock)

| Verb | Role |
|------|------|
| `get_supported` | Config **schema** from catalog (never `bundle`). No `realm_id`. |
| `get` | Read. No `realm_id` → catalog list. With `realm_id` (+ optional `name`) → scoped config view (values + inheritance). |
| `get_by_id` | Catalog entry by UUID only. |
| `register` | **Create** agent. Combined payload: catalog fields + optional `settings` (+ optional `realm_id` for where values land). |
| `update` | **Update agent** (this is “update_agent”). Combined payload: optional catalog fields + optional `settings` patch (+ optional `realm_id`). Replaces today’s org/realm `set`/`remove`/`reset`. |
| `deregister` | Soft-delete catalog entry. No settings side effects beyond existing team checks. |

**No** long-term endpoints named `agent_settings`, `set`, `remove`, `reset`, `/org/agents/*`, or `/realms/agents/*`.

### Combined create / update payload (Zod sketch)

Settings are **not** a separate resource — they are a field on the agent write body.

```ts
// Shared settings patch (org when realm_id omitted; realm when realm_id set)
agent_settings_patch_schema = z.object({
  /** Upsert map — keys must be allowed by get_supported / resolve_agent_settings. */
  values: z.record(z.string(), z.string()).optional(),
  /** Clear keys at this scope (org row delete, or realm override delete). */
  clear: z.array(z.string().min(1)).optional(),
  /**
   * Realm only: drop realm override so org value applies again.
   * Reject if realm_id absent.
   */
  reset_to_org: z.array(z.string().min(1)).optional(),
  /** Realm only: clear all realm overrides for this agent. */
  reset_all_to_org: z.boolean().optional(),
}).optional();

// POST /v1/agents/register  — create
agents_register_schema = z.object({
  name: z.string().min(1),
  manifest: manifest_input,
  version: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  agent_type: z.string().nullable().optional(),
  realm_id: z.string().min(1).optional(),  // scopes settings only
  settings: agent_settings_patch_schema,
});

// POST /v1/agents/update  — update_agent
agents_update_schema = z.object({
  id: z.string().min(1),                   // catalog UUID
  // Catalog fields optional (omit = leave unchanged; or keep full-replace if we must — lock in R0)
  manifest: manifest_input.optional(),
  version: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  agent_type: z.string().nullable().optional(),
  realm_id: z.string().min(1).optional(),  // scopes settings only
  settings: agent_settings_patch_schema,
});
```

**Semantics**

| Call | Effect |
|------|--------|
| `register` with catalog fields only | Create catalog row (today). |
| `register` + `settings.values` | Create catalog row **and** write org (or realm if `realm_id`) values. |
| `update` with catalog fields | Patch/replace catalog entry (R0: prefer **partial** catalog update when only some fields sent). |
| `update` + `settings` only | Settings-only write — **no** catalog change. This replaces org/realm `set`/`remove`/`reset`. |
| `update` + catalog + `settings` | One request updates both. |

```
  cliq-agents tag → agent_catalog
                         │
         ┌───────────────┼────────────────┐
         ▼               ▼                ▼
  get_supported        get (±realm_id)   agent-pack/pull
  (schema)             register/update   (daemon code)
                       (± settings)
         │               │
         └───────────────┴──→ SPA / install
```

---

## Current vs target

| Concern | Today | Target |
|---------|--------|--------|
| Pack / code | `agent_catalog` | unchanged |
| Config schema | `agent_registry.json` | `get_supported` |
| Org / realm values | `/org/agents/*`, `/realms/agents/*` (`set`/`remove`/`reset`) | `register` / **`update`** combined `settings` (+ `realm_id`) |
| “agent_settings” API | separate controllers | **gone** — only a Zod field on register/update |
| Contracts | scattered | Zod `agents_schemas.ts` → OpenAPI/MDX |

---

## Endpoint matrix (every surface)

| Endpoint | R-slice | Surfaces |
|----------|---------|----------|
| `POST /v1/agents/get_supported` | **R2** | Zod + Hub + BFF + OpenAPI/MDX + tests + SPA |
| `POST /v1/agents/get` (+ optional `realm_id`) | **R3**, **R5** | Zod extend; catalog vs scoped read; docs |
| `POST /v1/agents/get_by_id` | **R3** | Docs sync |
| `POST /v1/agents/register` (combined) | **R5** | Zod `settings` + `realm_id`; docs |
| `POST /v1/agents/update` (combined = update_agent) | **R5**, **R9** | Settings-only and catalog+settings; docs |
| `POST /v1/agents/deregister` | unchanged | Docs note |
| ~~`set` / `remove` / `reset*`~~ | **never ship** | Map old callers → `update.settings` |
| `POST /v1/org/agents/*` | **R4** alias → **R9 delete** | Proxies to register/update/get |
| `POST /v1/realms/agents/*` | **R5** alias → **R9 delete** | Proxies to get/update + `realm_id` |
| SPA | **R6** | Only get_supported / get / register / update |
| Docs + Zod | **R7** (+ every write slice) | Zod ↔ OpenAPI |
| Exit review | **R8** | Design + code + tests |
| Delete old resources + registry | **R9** | — |

---

## Documentation + Zod (every endpoint-touching slice)

Same PR must update:

1. **Hub Zod** — `agents_schemas.ts` (`agent_settings_patch_schema` nested under register/update).  
2. **OpenAPI** — `hub.yaml` + hub-by-tag; requestBody includes `settings` / `realm_id`.  
3. **hub-api MDX** — examples for settings-only `update`, create-with-settings, realm-scoped `update`.

| Checklist | Done when |
|-----------|-----------|
| Zod `.describe()` on `settings.*` and `realm_id` | Intent clear in schema |
| OpenAPI ≡ Zod field names/types | Zero drift |
| MDX examples cover create+settings and update+settings | Copy-paste works |
| No docs for a standalone “Agent settings” resource after R9 | Nav clean |

---

## R0 — Design lock

- [ ] **R0.1** `get_supported` path and no-bundle response.  
- [ ] **R0.2** Schema via `resolve_agent_settings(manifest)`.  
- [ ] **R0.3** **No separate agent_settings API** — only `settings` on `register` / `update`.  
- [ ] **R0.4** `update` = update_agent: catalog and/or settings in one payload.  
- [ ] **R0.5** `realm_id` scopes the `settings` (and scoped `get`); catalog identity always by `id`/`name`.  
- [ ] **R0.6** Catalog `update` semantics: **partial** when only some catalog fields sent (recommended) vs today’s full replace — **pick one**.  
- [ ] **R0.7** Zod → OpenAPI/MDX always co-shipped.  
- [ ] **R0.8** Compat aliases for org/realms agents until R9.  

**Exit R0:** decisions recorded; no code.

---

## R1 — Catalog → supported-agent projection (library)

| ID | Work | Surfaces | Testable outcome |
|----|------|----------|------------------|
| R1.1 | `supported_agents_from_catalog` | Hub | Unit; no bundle |
| R1.2 | `assert_setting_key` / apply settings patch helper | Hub | Used by register/update |
| R1.3 | Load active catalog rows | Hub | Integration |

---

## R2 — `POST /v1/agents/get_supported`

| ID | Work | Surfaces | Testable outcome |
|----|------|----------|------------------|
| R2.1 | Zod `agents_get_supported_schema` | schemas | 422 on bad body |
| R2.2 | Service + controller + route + BFF | Hub + BFF | List from catalog |
| R2.3 | OpenAPI + MDX from Zod | documentation | Match |
| R2.4 | Unit + e2e | Hub | Green |

---

## R3 — `get` / `get_by_id` clarity (+ Zod/docs)

| ID | Work | Surfaces | Testable outcome |
|----|------|----------|------------------|
| R3.1 | Docs: get vs get_supported; preview `realm_id` on get | documentation | Clear |
| R3.2 | Zod comments; no break catalog clients | Hub | Existing tests green |
| R3.3 | Inventory + OpenAPI | Hub + docs | Green |

---

## R4 — Org aliases off registry (still `/org/agents` temporarily)

| ID | Work | Surfaces | Testable outcome |
|----|------|----------|------------------|
| R4.1 | Org service reads schema from catalog (R1) | Hub | Green |
| R4.2 | Internally map org `set`/`remove` → same apply-patch helper as `update.settings` | Hub | One code path |
| R4.3 | Keep HTTP aliases until R9 | Hub | SPA OK |

---

## R5 — Combined `register` / `update` + fold realms into `get`/`update` + `realm_id`

**Main unification slice.**

| ID | Work | Surfaces | Testable outcome |
|----|------|----------|------------------|
| R5.1 | Zod: `agent_settings_patch_schema`; extend `agents_register_schema` + `agents_update_schema` | schemas | Parse tests |
| R5.2 | Zod: `agents_get_schema` + optional `realm_id` / `name` | schemas | Parse tests |
| R5.3 | `AgentService.register` / `update`: apply catalog write then settings patch (org or realm) | Hub | Unit + integration |
| R5.4 | Settings-only `update` (id + settings, no catalog fields) works | Hub | Replaces set/remove/reset |
| R5.5 | `get` + `realm_id` returns scoped detail (from RealmAgentController logic) | Hub | Parity |
| R5.6 | Realms/org old routes → thin proxies to register/update/get | Hub | Old e2e green |
| R5.7 | BFF allowlist unchanged for register/update/get (already present) | BFF | Audit green |
| R5.8 | **Docs:** OpenAPI/MDX for combined payloads; deprecate set/remove/reset and org/realms agents | documentation | Zod ≡ OpenAPI |
| R5.9 | Effective merge + install path | Hub | Install tests |

**Examples:**

```http
# Create agent + org defaults
POST /v1/agents/register
{
  "name": "jira",
  "manifest": { ... },
  "version": "1.2.0",
  "settings": { "values": { "base_url": "https://…", "api_token": "…" } }
}

# Settings-only update (org) — replaces POST /v1/org/agents/set
POST /v1/agents/update
{
  "id": "agt_…",
  "settings": { "values": { "api_token": "new" }, "clear": ["optional_key"] }
}

# Realm overrides — replaces /v1/realms/agents/set + reset
POST /v1/agents/update
{
  "id": "agt_…",
  "realm_id": "rlm_…",
  "settings": {
    "values": { "api_token": "realm-token" },
    "reset_to_org": ["base_url"]
  }
}

# Catalog + settings in one shot
POST /v1/agents/update
{
  "id": "agt_…",
  "description": "Jira Cloud",
  "realm_id": "rlm_…",
  "settings": { "values": { "api_token": "…" } }
}
```

**Green:** new paths covered; aliases pass; Zod + OpenAPI updated.

---

## R6 — SPA + e2e

| ID | Work | Surfaces | Testable outcome |
|----|------|----------|------------------|
| R6.1 | Account panel: `get_supported` + `agents/update` (settings only, no `realm_id`) | SPA | Green |
| R6.2 | Realm page: `agents/get` + `agents/update` with `realm_id` | SPA | Green |
| R6.3 | Install wizard: catalog `get`; completeness via supported + scoped get | SPA | Green |
| R6.4 | Drop calls to `/org/agents` and `/realms/agents` | SPA | e2e green |
| R6.5 | Hub e2e: get_supported → update(org settings) → update(realm settings) → install | Hub | Green |

---

## R7 — Docs + Zod/OpenAPI audit

| ID | Work | Surfaces | Testable outcome |
|----|------|----------|------------------|
| R7.1 | Agents overview: get_supported / get / **register+update combined** | documentation | One story |
| R7.2 | Diff every Zod field vs OpenAPI | documentation | Zero drift |
| R7.3 | Remove language about agent_settings resource / set/remove/reset | documentation | Gone |
| R7.4 | Kill registry / sync:agents mentions | cliqhub + docs | Gone |
| R7.5 | Regenerate nav | documentation | Green |

---

## R8 — Exit review gate

### R8.1 Architecture / design

- [x] No agent_settings resource — only `settings` on register/update.  
- [x] `realm_id` scopes get/settings correctly.  
- [x] Zod ↔ OpenAPI ↔ MDX aligned.  
- [x] Amendments logged.

### R8.2 Code review

- [x] No new `set`/`remove`/`reset` routes under `/v1/agents`.  
- [x] `agent_registry.json` deleted; no loaders remain.  
- [x] No bundle on get_supported.  

### R8.3 Test gate (unit/integration of touched surfaces — **not** full Playwright)

Confirm exit 0 on packages you changed. Do **not** block Done on e2e.

```bash
cd cliqhub/services/backend && npm test -- --run tests/unit/lib/supported_agents.test.ts tests/unit/services/org_agent_settings.test.ts tests/unit/core_api/platform_route_inventory.test.ts tests/migrated_platform/agent.service.test.ts
cd cliqhub/services/bff && npm test -- --run tests/unit/route_surface_audit.test.ts
# docs: generate_hub_openapi + sync_hub_api_nav
```

- [x] Backend unit + agent service integration green  
- [x] BFF allowlist audit green  
- [x] No SPA/BFF callers left on deleted org/realms agents paths  
- [x] Flow covered by unit/service: get_supported → update(settings) ± realm_id  

If e2e is run later and fails, fix failures — but slice Done does not wait on it.

---

## R9 — Remove `/v1/org/agents` + `/v1/realms/agents` + registry

| ID | Work | Surfaces | Testable outcome |
|----|------|----------|------------------|
| R9.1 | Delete old routes + BFF entries | Hub + BFF | 404 |
| R9.2 | SPA/tests only `get_supported` / `get` / `register` / `update` | SPA | No callers of deleted paths |
| R9.3 | Keep DB value tables | Hub | Install OK |
| R9.4 | Delete registry files + `sync:agents` | Hub | `rg` empty |
| R9.5 | Docs: only unified Agents; Zod/OpenAPI final | documentation | Clean |
| R9.6 | Unit/integration of touched surfaces + final review | touched pkgs | Sign-off (no e2e wait) |

---

## Order of work

```
R0 → R1 → R2 get_supported → R3 get clarity
  → R4 org aliases off registry
  → R5 combined register/update + realm_id on get/update
  → R6 SPA/e2e → R7 docs/Zod audit → R8 STOP
  → R9 delete old HTTP + registry + final review
```

---

## Test plan summary

| Layer | Cases |
|-------|--------|
| Unit | Projection; settings patch; register+settings; update settings-only; update catalog+settings; realm_id reset_to_org |
| Integration | Catalog seed → get_supported → update org → update realm → effective merge |
| E2E | Account + realm UIs use update only; install completeness |
| Docs | OpenAPI ≡ Zod; no org/realms agents or set/remove pages after R9 |

---

## Amendments

| Date | Change | Why |
|------|--------|-----|
| 2026-09-18 | Realm → `/v1/agents/*` + `realm_id`; Zod↔OpenAPI | API consistency |
| 2026-09-18 | No agent_settings resource; create/update combined `settings` payload | Single mutation model (`update` = update_agent) |
| 2026-09-18 | `update` accepts `name` for settings-only; `get`+`name` = org detail | SPA keys by agent name |
| 2026-09-18 | R0–R9 implemented | Program complete |

---

## Slice Done (program)

- [x] R0–R9 complete  
- [x] `agent_registry.json` gone  
- [x] `get_supported` live; Zod + docs updated  
- [x] `/v1/org/agents` and `/v1/realms/agents` removed  
- [x] Settings only via `register` / `update` combined payload (+ optional `realm_id`)  
- [x] No standalone set/remove/reset agent_settings API  
- [x] Zod ≡ OpenAPI/MDX (regenerated)  
- [x] Unit/integration confirmation: supported_agents, org settings, route inventory, agent.service, BFF allowlist audit — exit 0  
- [x] SPA call sites migrated off deleted paths (nothing left pointing at org/realms agents HTTP)  
