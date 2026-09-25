# SLICE: Agents explicit `org_id` (kill header tenancy)

**Status:** planned — implement on branch `slice/agents-explicit-org-id`  
**Location:** `cliqhub-core/design/` (Hub design SoT; legacy `cliqhub` monorepo retired)  
**Depends on:** `SLICE-agents-api-dto-envelope.md` (envelope `{ ok, data }` already done)  
**Rule:** hard-cut — **no** `X-Org-Id` fallback for agents; missing body `org_id` → **400**  
**No new endpoints.** Paths stay `POST /v1/agents/*`.

---

## Architecture answers

1. **Needed?** Yes — catalog/settings are org-owned; ambient `X-Org-Id` → `current_org_id` is the wrong channel (multi-org unsafe / opaque).
2. **Merged?** No new routes. One required body field on existing POSTs.
3. **Model?**  
   - **Identity:** `Authorization: Bearer cliq_tok_…` | `cliq_dt_…` only.  
   - **Tenancy:** explicit `org_id` in JSON body.  
   - **Authz:** token must be authorized for that `org_id` (PAT ∈ memberships; realm token → realm’s org).  
   - Client may *choose* `org_id` from SPA/CLI session context; Core never invents it.
4. **Hard-cut?** Yes — Core rejects missing/unauthorized `org_id`. No dual read of header for agents.

---

## Branching

| Repo | Branch |
|------|--------|
| `cliqhub-core` (design + Core) | `slice/agents-explicit-org-id` |
| `cliqhub-frontend` | `slice/agents-explicit-org-id` |
| `cliqhub-bff` | `slice/agents-explicit-org-id` |
| `cliq` / `cliq-platform` | `slice/agents-explicit-org-id` |
| `documentation` | `slice/agents-explicit-org-id` |

Land as sequenced PRs into each `main` (Core → callers → docs). Do not merge half the surface.

---

## Locked wire contract

### Request

Every agents body includes:

```ts
org_id: z.string().uuid().describe(
  'Organization that owns this catalog / settings scope. '
  + 'Caller must be authorized for this org via the Bearer credential.',
)
```

| Path | Required body | Optional |
|------|---------------|----------|
| `/v1/agents/get` | `org_id` | `query`, `names`, `agent_type`, `include_manifest` |
| `/v1/agents/get_by_id` | `org_id`, `name` | `version`, `include_manifest` |
| `/v1/agents/register` | `org_id`, `name`, `manifest` | `version`, `description`, `agent_type`, `force` |
| `/v1/agents/deregister` | `org_id`, `name` | `version` |
| `/v1/agents/get_settings` | `org_id` | `name`, `realm_id` |
| `/v1/agents/update_settings` | `org_id`, `name`, `settings` | `realm_id` |

`AgentsGetInput` is **no longer** a fully optional object — at minimum `{ org_id }` is required.

### Authz (controller)

After Bearer middleware has set `req.auth`:

1. Parse body (Zod).  
2. `assert_org_authorized(req.auth, body.org_id)`:  
   - PAT / session PAT: `body.org_id` ∈ `auth.org_ids` → else **403**.  
   - Realm token (`auth_via === 'daemon_token'`): load realm; `realm.org_id === body.org_id` (and token’s realm matches if `realm_id` also sent) → else **403**.  
3. If `realm_id` present on settings calls: load realm; `realm.org_id === body.org_id` → else **403**.  
4. Call service with `body.org_id` (same as today).

**Do not** read `req.user.current_org_id` / `X-Org-Id` in `AgentsController`. Delete `require_org_id(req)` header helper for agents.

### Response

Unchanged from envelope slice: `{ ok: true, data: T }` (`AgentData` / `AgentData[]` / `SettingsData` / `BooleanData`).

---

## MVC (unchanged layout)

```
routes/v1/agents.ts  →  AgentsController  →  AgentService
schemas/agents/inputs.ts   # add org_id to every *Input
schemas/agents/data.ts     # unchanged DTOs
```

- Routes: wire only.  
- Controller: parse → authz → service → `this.ok`. Early returns; typed; no `else` after return.  
- Service: already takes `org_id` — no signature change required beyond callers passing body org.  
- snake_case in new helpers / locals.

---

## Callers (hard-cut together)

### SPA (`cliqhub-frontend`)

| Call site | Change |
|-----------|--------|
| `agents_settings_panel` | Every `get_settings` / `update_settings` / list: `org_id: current_id` from `OrgProvider` (fail closed if no `current_id`) |
| `realm_agent_settings_page` | Same + existing `realm_id`; `org_id` from org context (must match realm’s org) |
| `install_team_wizard` / `team_detail_page` | `agents/get` + settings: pass `org_id` |

Stop relying on `useOrgFetch`’s `X-Org-Id` **for agents correctness** (header may remain temporarily for other APIs until a later slice).

### BFF (`cliqhub-bff`)

- Agents paths stay control-plane passthrough.  
- Forward JSON body unchanged.  
- **Do not** require BFF to inject `org_id`.  
- Passthrough comments: note agents require body `org_id`; header not used.  
- Tests: any agents fixture bodies gain `org_id`.

### CLI (`cliq-platform` / `cli`)

- If any Hub agents HTTP exists (today mostly via daemon): pass `org_id`.  
- Add durable setting **`hub.org_id`** (UUID) written at login / org switch (alongside `hub.session`).  
- `cliq login` / setup: persist default org (personal or sole membership; multi-org: first personal or prompt later — v1: personal org slug === username, else first `orgs[]` from session create).  
- Document: `hub.org_id` required for Hub agent register/list from CLI tooling.

### Daemon (`cliq-platform` / `daemon`)

| Call | Change |
|------|--------|
| `AgentHubService.list_registered` | Body `{ org_id, include_manifest: false }` |
| `register` / `deregister` | Include `org_id` |

**Source of `org_id` (locked):**

1. Daemon config **`hub.org_id`** (synced from CLI on login), else  
2. If enrolled: org of the enrolled realm (resolve once, cache in config), else  
3. Fail with a clear “set hub.org_id / re-login” error — **do not** call Hub without `org_id`.

Remove dependence on Core personal-org default via missing header.

### Docs (`documentation`)

- Regenerate Hub OpenAPI from Zod.  
- Update `hub-api` / agents MDX examples to include `org_id`.  
- Short note: multi-org clients must pass the org they intend; PAT alone does not select org on these routes.  
- Push `documentation` with the product change.

---

## Out of scope (this branch / slice)

- Global removal of `X-Org-Id` from Core middleware.  
- `realms/create` explicit `org_id` (follow-up **RM-ORG-1**, same branch name optional later).  
- Runs/daemons/reviews list filters (session active org later).  
- Auth controller DTO envelope slice.  
- Removing `X-Client` / CSRF headers.  
- New endpoints or path renames.

---

## Implementation plan (micro-slices)

| ID | Repo | Work | Verify |
|----|------|------|--------|
| **AG-ORG-0** | `cliqhub-core` | This design doc on branch under `design/` | Doc only |
| **AG-ORG-1** | `cliqhub-core` | Zod `org_id`; `assert_org_authorized`; remove agents header `require_org_id`; unit tests | `npm test` EXIT 0 |
| **AG-ORG-2** | `cliqhub-frontend` | All agents Hub calls send `org_id` | `npm test` EXIT 0 |
| **AG-ORG-3** | `cliq-platform` | `hub.org_id` + daemon `AgentHubService` bodies; CLI login writes org | unit + contract smoke |
| **AG-ORG-4** | `cliqhub-bff` | Fixture/comment/passthrough notes; e2e bodies if any | `npm test` + `npm run test:e2e` |
| **AG-ORG-5** | `documentation` | OpenAPI regen + MDX; push | docs ahead cleared |

**Merge order:** AG-ORG-1 → AG-ORG-2 + AG-ORG-3 (same release window) → AG-ORG-4 → AG-ORG-5.  
Deploy Core before or with SPA/daemon or agents calls 400.

### Contract proof (required)

- SPA: org Agents tab loads with network body containing `org_id`; settings save works.  
- Daemon: `list_registered` / register with `hub.org_id` set — EXIT 0 / success logs.  
- CLI: after login, `hub.org_id` present; any Hub agents path includes it.  
Print `EXIT:$?` per package before claiming done (`verify-before-claiming-fixed` + `endpoint-cli-contract-tests`).

---

## Coding standards checklist

- [ ] snake_case locals/functions  
- [ ] Controller early returns only  
- [ ] Zod `.describe` on `org_id`  
- [ ] No `any`; explicit types  
- [ ] No new endpoints / no header shims  
- [ ] UUID `org_id` (`z.string().uuid()`)  
- [ ] Docs regenerated and pushed with impact  

---

## Follow-up (not this slice)

| ID | Item |
|----|------|
| **RM-ORG-1** | `POST /v1/realms/create` required body `org_id` |
| **HDR-1** | Drop `X-Org-Id` from Core once all hard deps migrated |
| **SESS-1** | BFF session `active_org_id` for list filters only |

---

## Done definition

- All six `/v1/agents/*` require and authz-check `org_id`.  
- SPA, BFF (passthrough/tests), CLI (`hub.org_id`), daemon Hub agents calls green.  
- OpenAPI/docs match Zod.  
- No agents path reads `current_org_id` / `X-Org-Id`.
