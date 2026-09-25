# SLICE: Notifications explicit `org_id` + drop header tenancy (NTF-ORG)

**Status:** implemented on branch `slice/notifications-explicit-org-id` (all Hub repos) — **not** merged to `main`  
**Validation note:** Zod / BaseController return **422** for missing/invalid body fields (accept 422 as the Hub SoT, same as Realms).  
**Location:** `cliqhub-core/design/`  
**Depends on:** Realms org-id hard-cut (`SLICE-realms-explicit-org-id.md`); agents org-id pattern; notifications flat-cut (`SLICE-notifications-api-flat-hard-cut.md`)  
**Rule:** hard-cut — account-scoped Notifications tenancy does **not** invent org from `X-Org-Id` / `current_org_id`  
**No new product resources.** No route renames. Envelope stays `{ ok, data }` (already on `BaseController`).

**Validation note:** Zod / BaseController return **422** for missing/invalid body fields (accept 422 as the Hub SoT, same as Realms).

**GitNexus:** indexed `cliqhub-core`, `cliqhub-frontend`, `cliqhub-bff`, `cliq-platform` (2026-09-25). Express **route nodes are not extracted** (`api_impact` on `/v1/notification_channels/create` → no routes). Handlers bound via `wrap` often show **0 graph callers** — treat impact as **lower-bound**; always complement with the path-string inventory below. Re-`analyze --index-only` after Core lands before claiming done.

| Symbol | Repo | Risk | Blast |
|--------|------|------|-------|
| `NotificationsController` | core | **HIGH** (lower-bound; BaseController interface) | route registrars; Controllers / V1 modules |
| `require_account_notification_admin` | core | **CRITICAL** | `channels_create/update/remove/test`, `rules_set` |
| `Rules_tab` | frontend | LOW | `account_page`, `realm_notifications_page` |
| `Channels_tab` | frontend | **HIGH** | `account_page`, settings page, `realm_channels_page` |
| Daemon Hub notification CRUD | platform | none | only `/v1/events/submit` fan-in — **no** channel/rule/inbox Hub callers |

---

## Refactoring rules (mandatory)

| Rule / SoT | What it forces on this slice |
|------------|------------------------------|
| **`architecture-endpoints-before-impl`** | No new notification paths; no aliases; no temporary dual header+body invent. |
| **Hard-cut (Hub API style)** | Account invent / list / set / inbox never invent org from header. Soft `assert_channel_in_org(header)` deleted. Header alone must not authorize account create/list/set/inbox. |
| **`backend-mvc-layers`** | `routes → controllers → services → schemas`. Zod stays in `schemas/notifications/`. Routes stay thin. |
| **`hub-core-api-standards`** | Already BaseController + wrap — keep. Instance `async` + `wrap`, in-function comments, early returns / **no `else`**, Zod `.describe`, unit tests per changed tenancy path. Envelope stay **`{ ok, data }`**. |
| **`uuid-primary-keys`** | `org_id` is UUID on the wire (`z.string().uuid()`). |
| **`endpoint-cli-contract-tests`** | Trace SPA + BFF e2e; real wire bodies; Bearer; **cross-surface payload matrix** + C1–C5. Never Core-only. Daemon has no Hub notification CRUD — grep must stay clean. |
| **`verify-before-claiming-fixed`** | Full suites every changed package; print `EXIT:$?`; no e2e later. |
| **`docs-must-update-on-push`** | OpenAPI + notification MDX; push `documentation/`. |
| **Focused change** | Notifications org-id / header cleanup + comments/tests. No runs/reviews/daemons tenancy, no HDR-1, no envelope migration. |
| **Plan close-loop** | Diff vs this doc → done/pending → finish → rule audit → green-gate. |

**Do not:**

- Leave Core requiring body `org_id` on account paths while SPA still relies only on `X-Org-Id`.
- Keep soft `assert_channel_in_org(..., current_org_id)` as a header gate.
- Ship org_id behavior without **unit** coverage for the changed handlers.
- Expand scope to global `useOrgFetch` removal (**HDR-1**).
- Fold notification rules into `RealmController`.
- Waive red tests.

---

## Architecture answers

1. **Needed?** Yes — account channel/rule invent and inbox org bound use ambient `current_org_id` today (multi-org-unsafe), same class of bug as Realms create.
2. **Merged?** No new endpoints. Same surface; clearer body fields.
3. **Model?**
   - **Auth (who):** `Authorization: Bearer` only.
   - **Account invent / list / set / inbox bound:** explicit body `org_id`.
   - **Realm-scoped channels/rules:** body `realm_id` (+ optional `team_slug`) is SoT — **no** required body `org_id` (mirror Realms mutations keyed by `realm_id`).
   - **Id-keyed channel mutate/test / rule remove:** load row → membership/authz. **No** soft header org match.
4. **Hard-cut?** Yes — delete invent from `req.user.current_org_id` on account branches; delete soft header gate on channel mutate. No header fallback for account invent.

### Controller / route consolidation (architecture)

Per `architecture-endpoints-before-impl` + `backend-mvc-layers`: **one route file per resource**, **one controller per resource** (tight sub-resource OK). Do **not** invent endpoints or merge unrelated surfaces into a mega-controller.

#### Inventory (today)

| Artifact | Mounted where | Resource? | Action this slice |
|----------|---------------|-----------|-------------------|
| `NotificationsController` | `routes/v1/notification_channels.ts` → `/v1/notification_channels/*` | **Notification channels** | Refactor in place (org_id hard-cut + comments) |
| same | `routes/v1/notifications.ts` → `/v1/notifications/get` | **In-app inbox** | Require body `org_id` |
| same | `routes/v1/orgs.ts` → `/v1/orgs/*_notification_rule` | **Org notification rules** | Require body `org_id` on list/set |
| same | `routes/v1/realms.ts` → `/v1/realms/*_notification_rule` | **Realm notification rules** (path under realms) | Keep handler on Notifications; **leave mounts** (URL locked). Realm body `realm_id` SoT — no required `org_id` |
| `notification_authz.ts` | called from controller | Authz helpers | Account admin takes **explicit** `org_id` (stop SoT from header) |
| `RealmController` | `routes/v1/realms.ts` CRUD | Realms | **Do not** fold notification rules into RealmController |

#### Locked decisions

| Question | Answer |
|----------|--------|
| Merge notification rules into `RealmController`? | **No** — Notifications resource; only path prefix is `/realms` |
| New notification endpoints? | **No** |
| Move `/v1/orgs/*_notification_rule` off orgs.ts? | **No** this slice — URL locked; handler stays Notifications |
| Require `org_id` on realm-scoped channel/rule bodies? | **No** — `realm_id` is SoT |
| Require `org_id` on channel update/remove/test by id? | **No** — load channel → authz; no header invent |
| Strip SPA `X-Org-Id` globally? | **No** — **HDR-1** later |
| Touch daemon event outbox? | **No** |

#### Target layout (unchanged mounts)

```
routes/v1/notification_channels.ts  → NotificationsController channels_*
routes/v1/notifications.ts          → NotificationsController inbox_get
routes/v1/orgs.ts                   → NotificationsController rules_* (org mounts)
routes/v1/realms.ts                 → RealmController + A2A + NotificationsController rules_* (realm mounts only)
controllers/notifications_controller.ts
schemas/notifications/inputs.ts     → Zod SoT
notifications/notification_authz.ts → explicit org_id for account admin
```

#### Explicitly out of this slice

- Rewriting notification URLs off `/v1/realms/*` or `/v1/orgs/*`
- Folding rules into RealmController / OrgsController
- Global header removal (**HDR-1**)
- Runs / reviews / daemons / dashboard / telemetry org invent
- Envelope migration away from `{ ok, data }`

---

## Auth (locked)

```
Authorization: Bearer <token>
        ↓
auth middleware → req.auth / req.user (memberships live)
        ↓
┌─ account channels get/create + org rules list/set + inbox_get
│     body.org_id required
│     assert_org_authorized(auth, org_id)  // same pattern as Agents / Realms
│     never invent from X-Org-Id / current_org_id
│
├─ realm channels get/create + realm rules list/set
│     body.realm_id is SoT (+ optional team_slug)
│     realm member / admin checks (existing)
│     do NOT require body.org_id
│
└─ channels update/remove/test + rules_remove
      body.id is SoT
      load channel/rule → authz on owning org/realm
      do NOT soft-gate on current_org_id / X-Org-Id
```

| Piece | Role |
|-------|------|
| `Authorization` | Who you are |
| `body.org_id` | Org for **account** channel get/create, **org** rules list/set, **inbox** bound |
| `body.realm_id` | Scope for realm channel/rule ops |
| `body.id` | Identity for channel mutate/test / rule remove |
| `auth.org_ids` | Authorization for body `org_id` when required |
| `X-Org-Id` / `current_org_id` | **Ignored** for Notifications invent / soft channel gate |

Reuse shared `assert_org_authorized` (agents / realms) — prefer one helper under `auth/` or `lib/`; do not leave divergent copies.

**SPA may still send `X-Org-Id` via `useOrgFetch`** for other resources; Core Notifications must not invent from it. Prefer adding body `org_id` on account/inbox calls; do not require stripping the header on all SPA fetches this slice.

---

## Branching

| Repo | Branch |
|------|--------|
| `cliqhub-core` | `slice/notifications-explicit-org-id` |
| `cliqhub-frontend` | `slice/notifications-explicit-org-id` |
| `cliqhub-bff` | `slice/notifications-explicit-org-id` |
| `cliq-platform` | `slice/notifications-explicit-org-id` (grep gate only; no Hub CRUD callers) |
| `documentation` | `slice/notifications-explicit-org-id` |

Core first (or same release window as SPA). Missing account/inbox `org_id` → **422** once Core lands.

---

## Locked wire contract

### Shared `org_id` field (when present)

```ts
org_id: z.string().uuid().describe(
  'Organization this call targets. Required for account-scoped channel/rule ops and inbox. '
  + 'Caller must be authorized for this org via the Bearer credential.',
)
```

### Per route

| Path | Controller method | Body (locked) | `org_id` | Header / `current_org_id` |
|------|-------------------|---------------|----------|---------------------------|
| **`POST /v1/notification_channels/get`** | `channels_get` | Account: `{ org_id, account?, enabled?, ids?, query? }` · Realm: `{ realm_id, … }` | **Required** when account mode | **Ignored** |
| **`POST /v1/notification_channels/create`** | `channels_create` | Account: `{ org_id, name, destinations, enabled? }` · Realm: `{ realm_id, name, destinations, enabled? }` | **Required** when no `realm_id` | **Ignored** |
| **`POST /v1/notification_channels/update`** | `channels_update` | `{ id, name?, destinations?, enabled? }` | Not required | Soft assert **deleted**; load-based authz |
| **`POST /v1/notification_channels/remove`** | `channels_remove` | `{ id }` | Not required | Soft assert **deleted** |
| **`POST /v1/notification_channels/test`** | `channels_test` | `{ id, destination_index? }` | Not required | Soft assert **deleted** |
| **`POST /v1/orgs/get_notification_rules`** | `rules_list` | `{ org_id, … }` | **Required** | **Ignored** |
| **`POST /v1/orgs/set_notification_rule`** | `rules_set` | `{ org_id, event, channel_id, priority? }` | **Required** | **Ignored** |
| **`POST /v1/orgs/remove_notification_rule`** | `rules_remove` | `{ id }` | Not required | Load rule → org authz |
| **`POST /v1/realms/get_notification_rules`** | `rules_list` | `{ realm_id, team_slug?, effective? }` | Not required | **Ignored** |
| **`POST /v1/realms/set_notification_rule`** | `rules_set` | `{ realm_id, event, channel_id, team_slug?, priority? }` | Not required | **Ignored** |
| **`POST /v1/realms/remove_notification_rule`** | `rules_remove` | `{ id }` | Not required | Load rule → realm/org authz |
| **`POST /v1/notifications/get`** | `inbox_get` | `{ org_id, limit?, offset?, filters… }` | **Required** | **Ignored** |

### Account vs realm XOR (channels get / create)

- Account mode: `account === true` **or** no `realm_id` → **`org_id` required**; reject if `realm_id` also set (existing refine).
- Realm mode: `realm_id` present → `org_id` not required (and should not invent account org).

### Response envelope (unchanged)

| Shape | Keep |
|-------|------|
| All notification handlers | `{ ok: true, data: T }` via `BaseController.ok` |

BFF control-plane passthrough stays Core envelope. Do not change unwrap semantics this slice.

---

## Cross-surface payload coordination (mandatory)

Payload SoT is Core Zod. **Every** SPA / BFF / docs / test site that builds a notifications body must match the locked table **in the same release window**. Core-only merge is forbidden (`endpoint-cli-contract-tests`).

### Co-ship rule

```
NTF-1/NTF-2 Core lands
        ↓ same PR window / same merge train
NTF-4 SPA + NTF-5 BFF fixtures/e2e
        ↓
NTF-6 docs OpenAPI + MDX (same session as I/O change)
```

| If you ship… | Without… | Breakage |
|--------------|----------|----------|
| Core account create requires `org_id` | SPA `Channels_tab` account branch | SPA create → **422** |
| Core inbox requires `org_id` | SPA inbox / badge / events | Badge + notifications page → **422** |
| Core org rules require `org_id` | SPA `Rules_tab` account | Account rules → **422** |
| Docs still show account create without `org_id` | — | Operators copy broken curl |

### Before → after (breaking payload deltas)

| Call | Before (typical) | After (required) |
|------|------------------|------------------|
| Account channel get | `{ account: true }` (+ `X-Org-Id` invent) | `{ org_id, account: true }` |
| Account channel create | `{ name, destinations }` (+ header invent) | `{ org_id, name, destinations }` |
| Org rules list | `{}` (+ header) | `{ org_id }` |
| Org rules set | `{ event, channel_id }` (+ header) | `{ org_id, event, channel_id }` |
| Inbox / badge / events | `{ limit, offset, … }` (+ header bound) | `{ org_id, limit, offset, … }` |
| Realm channel/rules | `{ realm_id, … }` | **Unchanged** (no required `org_id`) |
| Channel update/remove/test | `{ id }` (+ soft header match) | `{ id }` only; load-based authz |

### Per-surface owner matrix

#### Core (`cliqhub-core`) — NTF-1…NTF-3

| Artifact | Payload duty |
|----------|----------------|
| `schemas/notifications/inputs.ts` | SoT — add `org_id`; refinements; `.describe` every field; OpenAPI reads this |
| `NotificationsController` | Parse → authz → service; never invent org from header on account/inbox |
| `notification_authz.ts` | Account admin gate takes explicit `org_id` |
| Unit `notifications_controller_org_id.test.ts` | Assert 422/403/200 matrix on bodies |
| Integration / migrated `notification_authz.test.ts`, `notifications_list.test.ts` | Every account `.send({…})` includes `org_id` |
| Grep gate | No `current_org_id` invent in account invent / inbox paths; no soft header assert |

#### SPA (`cliqhub-frontend`) — NTF-4

| Site | Endpoint | Body change |
|------|----------|-------------|
| `notification_settings_page.tsx` `Channels_tab` (no `realm_id`) | channels get/create/update/remove/test | Account get/create: add `org_id: current_id`; fail closed if null |
| `notification_settings_page.tsx` `Rules_tab` (no `realm_id`) | orgs `*_notification_rule` | Add `org_id` on list/set |
| `realm_channels_page` / `realm_notifications_page` | realm-scoped | Keep `realm_id` only |
| `notifications_page.tsx` | `/v1/notifications/get` | Add `org_id` |
| `realm_notifications_inbox.tsx` | same | Add `org_id` (+ existing `realm_id` filter) |
| `lib/use_sidebar_badges.ts` | same | Add `org_id` |
| `events_page.tsx` | same | Add `org_id` |
| SPA unit tests | inbox / settings | Assert JSON includes `org_id` where required |

Header: SPA may still attach `X-Org-Id` via `useOrgFetch` — **body is SoT**; do not rely on header for account invent / inbox.

#### Daemon / CLI (`cliq-platform`) — no wire change

| Site | Note |
|------|------|
| `daemon/.../notification.service.ts` | Outbox → `/v1/events/submit` only — **out of scope** |
| Grep gate | No new `/v1/notification_channels` / `/v1/notifications/get` / `*_notification_rule` callers |

#### BFF (`cliqhub-bff`) — NTF-5

| Site | Duty |
|------|------|
| `control_plane_routes.ts` | Paths unchanged; passthrough forwards **client body as-is** — do not strip `org_id`; do not inject org from session into body |
| `e2e/notification_channels.spec.ts` | Account `/settings?tab=channels` flows; ensure org hydrated (`wait_for_active_org` pattern if needed) |
| `e2e/notifications.spec.ts` | Inbox POST succeeds with SPA-sent `org_id` |
| `hub_passthrough` unit | Keep asserting body forwarded |
| Allowlist / route audit | No path rename |
| Rebuild `dist/` | Before Playwright (runtime uses compiled output) |

#### Documentation (`documentation`) — NTF-6

| Site | Duty |
|------|------|
| Regenerate Hub OpenAPI from Core Zod | Account channel/rule + inbox require `org_id` |
| `documentation/hub-api/notification-channels.mdx` | Table + curl with `org_id` on account ops |
| `documentation/hub-api/notifications.mdx` | Inbox requires `org_id` |
| Org/realm OpenAPI tags for `*_notification_rule` | Org ops show required `org_id`; realm ops stay `realm_id` |
| Mintlify push | Same session as I/O change (`docs-must-update-on-push`) |

Auth note in docs: Bearer = who; body `org_id` = account invent / inbox bound; `X-Org-Id` not SoT for Notifications.

### Contract tests per surface (payload assertions)

| Surface | Must assert |
|---------|-------------|
| Core unit | Account create/get without `org_id` → **422**; inbox without `org_id` → **422**; header-only invent → **422**/noop (body required) |
| SPA unit | Account channel/rule + inbox fetch bodies have `org_id` |
| BFF e2e | Account channels + notifications paths exit 0 with hydrated org |
| Docs | OpenAPI required fields match Zod; sample curls compile with new body |
| Platform | Grep: no Hub notification CRUD callers introduced |

### Grep gates before “done” (all repos)

```bash
# Account invent sites must send org_id
rg -n "notification_channels/(create|get)|get_notification_rules|set_notification_rule|notifications/get" \
  cliqhub-frontend cliqhub-bff/e2e cliqhub-core/tests -g '*.ts' -g '*.tsx'

# Controller must not invent from current_org_id on account/inbox
rg -n "current_org_id" cliqhub-core/src/controllers/notifications_controller.ts

# Platform must stay free of Hub notification CRUD
rg -n "/v1/notification_channels|/v1/notifications/get|_notification_rule" cliq-platform -g '*.ts'

# Docs must not advertise account create / inbox without org_id
rg -n "notification_channels/create|notifications/get" documentation -g '*.mdx' -g '*.md' -g '*.yaml'
```

Manually verify each hit’s JSON body against the locked table.

### Wire proofs (payload-focused)

| ID | Proof | Pass |
|----|-------|------|
| **C1** | SPA account channel create | Request JSON has `org_id` + `name` + `destinations`; **200** |
| **C2** | Core account create header-only | **422** |
| **C3** | SPA inbox / sidebar badge | Request JSON has `org_id`; list succeeds |
| **C4** | BFF Playwright account channels + notifications | Exit **0** |
| **C5** | Docs curl / OpenAPI | Matches Zod; no stale account create / inbox without `org_id` |

---

## Code structure (mandatory)

`NotificationsController` already extends `BaseController` and uses instance `async` + `wrap` — **keep that**. This slice layers org_id hard-cut + comments + authz cleanup on that shape (unlike Realms RM-0 structure rewrite).

### Controller shape

| Rule | Locked target |
|------|---------------|
| Extends `BaseController` | Already true — keep |
| Instance `async` + `wrap` | Already true — keep |
| Early returns / **no `else`** | Guard then happy path |
| Typed handlers | Zod parse; JSDoc on each public method |
| Errors | Let `wrap` / BaseController handle |
| Soft header assert | **Delete** `assert_channel_in_org` soft gate |
| Account invent | Body `org_id` + `assert_org_authorized` only |

### In-function comments (required)

JSDoc on the method is **not** enough (`hub-core-api-standards` § In-function comments).

Every public handler body must comment **each logical step** (why / invariant), e.g.:

```ts
async channels_create(req, res): Promise<void> {
  // Zod SoT — account mode requires org_id; never invent from X-Org-Id.
  const body = this.parse_body(NotificationChannelsCreateInput, req);
  const realm_id = body.realm_id?.trim() || null;
  if (!realm_id) {
    // Account channel: body.org_id is invent SoT.
    await this.assert_org_authorized(this.auth_from(req), body.org_id);
  }
  // Persist under explicit org or realm; service returns channel DTO.
  const channel = await NotificationService.create_channel(…);
  this.ok(res, channel);
}
```

Rules: comment inside the function; prefer why over “call service”; keep comments current when logic changes.

### Schemas / MVC layout

| Layer | Path |
|-------|------|
| Zod inputs | `src/schemas/notifications/inputs.ts` |
| Response DTOs | `src/schemas/notifications/data.ts` (existing; no envelope change) |
| Routes | Thin: construct controller, `wrap` each method |
| Authz | `src/notifications/notification_authz.ts` — explicit `org_id` for account admin |

### Unit tests (mandatory — gate)

`hub-core-api-standards`: every changed tenancy path needs **unit** coverage (happy + validation/authz failures).

| File (new/extend) | Covers |
|-------------------|--------|
| `tests/unit/controllers/notifications_controller_org_id.test.ts` | Account create/get missing `org_id` → 422; header-only → 422; wrong org → 403; happy account create with body `org_id`; inbox missing `org_id` → 422; realm create with `realm_id` only still OK; update/remove by id without header when authorized (mock) |
| Existing migrated `notification_authz.test.ts` | Account create `.send` includes `org_id` |
| Existing `notifications_list.test.ts` | Inbox `.send` includes `org_id` |

Pattern: construct `new NotificationsController(...)`, call handler via `wrap`, assert status/body — same as `realms_controller_org_id.test.ts` / `agents_controller_org_id.test.ts`.

**Do not** treat “BFF e2e already hits channels” as a substitute for controller unit tenancy tests.

---

## Caller inventory (must clean)

Canonical detail: **Cross-surface payload coordination** above. Summary:

| Package | Micro-slice | Critical payload sites |
|---------|-------------|------------------------|
| Core | NTF-1…3 | Zod + controller + authz + unit/migrated account + inbox |
| SPA | NTF-4 | `Channels_tab` / `Rules_tab` account; inbox / badge / events |
| Daemon / CLI | — | **None** (grep gate) |
| BFF | NTF-5 | Passthrough body; account channels e2e; notifications e2e |
| Docs | NTF-6 | OpenAPI + notification MDX |

GitNexus: `require_account_notification_admin` → channels_create/update/remove/test + rules_set (**CRITICAL**). Complement with path-string grep (no cross-repo FETCHES for Express).

**Do not** remove `useOrgFetch` globally (CRITICAL hub). Notifications may keep sending `X-Org-Id`; Core ignores it for Notifications invent.

---

## Out of scope

| ID | Item |
|----|------|
| **HDR-1** | Delete `useOrgFetch` / Core `resolve_current_org_id` globally |
| **RUN-ORG / REV-ORG / …** | Runs, reviews, daemons, dashboard, telemetry header invent |
| Merge rules into RealmController | Explicitly rejected — see consolidation |
| Daemon `/v1/events/submit` | Fan-in only; not notification CRUD |
| Envelope change | Stay `{ ok, data }` |

---

## Micro-slices

Each micro-slice independently stable (standards + tests green) before the next. **Do not merge to main** until Core + SPA + BFF co-shipped.

| ID | Scope | Deliverable | Gate before next |
|----|-------|-------------|------------------|
| **NTF-0** | Design + branches | This doc finalized after review; `slice/notifications-explicit-org-id` on all Hub repos; GitNexus impact table pasted | Doc approved |
| **NTF-1** | Core Zod | `org_id` + account/inbox refinements on `schemas/notifications/inputs.ts` | Types compile |
| **NTF-2** | Core controller + authz | Hard-cut invent; delete soft `assert_channel_in_org`; explicit `org_id` in account admin; JSDoc + in-function comments | Grep gate clean on controller |
| **NTF-3** | Core unit + migrated | `notifications_controller_org_id.test.ts` + fix authz/list tests | Core `npm test` EXIT 0 |
| **NTF-4** | SPA | Payload matrix: account tabs + inbox/badge/events | SPA `npm test` EXIT 0 |
| **NTF-5** | BFF | Passthrough unchanged; e2e account channels + notifications; rebuild `dist/` | unit + e2e EXIT 0 |
| **NTF-6** | docs | OpenAPI + MDX match Zod; push | Docs not ahead of origin after push |

**Order:** NTF-0 → NTF-1 → NTF-2 → NTF-3 → **NTF-4 + NTF-5 in the same window as Core hard-cut** → NTF-6 same session as I/O.

**Merge to main:** only when Core + SPA + BFF payloads co-ship; never Core-only.

**GitNexus per slice:** before edit, `impact` on target symbols; after Core NTF-1/2/3, re-index `cliqhub-core`; before claim, `detect_changes` on each repo + **payload grep gates**.

**Per-slice coding gate:** structure section + `hub-core-api-standards` + **cross-surface payload matrix** for that package.

---

## Test plan

Rules: `verify-before-claiming-fixed` + `endpoint-cli-contract-tests`.  
Done only when every suite for every changed package is exit 0 in the claiming turn. Print `EXIT:$?`.

### A. Tenancy / authz (Core)

| Case | Expect |
|------|--------|
| Account channel create without `org_id` | **422** |
| Account channel create with `org_id` + only `X-Org-Id` different | Uses **body**; **200** if authorized for body |
| Account channel create with `org_id` not in membership | **403** |
| Account channel get without `org_id` | **422** |
| Realm channel create with `realm_id` only | **200** if realm admin (no `org_id` required) |
| Org rules list/set without `org_id` | **422** |
| Realm rules list/set with `realm_id` | **200** (no `org_id` required) |
| Inbox without `org_id` | **422** |
| Inbox with `org_id` | **200** bounded to that org |
| Channel update/remove/test without header, authorized for channel’s org/realm | **200** |
| Channel update/remove non-member | **403** |

### B. Automated suites

```bash
cd cliqhub-core && npm test; echo "BACKEND_EXIT:$?"
cd cliqhub-frontend && npm test; echo "SPA_EXIT:$?"
cd cliqhub-bff && npm test; echo "BFF_UNIT_EXIT:$?"
cd cliqhub-bff && npm run test:e2e; echo "BFF_E2E_EXIT:$?"
# Platform: grep gate only (no Hub notification CRUD). Optional:
# cd cliq-platform && npm test; echo "PLATFORM_EXIT:$?"
```

#### B1. Core — unit / integration

- **Unit (required):** `tests/unit/controllers/notifications_controller_org_id.test.ts` — matrix in §A.
- Migrated: account create + inbox bodies include `org_id`.
- Explicit: `X-Org-Id` alone does not satisfy account invent / inbox.
- Grep gate: no `current_org_id` invent on account/inbox paths; soft `assert_channel_in_org` deleted.

### C. Wire / contract proofs

Use **C1–C5** from **Cross-surface payload coordination**.

### D. Docs

- [x] OpenAPI regenerated; account channel/rule + inbox show required `org_id`
- [x] `notification-channels.mdx` + `notifications.mdx` examples updated
- [x] `documentation` pushed on branch `slice/notifications-explicit-org-id` (**not** `main` / Mintlify until merge)

### E. Claim checklist

```text
[x] BACKEND_EXIT:0
[x] SPA_EXIT:0
[x] BFF_UNIT_EXIT:0
[x] BFF_E2E_EXIT:0
[x] C1–C5 payload proofs noted (unit + e2e + OpenAPI/MDX)
[x] Payload grep gates clean (account invent / inbox / docs / platform)
[x] Docs pushed on slice branch (NTF-6) — Mintlify awaits merge to main
[x] No NotificationsController current_org_id invent on account/inbox
[x] Soft assert_channel_in_org (header) deleted
[x] In-function comments on public handlers
[x] notifications_controller_org_id unit tests green
[x] Cross-surface matrix: Core+SPA+BFF+docs (platform = grep only)
[x] Realm-scoped paths still realm_id SoT (no forced org_id)
[x] Notification rules not folded into RealmController
[x] GitNexus re-index after Core; detect_changes reviewed
[x] Refactoring rules + code structure audited
[x] Envelope { ok, data } retained
```

---

## Coding standards

- [ ] **Code structure** section audited (BaseController + wrap kept; hard-cut invent)
- [ ] **Cross-surface payload** matrix audited for every package touched
- [ ] In-function comments on every public `NotificationsController` handler
- [ ] Early returns; no `else` after returnable branch
- [ ] snake_case; no implicit `any`
- [ ] Zod in `schemas/notifications/`; `.describe` on every input field
- [ ] UUID `org_id` on wire
- [ ] Unit tests for every changed tenancy path (`notifications_controller_org_id.test.ts`)
- [ ] Focused: no HDR-1 / runs / envelope drive-bys

---

## Follow-up

| ID | Item |
|----|------|
| **HDR-1** | Drop `X-Org-Id` / `useOrgFetch` once all hard deps migrated |
| **RUN-ORG / REV-ORG / …** | Remaining header invent surfaces |
| **SESS-1** | BFF session `active_org_id` for list filters only (if still needed) |

---

## Done definition

- Refactoring rules + **code structure** + **cross-surface payload** audited.
- Account channel get/create, org rules list/set, and inbox require body `org_id` + `assert_org_authorized`.
- Soft header `assert_channel_in_org` gone; id-keyed mutate uses load-based authz.
- Realm-scoped paths remain `realm_id` SoT.
- **Every** surface in the owner matrix updated (SPA, BFF, docs) — not Core alone; platform grep clean.
- Unit tenancy tests + package suites + C1–C5 + grep gates green in claiming turn.
- Global header removal / other resources / envelope migration explicitly not claimed.
