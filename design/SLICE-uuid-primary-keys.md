# Slice plan: UUID primary keys (no integer PKs)

**Program:** Hub data-model hygiene — all PKs → UUID  
**Repos:** cliqhub (primary), documentation OpenAPI, Cursor rule `uuid-primary-keys.mdc`  
**Status:** Planned (not started)  
**Depends on:** nothing blocked — schedule after current SoT cleanup quiet period  
**Rule:** `.cursor/rules/uuid-primary-keys.mdc` — **never** introduce integer/serial PKs again

---

## U0 decisions (locked)

| ID | Decision |
|----|----------|
| **U0.1** | **All entity PKs are UUID.** No `INTEGER`/`SERIAL`/`autoIncrement` PKs. Ever. |
| **U0.2** | **Expand → cutover → drop** per table. Never drop the old int PK until every child FK is remapped and app code reads UUID only. |
| **U0.3** | **One micro-slice = one root entity** (plus its immediate dependent FK columns for that cutover). Ship independently; suites green before unlocking the next. |
| **U0.4** | **API hard-cut per entity** when that slice cuts over: request/response `*_id` fields become UUID strings. No dual int\|uuid in public contracts after cutover. |
| **U0.5** | **DB technique (default):** (1) add `id_new UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE`, backfill; (2) add parallel `*_id_new UUID` on children, backfill via join; (3) add FKs/`UNIQUE` on new cols; (4) app switches; (5) drop old int FKs + old int PK; (6) rename `id_new`→`id`, `*_id_new`→`*_id`. Use transactions / locks appropriate to table size. |
| **U0.6** | **Composite membership tables** keep natural composite keys **after** their FK parts are UUID (no surrogate required). Integer parts must not remain. |
| **U0.7** | **Invitations:** after `account_invites` / `realm_invites` cutover, API field is `invitation_id` (UUID). **Keep** `get_by_token` / hashed email token as the capability secret unless a later invites slice explicitly decides UUID-in-URL replaces the token. |
| **U0.8** | **Control-plane entities already on TEXT/UUID** (realms, runs, reviews, agents, …) are out of scope except where they still store **integer `user_id` / `org_id` FKs** — those FKs remapped in the Users/Orgs slices. |
| **U0.9** | **Quality gate:** each micro-slice exits with backend (+ BFF/SPA if that entity’s public ids appear there) suites green; OpenAPI regenerated for changed surfaces; docs pushed when API shapes change. |

### Non-goals (this program)

Merging invite tables · changing invite token hashing · slug renames · plane moves (`/v1` vs `/internal`)

---

## Migration pattern (every entity slice)

```
A. Schema expand     — add UUID PK column (+ unique); nullable UUID FK cols on children
B. Backfill          — populate UUID PKs; join-backfill child FK cols; verify 1:1, no nulls
C. Constraints       — UNIQUE/NOT NULL/FK on new cols (old ints still PK)
D. App cutover       — models, services, Zod, OpenAPI, SPA: UUID only for this entity
E. Schema contract   — drop old int FKs → drop old int PK → rename UUID cols to final names
F. Verify            — FK graph intact; no int id left for this entity in API or models
```

Do **not** skip E until D is green in prod/staging (or local full suite for this repo).

---

## Dependency order (must not reorder)

```
users ──┬──► api_tokens.user_id, drafts, audit_log.admin_id, *agent_settings.user_id,
        │    account/realm_invites.invited_by|accepted_user_id, teams.author_id,
        │    scopes.owner_id, org_members.user_id, scope_members.user_id,
        │    control-plane rows that store integer user_id
        │
        ├──► orgs ──┬──► org_roles, org_members, org_agent_settings, account_invites,
        │           │    scopes.org_id, orgs.default_scope_id (after scopes)
        │           └──► any API org_id
        │
        └──► scopes ──► scope_members, teams (via scope slug today; team_id int),
                        orgs.default_scope_id cutover

teams ──► team_versions, team_tags, download_log

org_roles (after orgs)
invites (after users+orgs; realm_invites after users only for user FKs)
notification_* / custom_events (leaf)
```

**Circular:** `orgs.default_scope_id` ↔ `scopes.org_id`  
→ Migrate **orgs PK** and **scopes PK** with **temporary dual FKs**; cut over `default_scope_id` only in the **Scopes** slice (or a tiny **U4b** bridge slice after both UUID columns exist).

---

## Micro-slices (sequenced)

Work **top to bottom**. Do not start `Un+1` until `Un` exit checks pass.

### U0 — Lock + inventory

| Sub | Work | Exit |
|-----|------|------|
| **U0.a** | Cursor rule `uuid-primary-keys.mdc` alwaysApply | Rule present |
| **U0.b** | This SLICE as SoT; inventory table below matches models | Doc = code inventory |
| **U0.c** | Shared migration notes (gen_random_uuid, naming `id_new` / cutover) | Authors can copy pattern |

**U0 done when:** rule + this plan committed; no schema change yet.

---

### U1 — Users

| Sub | Work | Exit |
|-----|------|------|
| **U1.1** | Expand `users.id_new`; backfill | Every user has UUID |
| **U1.2** | Expand child `user_id_new` / `admin_id_new` / `owner_id_new` / `invited_by_new` / `accepted_user_id_new` / `author_id_new` on all tables that FK to users (incl. control-plane if int) | Joins 100% |
| **U1.3** | App cutover: `User.id` UUID; auth context; Zod `user_id` | No int user id in APIs |
| **U1.4** | Contract: drop old int user FKs + `users.id`; rename | Models/DB clean |

**Children touched in U1 expand (FK remap only; those tables’ own PKs stay until their slice):**  
`api_tokens`, `drafts`, `audit_log`, `org_members`, `scope_members`, `scopes.owner_id`, `teams.author_id`, `account_invites`, `realm_invites`, `account_agent_settings`, `realm_agent_settings` (db), control-plane int `user_id` columns.

**U1 done when:** user PKs UUID; all user FKs UUID; suites green.

---

### U2 — Organizations

| Sub | Work | Exit |
|-----|------|------|
| **U2.1** | Expand `orgs.id_new`; backfill | |
| **U2.2** | Expand `org_id_new` on: `org_roles`, `org_members`, `org_agent_settings`, `account_invites`, `scopes`, (leave `default_scope_id` int until U3/U4b) | |
| **U2.3** | App cutover `org_id` → UUID | |
| **U2.4** | Contract orgs PK + org FKs (except `default_scope_id` if still int) | |

**U2 done when:** org PKs UUID; org-scoped APIs use UUID.

---

### U3 — Scopes

| Sub | Work | Exit |
|-----|------|------|
| **U3.1** | Expand `scopes.id_new`; backfill | |
| **U3.2** | Expand `scope_id_new` on `scope_members`; `default_scope_id_new` on `orgs` | |
| **U3.3** | App cutover scope ids | |
| **U3.4** | Contract scopes PK + FKs including `orgs.default_scope_id` | |

**U3 done when:** no integer scope ids; org↔scope cycle resolved on UUID.

---

### U4 — Org roles

| Sub | Work | Exit |
|-----|------|------|
| **U4.1–U4.4** | Expand/cutover/contract `org_roles.id`; remap `org_members.role_id` | Role ids UUID in API |

---

### U5 — Org members / scope members (composites)

| Sub | Work | Exit |
|-----|------|------|
| **U5.1** | Ensure composite PKs are `(org_id UUID, user_id UUID)` / `(scope_id UUID, user_id UUID)` only — drop any leftover int columns | Membership tables clean |

(Mostly verification if U1–U4 already remapped FKs; dedicate a slice so nothing is skipped.)

---

### U6 — Teams

| Sub | Work | Exit |
|-----|------|------|
| **U6.1–U6.4** | `teams` PK → UUID; expand `team_id_new` on `team_versions`, `team_tags`, `download_log` | |

---

### U7 — Team versions

| Sub | Work | Exit |
|-----|------|------|
| **U7.1–U7.4** | `team_versions.id` → UUID; update any APIs that expose version row id | |

---

### U8 — Team tags + download_log

| Sub | Work | Exit |
|-----|------|------|
| **U8.1** | `team_tags` composite uses UUID `team_id` | |
| **U8.2** | `download_log.team_id` UUID (still no surrogate PK unless we add UUID later) | |

---

### U9 — Drafts

| Sub | Work | Exit |
|-----|------|------|
| **U9.1–U9.4** | `drafts.id` → UUID; BFF/SPA draft ids | |

---

### U10 — Account invitations

| Sub | Work | Exit |
|-----|------|------|
| **U10.1–U10.4** | `account_invites.id` → UUID; API `invitation_id`; manage paths use UUID | Token accept unchanged |
| **U10.5** | Docs + OpenAPI invitations | |

---

### U11 — Realm invitations

| Sub | Work | Exit |
|-----|------|------|
| **U11.1–U11.4** | `realm_invites.id` → UUID; same API `invitation_id` | Token accept unchanged |

---

### U12 — Audit log

| Sub | Work | Exit |
|-----|------|------|
| **U12.1–U12.4** | `audit_log.id` → UUID | |

---

### U13 — Agent settings composites

| Sub | Work | Exit |
|-----|------|------|
| **U13.1** | `org_agent_settings` / `account_agent_settings` / db `realm_agent_settings` — UUID FK parts only | Align with core_api `realm_agent_setting` UUID id model if dual exists |

---

### U14 — Notification rules / subscriptions / custom events

| Sub | Work | Exit |
|-----|------|------|
| **U14.1** | `notification_rules.id` → UUID | |
| **U14.2** | `notification_subscriptions.id` → UUID | |
| **U14.3** | `custom_events.id` → UUID | |

---

## U16 — Remint deterministic legacy UUIDs → random

| Sub | Work | Exit |
|-----|------|------|
| **U16.1** | Boot migrator `migrate_hub_remint_legacy_uuids`: remap `00000000-0000-4000-8000-*` PKs to `gen_random_uuid()`, cascade FKs in public/cliq/bff | Zero legacy-pattern Hub entity ids remain |
| **U16.2** | Convert Hub-owned SERIAL PKs (`notification_rules`, `notification_subscriptions`, `custom_events`, `model_pricing`, …) → UUID | No int PKs on those tables |
| **U16.3** | Fixture `HUB_UUID.*` uses non-legacy fixed UUIDs (tests never reintroduce remint targets) | Suites green |

**Deferred (cliq-store):** `run_logs`, `team_run_events`, `run_artifacts` still INTEGER in `@getcliqio/cliq-store` — convert in a coordinated store release.

**Still intentional opaque TEXT (not uuid type):** `tokens.id`, `settings.key`, realm/run/review/agent slug-or-hash ids, composite natural keys.

---

### U15 — Sweep + freeze

| Sub | Work | Exit |
|-----|------|------|
| **U15.1** | Repo-wide grep: no `autoIncrement: true` PK; no `DataTypes.INTEGER` PK (except deferred store tables) | Zero Hub-owned hits |
| **U15.2** | OpenAPI + Mintlify: all `*_id` string/uuid | Docs pushed |
| **U15.3** | Amend permissions / design notes if any still say integer ids | |

**Program done when:** U15 green and rule prevents regressions.

---


---

## Inventory — integer PKs today (must migrate)

| # | Entity | Table | Slice |
|---|--------|-------|-------|
| 1 | User | `users` | U1 |
| 2 | Organization | `orgs` | U2 |
| 3 | Scope | `scopes` | U3 |
| 4 | Org role | `org_roles` | U4 |
| 5 | Team | `teams` | U6 |
| 6 | Team version | `team_versions` | U7 |
| 7 | Draft | `drafts` | U9 |
| 8 | Account invite | `account_invites` | U10 |
| 9 | Realm invite | `realm_invites` | U11 |
| 10 | Audit log | `audit_log` | U12 |
| 11 | Notification rule | `notification_rules` | U14 |
| 12 | Notification subscription | `notification_subscriptions` | U14 |
| 13 | Custom event | `custom_events` | U14 |

**Composite / FK-only (no own int surrogate, but int parts today):**  
`org_members`, `scope_members`, `team_tags`, `org_agent_settings`, `account_agent_settings`, `realm_agent_settings` (db), `download_log` → slices U5 / U8 / U13.

**Already non-integer PK (verify FKs only):** realms, realm_members, agents, api_tokens (PK TEXT; `user_id` int until U1), reviews, notifications channels, dispatch, runs, etc.

---

## Per-slice checklist (copy into PR)

- [ ] Expand migration applied + backfill verified  
- [ ] Child FK UUID columns backfilled + constrained  
- [ ] App/models/Zod/OpenAPI cut over for this entity  
- [ ] Contract migration dropped ints; renamed UUID → final  
- [ ] Backend tests green (`BACKEND_EXIT:0`)  
- [ ] BFF/SPA tests if ids surface there  
- [ ] Docs regenerated/pushed if public API changed  
- [ ] Next slice still locked until this one exits  

---

## Suggested first implementation PR

**U0 only** (rule + this doc) → then **U1 Users** as the first schema PR (largest rake; unblocks everything).
