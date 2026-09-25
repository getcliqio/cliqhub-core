# SLICE: Realms explicit `org_id` + drop header tenancy

**Status:** implemented — RM-0…RM-6 on `slice/realms-explicit-org-id` (commit/push + docs push when asked)  
**Location:** `cliqhub-core/design/`  
**Depends on:** agents org-id hard-cut pattern (`SLICE-agents-explicit-org-id.md`); existing realm API hard-cut (`DESIGN-realm-api-hard-cut.md`)  
**Rule:** hard-cut — Realms CRUD tenancy does **not** invent org from `X-Org-Id` / `current_org_id`  
**No new product resources.** No route renames. Notification rules under `/v1/realms/*` stay on NotificationsController (out of scope).

**GitNexus:** indexed `cliqhub-core`, `cliqhub-frontend`, `cliqhub-bff`, `cliq-platform`. Use `impact` / `query` before each micro-slice; re-`analyze --index-only` after Core lands. Route nodes / cross-repo FETCHES are **not** extracted for Express — complement with path-string inventory below.

---

## Refactoring rules (mandatory)

| Rule / SoT | What it forces on this slice |
|------------|------------------------------|
| **`architecture-endpoints-before-impl`** | No new realm paths; no aliases; no temporary dual header+body invent. |
| **Hard-cut (Hub API style)** | Create never invents org from header. Slug `get_by_id` never falls back to `current_org_id`. Header alone must not authorize create / slug resolve. |
| **`backend-mvc-layers`** | `routes → controllers → services → schemas`. Zod out of controller into `schemas/realms/`. Routes stay thin. |
| **`hub-core-api-standards`** | See **Code structure** below — instance `async` methods + `wrap`, no `static` handlers, no module-level functions, in-function comments, early returns / **no `else`**, Zod `.describe`, unit tests per changed method. Envelope stay **flat** `{ ok, realm }` this slice (**RM-ENV** later). |
| **`uuid-primary-keys`** | `org_id` / `realm_id` are UUID strings on the wire where they are ids (`z.string().uuid()` for `org_id`; keep existing `realm_id` string constraints unless already uuid-only). |
| **`endpoint-cli-contract-tests`** | Trace SPA + daemon enroll + CLI `realms/get` + BFF helpers; real wire bodies; Bearer; **cross-surface payload matrix** + C1–C5 proofs. Never Core-only. |
| **`verify-before-claiming-fixed`** | Full suites every changed package; print `EXIT:$?`; no e2e later. |
| **`docs-must-update-on-push`** | OpenAPI + `realms.mdx` / hub-api; push `documentation/`. |
| **Focused change** | Realms org-id / header cleanup + controller/schema structure + **route-file hygiene** (mesh out of `realms.ts`, delete dead team-list controller). No notifications hard-cut, no A2A merge, no mesh behavior change, no envelope migration. |
| **Plan close-loop** | Diff vs this doc → done/pending → finish → rule audit → green-gate. |

**Do not:**

- Leave Core requiring body `org_id` on create while SPA wizard still relies only on `X-Org-Id`.
- Keep `assert_realm_in_org(..., current_org_id)` as a soft gate.
- Leave `static async` handlers or module-level `assert_*` in `realms_controller.ts`.
- Ship org_id behavior without **unit** coverage for the changed handlers.
- Expand scope to `/v1/realms/*_notification_rule` or global `useOrgFetch` removal (**HDR-1**).
- Waive red tests.

---

## Architecture answers

1. **Needed?** Yes — `create` invents tenancy from ambient header today (multi-org-unsafe). Slug `get_by_id` falls back to `current_org_id`. Header gate on update/delete falsely couples “active org” to realm mutations the user already belongs to.
2. **Merged?** No new endpoints. Same surface; clearer body fields.
3. **Model?**
   - **Auth (who):** `Authorization: Bearer` only.
   - **Tenancy invent / filter / slug resolve:** explicit body `org_id` (or `org_slug` on slug path).
   - **Mutations keyed by `realm_id`:** authz = user may act on that realm (existing `RealmService` membership / role checks). **No** required body `org_id`; **no** header org match.
   - **List (`get`):** optional body `org_id` filter; omit = all orgs the user is in (unchanged semantics).
4. **Hard-cut?** Yes — delete `assert_realm_in_org` and create’s `user.current_org_id` invent. No header fallback for slug resolve.

### Controller / route consolidation (architecture)

Per `architecture-endpoints-before-impl` + `backend-mvc-layers`: **one route file per resource**, **one controller per resource** (tight sub-resource OK). Do **not** invent endpoints or merge unrelated surfaces into a mega-controller.

#### Inventory (today)

| Artifact | Mounted where | Resource? | Action this slice |
|----------|---------------|-----------|-------------------|
| `RealmController` | `routes/v1/realms.ts` → `/v1/realms/*` CRUD/members/teams | **Realms** | Refactor in place (structure + org_id) |
| `RealmA2aController` | same file → `/v1/realms/a2a`, `/mesh/adapters/list` | Realm **A2A** sub-resource | Keep **separate controller**; wire via instance+`wrap` if touched. Do **not** fold into CRUD controller |
| `NotificationsController` rules_* | same file → `/v1/realms/*_notification_rule` | **Notifications** (path under realms) | Keep handler on Notifications; **leave mounts** (URL locked). Do not merge into RealmController |
| `AccountMeshController` / `OrgMeshController` | **same file** → `/account/mesh/*`, `/orgs/mesh/*` | Account / Org mesh — **not Realms** | **Move out** of `realms.ts` (RM-0 routes hygiene) |
| `RealmDispatchKeyController` | `routes/v1/auth.ts` → `/auth/*_dispatch_*` | Auth / dispatch keys | **Stay under auth** (already correct) |
| `RealmTeamListController` | **nowhere** (HTTP team-list routes removed) | Dead | **Delete** orphan controller in RM-0 (service `RealmTeamListService` stays — used by `add_team`/`remove_team`) |

#### Locked decisions

| Question | Answer |
|----------|--------|
| Merge A2A into `RealmController`? | **No** — different service, action-dispatch admin; keep `realm_a2a_controller.ts` as tightly related sub-resource |
| Merge notification rules into `RealmController`? | **No** — Notifications resource; only path prefix is `/realms` |
| Move dispatch keys into `realms.ts`? | **No** — public contract is `/v1/auth/*` |
| One mega `realms.ts` for mesh+realms+notif? | **No** — split mis-mounted mesh out |
| New realm endpoints? | **No** |
| Delete dead `RealmTeamListController`? | **Yes** (RM-0) — routes already gone |

#### Target layout after RM-0

```
routes/v1/realms.ts          → RealmController + RealmA2aController (+ notif rule mounts only)
routes/v1/mesh.ts (or orgs)  → account/org mesh + adapters list  [moved from realms.ts]
routes/v1/auth.ts            → dispatch keys (unchanged)
controllers/realms_controller.ts
controllers/realm_a2a_controller.ts
controllers/realm_team_list_controller.ts  → DELETED
services/realm.service.ts / realm_team_list.service.ts / realm_a2a.service.ts  → keep separate
```

`/mesh/adapters/list` today is on `RealmA2aController` — when splitting routes, either keep adapters on a2a and register from `mesh.ts`/`realms.ts`, or leave adapters next to a2a mount. Prefer: **adapters list moves with mesh route assembler**; handler can stay on `RealmA2aController` or move to a mesh controller later (**not** required for org_id).

#### Explicitly out of this slice

- Rewriting notification URLs off `/v1/realms/*`
- Folding A2A actions into CRUD methods
- Renaming `/v1/auth/get_dispatch_public_key`
- Boiling `RealmA2aController` to BaseController unless org_id forces a touch (structure debt OK until then)

---

## Auth (locked)

```
Authorization: Bearer <token>
        ↓
auth middleware → req.auth / req.user (memberships live)
        ↓
┌─ create / get(filter) / get_by_id(slug)
│     body.org_id (or org_slug → org.id) is SoT
│     assert_org_authorized(auth, org_id)  // same pattern as AgentsController
│     never invent from X-Org-Id / current_org_id
│
└─ get_by_id(realm_id) / update / delete / members / teams / a2a
      body.realm_id is SoT
      load realm → service membership / role checks
      do NOT require body.org_id
      do NOT call assert_realm_in_org(header)
```

| Piece | Role |
|-------|------|
| `Authorization` | Who you are |
| `body.org_id` | Org for **create**, optional **get** filter, optional **slug get_by_id** (XOR `org_slug`) |
| `body.org_slug` | Alternate org key for slug `get_by_id` only |
| `body.realm_id` | Identity for load/mutate/members/teams/a2a |
| `auth.org_ids` / daemon realm.org | Authorization for body `org_id` when required |
| `X-Org-Id` / `current_org_id` | **Ignored** on `RealmController` |

Reuse / extract shared `assert_org_authorized` (agents already has a private method — prefer a small shared helper under `auth/` or `lib/` if both controllers need it; do not leave duplicate divergent copies long-term).

**SPA may still send `X-Org-Id` via `useOrgFetch`** for other resources; Core Realms must not read it. Prefer adding body `org_id` on create/list; do not require stripping the header on all SPA fetches this slice.

---

## Branching

| Repo | Branch |
|------|--------|
| `cliqhub-core` | `slice/realms-explicit-org-id` |
| `cliqhub-frontend` | `slice/realms-explicit-org-id` |
| `cliqhub-bff` | `slice/realms-explicit-org-id` |
| `cliq-platform` | `slice/realms-explicit-org-id` |
| `documentation` | `slice/realms-explicit-org-id` |

Core first (or same release window as SPA/daemon). Missing create `org_id` → **400** once Core lands.

---

## Locked wire contract

### Shared `org_id` field (when present)

```ts
org_id: z.string().uuid().describe(
  'Organization this call targets. Required on create; optional filter on get; '
  + 'required on get_by_id when resolving by slug without org_slug. '
  + 'Caller must be authorized for this org via the Bearer credential.',
)
```

### Per route

| Path | Body (locked) | `org_id` | Header / `current_org_id` |
|------|---------------|----------|---------------------------|
| **`POST /v1/realms/create`** | `{ org_id, slug, name }` | **Required** + `assert_org_authorized` | **Ignored** |
| **`POST /v1/realms/get`** | optional `{ slug?, query?, owned?, org_id?, limit?, offset?, sort_*? }` | Optional filter (unchanged) | **Ignored** (never default filter from header) |
| **`POST /v1/realms/get_by_id`** | `{ realm_id }` **XOR** `{ slug, org_id }` **XOR** `{ slug, org_slug }` | Required on slug paths; unused on `realm_id` path | **Ignored**; delete `assert_realm_in_org` |
| **`POST /v1/realms/update`** | `{ realm_id, name? }` | Not required | **Ignored**; membership via service |
| **`POST /v1/realms/delete`** | `{ realm_id }` | Not required | **Ignored** |
| **`…/get_members` / `add_member` / `remove_member`** | existing + `realm_id` | Not required | Already unused |
| **`…/add_team` / `remove_team`** | existing + `realm_id` | Not required | Already unused |
| **`…/a2a`** | existing + `realm_id` | Not required | Already unused |
| **`…/*_notification_rule`** | notifications Zod | **Out of scope** | Still NotificationsController |

### `get_by_id` XOR (locked)

Exactly one of:

1. `realm_id` present → load by id; service membership.
2. `slug` + `org_id` (UUID) → resolve org by id; `get_by_slug`.
3. `slug` + `org_slug` → resolve org by slug; `get_by_slug`.

Reject: slug alone; `realm_id` + slug; both `org_id` and `org_slug` without clear precedence — prefer **400** if both org keys set (hard-cut clarity).

### Response envelope (unchanged this slice)

| Shape | Keep |
|-------|------|
| create / get_by_id / update | `{ ok: true, realm }` (flat — **not** `{ ok, data }`) |
| get | `{ ok: true, realms, total }` |
| delete / some mutations | `{ ok: true }` (+ existing fields) |

BFF control-plane passthrough stays **flat Core shape**. Do not “fix” callers to unwrap `data` for realms in this slice.

---

## Cross-surface payload coordination (mandatory)

Payload SoT is Core Zod. **Every** daemon / CLI / BFF / SPA / docs / test site that builds a realms body must match the locked table **in the same release window**. Core-only merge is forbidden (`endpoint-cli-contract-tests`).

### Co-ship rule

```
RM-1/RM-2 Core lands
        ↓ same PR window / same merge train
RM-3 SPA + RM-4 platform + RM-5 BFF fixtures
        ↓
RM-6 docs OpenAPI + MDX (same session as I/O change)
```

| If you ship… | Without… | Breakage |
|--------------|----------|----------|
| Core create requires `org_id` | SPA wizard + BFF `api_create_realm` / notifications e2e | SPA/BFF create → **400** |
| Core slug get_by_id requires org key | Daemon `_resolve_realm_for_enroll` | Enroll bare slug → **400** |
| Docs still show `{ slug, name }` create | — | Operators copy broken curl |

### Before → after (breaking payload deltas)

| Call | Before (typical) | After (required) |
|------|------------------|------------------|
| create | `{ slug, name }` (+ `X-Org-Id` invent) | `{ org_id, slug, name }` |
| get | `{}` or filters; SPA may send `org_id` | Same; **optional** `org_id` filter — never invent from header |
| get_by_id id | `{ realm_id }` (+ optional header assert) | `{ realm_id }` only |
| get_by_id slug | `{ slug }` or `{ slug, org_slug? }` (+ header org fallback) | `{ slug, org_id }` **or** `{ slug, org_slug }` — **no** bare `{ slug }` |
| update / delete | `{ realm_id, … }` (+ header assert) | Same body; header ignored |

### Per-surface owner matrix

#### Core (`cliqhub-core`) — RM-0…RM-2

| Artifact | Payload duty |
|----------|----------------|
| `schemas/realms/inputs.ts` | SoT — `.describe` every field; OpenAPI reads this |
| `RealmController` | Parse → authz → service; never invent org from header |
| Unit `realms_controller_org_id.test.ts` | Assert 400/403/200 matrix on bodies |
| Integration / migrated create & get_by_id | Every `.send({…})` / `.post` create includes `org_id`; slug lookups include org key |
| Grep gate | No `current_org_id` invent in `realms_controller.ts` |

#### SPA (`cliqhub-frontend`) — RM-3

| Site | Endpoint | Body change |
|------|----------|-------------|
| `realm_wizard.tsx` `handle_create_realm` | create | Add `org_id: current_id`; fail closed if null |
| `realms_page.tsx` + `build_realms_get_body` | get | Keep/send `org_id`; **fix comment** (no header default) |
| `notifications_page`, `run_in_realm_dialog`, `install_to_realm_dialog`, `admin/realms_page` | get | Prefer `org_id` when org context exists |
| `realm_layout`, `realm_detail_page`, `realm_danger`, invite/legacy redirect | get_by_id / update / delete | Keep `realm_id`; if any slug path, add org key |
| SPA unit tests | create / get / delete | Assert create JSON includes `org_id`; fixtures updated |

Header: SPA may still attach `X-Org-Id` via `useOrgFetch` — **body is SoT**; do not rely on header for create/slug.

#### Daemon (`cliq-platform` daemon) — RM-4

| Site | Endpoint | Body change |
|------|----------|-------------|
| `_resolve_realm_for_enroll` | get_by_id | Bare slug → add `org_id` from `resolve_hub_org_id()` / `hub.org_id`; or use `org.slug` → `{ slug, org_slug }`. Assert request body in `auto_enroll.spec.ts` |
| `auto_enroll` | (caller) | No header today — must not start depending on `X-Org-Id` |
| `daemon.service` hub profile | get | `{}` remains valid (cross-org list); optional later filter by `hub.org_id` |
| Fixture `daemon/tests/fixtures/hub_bff/realms_get_by_id.passthrough.json` | docs/comment | Note slug+org if fixture used for request examples |

#### CLI (`cliq-platform` cli) — RM-4

| Site | Endpoint | Body change |
|------|----------|-------------|
| `hub_command._fetch_user_realms` | get | `{}` OK (list all); if filtered UX is desired, send `org_id` from login/`hub.org_id` |
| Any future create-realm CLI | create | Must send `org_id` when/if added — none today |

#### BFF (`cliqhub-bff`) — RM-5

| Site | Duty |
|------|------|
| `control_plane_routes.ts` | Paths unchanged; passthrough forwards **client body as-is** — do not strip `org_id`; do not inject org from session into body unless product already does (prefer client-supplied) |
| `e2e/helpers.ts` `api_create_realm` | **Must** pass `org_id` (from session/org fixture helper) |
| `e2e/notifications.spec.ts` create | Same — `org_id` in body |
| Other e2e using `api_create_realm` | Inherit helper fix |
| `hub_passthrough` unit | Keep asserting body forwarded (already has get + `org_id` case) |
| Allowlist / route audit | No path rename |

#### Documentation (`documentation`) — RM-6

| Site | Duty |
|------|------|
| Regenerate Hub OpenAPI from Core Zod | create required `org_id`; get_by_id XOR documented |
| `documentation/realms.mdx` | Table + curl: create with `org_id`; get_by_id arms |
| `documentation/hub-api.mdx` / Starlight `hub-api.md` | Replace `{ slug, name }` create; slug lookup requires org key |
| `cli.mdx` / `cli-reference.md` | get_by_id text: `{ org_slug, slug }` **or** `{ org_id, slug }` |
| Mintlify push | Same session as I/O change (`docs-must-update-on-push`) |

Auth note in docs: Bearer = who; body `org_id` = invent/filter/slug org; `X-Org-Id` not SoT for Realms.

#### Adjacent (not blocking merge; track)

| Package | Note |
|---------|------|
| `cliq-jira` `list_realms` → `realms/get` `{}` | Still valid; optional follow-up to pass org filter |
| `cliq-docker` / `fleet_smoke_*` `get_by_slug` | **Dead path** vs current Core — out of this slice; do not revive |

### Contract tests per surface (payload assertions)

| Surface | Must assert |
|---------|-------------|
| Core unit | create without `org_id` → 400; slug alone → 400; header-only create → 400 |
| SPA unit | wizard/create fetch body has `org_id` |
| Daemon unit | enroll fetch body has `org_id` or `org_slug` when slug resolve runs |
| BFF e2e | `api_create_realm` / notifications create succeed only with `org_id` |
| Docs | OpenAPI schema required fields match Zod; sample curls compile with new body |

### Grep gates before “done” (all repos)

```bash
# Create sites must not send only slug+name
rg -n "realms/create" cliqhub-frontend cliqhub-bff cliqhub-core/tests -g '*.ts' -g '*.tsx'

# Slug get_by_id must not send bare { slug }
rg -n "realms/get_by_id" cliq-platform cliqhub-frontend -g '*.ts' -g '*.tsx'

# Docs must not advertise create without org_id
rg -n "realms/create|/realms/create" documentation -g '*.mdx' -g '*.md'
```

Manually verify each hit’s JSON body against the locked table.

### Wire proofs (payload-focused)

| ID | Proof | Pass |
|----|-------|------|
| **C1** | SPA create realm | Request JSON has `org_id` + `slug` + `name`; **200** |
| **C2** | Core create header-only | **400** |
| **C3** | Daemon enroll bare slug + `hub.org_id` | Request JSON has `org_id` or `org_slug`; enroll succeeds |
| **C4** | BFF Playwright path using `api_create_realm` | Helper sends `org_id`; realm created |
| **C5** | Docs curl / OpenAPI | Matches Zod; no stale `{ slug, name }`-only create |

---

## Code structure (mandatory)

Mirror **`AgentsController`** / `hub-core-api-standards`. Today’s `realms_controller.ts` violates several of these — **RM-0** fixes structure (behavior unchanged); **RM-1/RM-2** layer org_id on that shape.

### Controller shape

| Rule | Locked target | Today (must leave) |
|------|---------------|--------------------|
| Extends `BaseController` | `export class RealmController extends BaseController` | Plain class, no base |
| **No `static` handlers** | Instance `async create(req, res)` etc. | `static async create(..., next)` |
| Wire with `wrap` | `router.post(..., auth, controller.wrap(controller.create))` | `RealmController.create` static ref |
| Construct once in routes | `const controller = new RealmController()` | Static binding |
| Injectable service (unit tests) | `constructor(service?: RealmService)` | Calls `RealmService.*` static-style |
| **No module-level functions** | `private assert_user` / `private assert_org_authorized` on the class | `function assert_user`, `async function assert_realm_in_org` |
| Early returns / **no `else`** | Guard then happy path | Mixed |
| Typed handlers | Prefer `ApiRequest` / Express types; JSDoc on each public method | Untyped `Request`/`Response`/`NextFunction` try/catch |
| Errors | Let `wrap` / BaseController handle — **no** per-method `try/catch { next(err) }` | Manual try/catch next |

**Response shape this slice:** keep flat `res.json({ ok: true, realm })` / `{ ok, realms, total }` (or a small private `ok_realm` helper on the class). Do **not** switch to `{ ok, data }` here (**RM-ENV**). Structure rewrite ≠ envelope migration.

**A2A controller:** keep as separate file (see consolidation). Instance/`wrap` only if that file is touched for org_id; do not fold A2A into CRUD in RM-0.

**Route file:** `realms.ts` must not register account/org mesh (move in RM-0). Notification rule mounts may remain (URL ownership).

### Async methods

- Every public handler is a real **`async` instance method** (not sync, not static, not arrow-assigned unless matching an existing BaseController pattern like Orgs — prefer named `async` methods like Agents).
- Services stay `async`/`await`; no Express `req`/`res` in services.
- Private helpers that hit DB (`assert_org_authorized`, org slug resolve) are **`private async`** instance methods.

### In-function comments (required)

JSDoc on the method is **not** enough (`hub-core-api-standards` § In-function comments).

Every public handler body must comment **each logical step** (why / invariant), e.g.:

```ts
async create(req, res): Promise<void> {
  // Zod SoT — org_id required; never invent from X-Org-Id.
  const body = this.parse_body(RealmCreateInput, req);
  // Bearer membership (or daemon realm org) must include body.org_id.
  await this.assert_org_authorized(this.auth_from(req), body.org_id);
  // Persist under explicit org; service returns the created realm DTO/row shape.
  const realm = await this._service.create(…);
  res.json({ ok: true, realm });
}
```

Rules: comment inside the function; prefer why over “call service”; keep comments current when logic changes.

### Schemas / MVC layout

| Today | Target |
|-------|--------|
| Zod inline in controller | `src/schemas/realms/inputs.ts` — PascalCase `RealmCreateInput`, `RealmGetInput`, `RealmGetByIdInput`, … with `.describe` on every field |
| Response DTOs | Optional this slice; flat JSON keys stay. Full `schemas/realms/data.ts` deferred to **RM-ENV** |
| Routes | Thin: construct controller, `wrap` each method; leave notification/mesh mounts |

### Unit tests (mandatory — gate)

`hub-core-api-standards`: every changed method needs **unit** coverage (happy + validation/authz failures).

| File (new/extend) | Covers |
|-------------------|--------|
| `tests/unit/controllers/realms_controller_org_id.test.ts` | RM-1/RM-2 tenancy: create missing `org_id` → 400; header-only → 400; wrong org → 403; happy create with body `org_id`; get_by_id slug alone → 400; slug+org_id / slug+org_slug happy; update/delete without header when member (mock service); Zod XOR rejects |
| `tests/unit/schemas/realms_inputs.test.ts` (optional if Zod cases live in controller test) | Create/get_by_id refine cases |
| Existing migrated/integration realm tests | Update bodies to send `org_id` where inventing; keep green |

Pattern: construct `new RealmController(mock_service)`, call handler directly or via `wrap`, assert status/body — same as `agents_controller_org_id.test.ts`.

**Do not** treat “integration e2e already hits create” as a substitute for controller unit tenancy tests.

---

## Organize (MVC) — RM-0 deliverable

RM-0 is **structure-only** (wire + Zod extract + instance controller). Behavior and payloads unchanged until RM-1.

Checklist for RM-0 done:

- [ ] `schemas/realms/inputs.ts` extracted (current field optionality — create still **without** required `org_id` until RM-1)
- [ ] `RealmController extends BaseController`; injectable `RealmService` (+ team list service if needed)
- [ ] All handlers instance `async`; routes use `controller.wrap(controller.*)`
- [ ] Module-level `assert_user` / `assert_realm_in_org` removed or moved to private methods (header assert may remain until RM-2 **as a private method**, then deleted)
- [ ] In-function comments on every public handler
- [ ] Early returns / no `else`
- [ ] **`realms.ts` only Realms (+ a2a + notif rule mounts)** — account/org mesh moved to mesh/orgs route file
- [ ] **`RealmTeamListController` deleted** (confirm no imports); `RealmTeamListService` retained
- [ ] A2A stays separate controller (not merged into CRUD)
- [ ] Unit smoke: controller instantiates; create/get still honor today’s contract
- [ ] `npm test` Core EXIT 0

---

## Caller inventory (must clean)

Canonical detail: **Cross-surface payload coordination** above. Summary:

| Package | Micro-slice | Critical payload sites |
|---------|-------------|------------------------|
| Core | RM-0…2 | Zod + controller + unit/integration creates & slug get_by_id |
| SPA | RM-3 | `realm_wizard` create; `realms_filters` comment; list callers; realm_id detail/danger |
| Daemon | RM-4 | `_resolve_realm_for_enroll` / `auto_enroll` + spec |
| CLI | RM-4 | `_fetch_user_realms` (`{}` OK); no create today |
| BFF | RM-5 | `api_create_realm`, `notifications.spec.ts` create; passthrough body as-is |
| Docs | RM-6 | OpenAPI + realms/hub-api/cli MDX |

GitNexus: `assert_realm_in_org` → get_by_id/update/delete; `_resolve_realm_for_enroll` → `auto_enroll` only. Complement with path-string grep (no cross-repo FETCHES).

**Do not** remove `useOrgFetch` globally (CRITICAL hub). Realms may keep sending `X-Org-Id`; Core ignores it for Realms tenancy.

---

## Out of scope

| ID | Item |
|----|------|
| **NTF-ORG** | `/v1/realms/*_notification_rule` + NotificationsController header tenancy |
| **HDR-1** | Delete `useOrgFetch` / Core `resolve_current_org_id` globally |
| **RM-ENV** | Realms envelope `{ ok, data }` migration |
| Mesh / account routes mounted in `realms.ts` | **Behavior** untouched; **mount location** fixed in RM-0 (move out) |
| Merge A2A / notifications / dispatch into one controller | Explicitly rejected — see consolidation |
| `cliq-jira` / dead `get_by_slug` callers | Adjacent; `realms/get {}` still valid; do not revive slug-only Hub routes |

---

## Micro-slices

Each micro-slice independently stable (standards + tests green) before the next. **Do not merge to main** until Core + SPA + platform co-shipped.

| ID | Scope | Deliverable | Gate before next |
|----|-------|-------------|------------------|
| **RM-0** | Core structure + route hygiene | Zod extract; `RealmController` → BaseController + instance `async` + `wrap`; **split mesh mounts out of `realms.ts`**; **delete dead `RealmTeamListController`**; keep A2A + notif mounts as decided above; behavior/payloads unchanged | Core `npm test` EXIT 0 + structure/consolidation audit |
| **RM-1** | Core create | Required body `org_id` + `assert_org_authorized`; unit file `realms_controller_org_id.test.ts` (create matrix) | Core tests green |
| **RM-2** | Core get_by_id / update / delete | Delete header `assert_realm_in_org`; slug XOR; extend unit tests (slug/update/delete matrix) | Core tests green |
| **RM-3** | SPA | Payload matrix: wizard create `org_id`; list callers; grep gate | SPA `npm test` EXIT 0 |
| **RM-4** | platform | Payload matrix: enroll get_by_id body; CLI get OK as `{}` | PLATFORM_EXIT 0 |
| **RM-5** | BFF | Payload matrix: `api_create_realm` + notifications e2e `org_id` | unit + e2e EXIT 0 |
| **RM-6** | docs | OpenAPI + MDX match Zod; push; no stale create curl | Docs not ahead of origin after push |

**Order:** RM-0 → RM-1 → RM-2 → **RM-3 + RM-4 + RM-5 in the same window as Core hard-cut** → RM-6 same session as I/O.

**Merge to main:** only when Core + SPA + platform + BFF payloads co-ship; never Core-only.

**GitNexus per slice:** before edit, `impact` on target symbols; after Core RM-0/1/2, re-index `cliqhub-core`; before claim, `detect_changes` on each repo + **payload grep gates**.

**Per-slice coding gate:** structure section + `hub-core-api-standards` + **cross-surface payload matrix** for that package.

---

## Test plan

Rules: `verify-before-claiming-fixed` + `endpoint-cli-contract-tests`.  
Done only when every suite for every changed package is exit 0 in the claiming turn. Print `EXIT:$?`.

### A. Tenancy / authz (Core)

| Case | Expect |
|------|--------|
| create without `org_id` | **400** |
| create with `org_id` + only `X-Org-Id` different | Uses **body**; **200** if authorized for body |
| create with `org_id` not in membership | **403** |
| get without `org_id` | **200** cross-org list (member realms) |
| get with `org_id` | Filtered to that org |
| get_by_id `{ realm_id }` without header | **200** if member (no assert_realm_in_org) |
| get_by_id `{ slug }` alone | **400** |
| get_by_id `{ slug, org_id }` | **200** when authorized + exists |
| get_by_id `{ slug, org_slug }` | **200** when authorized + exists |
| update/delete without header, member of realm’s org | **200** / soft-delete ok |
| update/delete non-member | **403** (service) |

### B. Automated suites

```bash
cd cliqhub-core && npm test; echo "BACKEND_EXIT:$?"
cd cliqhub-frontend && npm test; echo "SPA_EXIT:$?"
cd cliq-platform && npm test; echo "PLATFORM_EXIT:$?"
cd cliqhub-bff && npm test; echo "BFF_UNIT_EXIT:$?"
cd cliqhub-bff && npm run test:e2e; echo "BFF_E2E_EXIT:$?"
```

#### B1. Core — unit / integration

- **Unit (required):** `tests/unit/controllers/realms_controller_org_id.test.ts` — matrix in §A (create/get_by_id/update/delete tenancy); Zod XOR; header ignored.
- **Unit (RM-0):** controller constructs; wrapped handlers still honor pre–org_id contract until RM-1.
- Integration / migrated: create bodies include `org_id`; slug get_by_id includes `org_id` or `org_slug`.
- Explicit: `X-Org-Id` alone does not satisfy create / slug resolve.
- Grep gate: no `static async` in `realms_controller.ts`; no module-level `function assert_`.

### C. Wire / contract proofs

Use **C1–C5** from **Cross-surface payload coordination** (SPA create, Core header-only 400, daemon enroll body, BFF helper, docs).

### D. Docs

- [ ] OpenAPI regenerated; create shows required `org_id`; get_by_id documents XOR
- [ ] `realms.mdx` + hub-api + cli MDX examples updated (no `{ slug, name }`-only create)
- [ ] `documentation` pushed

### E. Claim checklist

```text
[ ] BACKEND_EXIT:0
[ ] SPA_EXIT:0
[ ] PLATFORM_EXIT:0
[ ] BFF_UNIT_EXIT:0
[ ] BFF_E2E_EXIT:0
[ ] C1–C5 payload proofs noted
[ ] Payload grep gates clean (create / get_by_id / docs)
[ ] Docs pushed (RM-6)
[ ] No RealmController current_org_id / X-Org-Id invent
[ ] No static handlers / no module-level assert_* in realms_controller
[ ] In-function comments on public handlers
[ ] realms_controller_org_id unit tests green
[ ] assert_realm_in_org (header) deleted
[ ] realms.ts mesh mounts moved out; RealmTeamListController deleted
[ ] A2A not merged into RealmController
[ ] Cross-surface matrix: Core+SPA+daemon+CLI+BFF+docs
[ ] Notification rules explicitly untouched
[ ] GitNexus re-index after Core; detect_changes reviewed
[ ] Refactoring rules + code structure audited
```

---

## Coding standards

- [ ] **Code structure** section audited (instance async + wrap, no static handlers, no module-level functions)
- [ ] **Cross-surface payload** matrix audited for every package touched
- [ ] In-function comments on every public `RealmController` handler
- [ ] Early returns; no `else` after returnable branch
- [ ] snake_case; no implicit `any`
- [ ] Zod in `schemas/realms/`; `.describe` on every input field
- [ ] UUID `org_id` on wire (RM-1+)
- [ ] Unit tests for every changed tenancy path (`realms_controller_org_id.test.ts`)
- [ ] Focused: no notifications / envelope / HDR-1 drive-bys
- [ ] Flat `{ ok, realm }` retained until **RM-ENV**

---

## Follow-up

| ID | Item |
|----|------|
| **NTF-ORG** | Notifications (incl. `/v1/realms/*_notification_rule`) body `org_id` |
| **HDR-1** | Drop `X-Org-Id` / `useOrgFetch` once all hard deps migrated |
| **RM-ENV** | Realms `{ ok, data }` envelope + `schemas/realms/data.ts` |
| **SESS-1** | BFF session `active_org_id` for list filters only |
| **JIRA-ORG** | Optional: `cliq-jira` realms/get filter by org |

---

## Done definition

- Refactoring rules + **code structure** + **cross-surface payload** audited.
- `RealmController`: `BaseController`, instance `async` + `wrap`, no static handlers, no module-level assert helpers, in-function comments.
- create requires body `org_id` + `assert_org_authorized`.
- Header `assert_realm_in_org` gone; slug get_by_id requires `org_id` XOR `org_slug`.
- **Every** surface in the owner matrix updated (SPA, daemon, CLI, BFF helpers, docs) — not Core alone.
- Unit tenancy tests + package suites + C1–C5 + grep gates green in claiming turn.
- Notification rules / global header removal / envelope migration explicitly not claimed.
