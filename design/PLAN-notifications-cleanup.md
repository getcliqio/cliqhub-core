# Notifications API — Cleanup Plan

This plan covers three areas in sequence:
1. Rename two API paths for consistency
2. Add two missing safety checks (channel name uniqueness across scopes, rule channel ownership)
3. Fix internal code quality gaps in the controller and service

---

## Endpoints and Their Payloads

### Channels

---

**List channels** `POST /v1/notification_channels/get`

Request body:
```
org_id        UUID     Required when listing org-level channels (account = true or no realm_id)
realm_id      string   Optional — when set, lists channels for this realm instead
account       bool     Optional — default false; set to true to explicitly request org-level channels
                         (same effect as omitting realm_id)
enabled       bool     Optional — default false; when true, return only enabled channels
ids           string[] Optional — if set alongside enabled=true, checks these specific ids then
                         filters to the realm
query         string   Optional — substring filter on channel name
```

Response: array of channel objects:
```
id            UUID
realm_id      UUID | null    null means it belongs to the org, not a realm
org_id        UUID | null    set when realm_id is null
user_id       UUID | null    set for personal channels
name          string
destinations  Destination[]  typed array — same structure as the request (see type table above)
enabled       0 | 1
created_at    unix ms
updated_at    unix ms
rule_count    number         how many rules point at this channel
```

> **Note — current bug**: today `destinations` is returned as a serialized JSON string, not an array.
> The SPA works around this with a `parse_destinations()` helper that parses it back.
> Fixing this to a real typed array is part of this plan (see code quality gap #11).

Rules enforced:
- Account list requires `org_id` in body — caller must be a member of that org
- Realm list requires the caller to be a member of the realm

---

**Create channel** `POST /v1/notification_channels/create`

A **destination** is one delivery target for a notification. A channel can have multiple destinations so a single event can be sent to Slack AND email at the same time. Each destination has a fixed `type` value (not a free string) that determines what other fields are required.

Supported destination types:

| type          | Required fields                                 | Optional fields           |
|---------------|-------------------------------------------------|---------------------------|
| `slack`       | `webhook_url` (URL)                             |                           |
| `email`       | `address` (email string)                        | `cc`, `bcc`               |
| `webhook`     | `url` (URL)                                     | `headers` (key/value map) |
| `http`        | `url` (URL)                                     | `method` (POST/PUT), `headers` |
| `jira`        | `url`, `project_key`, `issue_type`              | `auth_header`             |
| `cliqhub`     | *(no extra fields)* — in-app notification only  |                           |
| `channel_ref` | `name` (name of another channel to forward to) |                           |

`channel_ref` lets you build a group channel that fans out to multiple other channels by name. The API prevents circular references (A → B → A).

Request body:
```
org_id        UUID    Required when creating an org-level channel
realm_id      string  Optional — when set, creates a realm channel instead
name          string  Required — must be unique within the scope (see rules below)
destinations  array   Required — at least one destination object (see type table above)
enabled       bool    Optional — default true (channel is enabled on creation)
```

Response: single channel object (same shape as above)

Rules enforced:
- Org channel: `org_id` required; caller must be org notification admin
- Realm channel: caller must be realm notification admin
- Name must be unique within the same scope (same realm or same org)
- **New rule**: if creating a realm channel and the org already has a channel with the same name, reject with the message: `"A channel named '{name}' already exists at the organization level in {org name}. Use the organization channel or choose a different name."`
- **New rule**: if creating an org channel and any realm in that org already has a channel with the same name, reject with the message: `"A channel named '{name}' already exists in realm '{realm name}'. Choose a different name or remove the realm channel first."`
- No circular channel references (channel A → channel B → channel A is not allowed)

---

**Update channel** `POST /v1/notification_channels/update`

Request body:
```
id            UUID    Required — channel to update
name          string  Optional — new name; must still be unique in scope if changed
destinations  array   Optional — when provided, replaces ALL existing destinations; must contain
                        at least one item (cannot pass an empty array); omit the field entirely
                        to leave destinations unchanged
enabled       bool    Optional — enable or disable
```

Response: updated channel object

Rules enforced:
- Caller must be admin of the channel's realm or org
- If name changes, the same cross-scope uniqueness rules apply as on create

---

**Delete channel** `POST /v1/notification_channels/remove`

Request body:
```
id   UUID   Required — channel to delete
```

Response: `{ result: true | false }`

Rules enforced:
- Caller must be admin of the channel's realm or org

---

**Test channel** `POST /v1/notification_channels/test`

Request body:
```
id                  UUID   Required — channel to fire a test through
destination_index   number Optional — if set, test only that one destination (0-based)
```

Response:
```
delivered   number    count of destinations that accepted the test
errors      string[]  per-destination error messages; empty when all succeeded
```

Rules enforced:
- Same write authorization as update

---

### Rules

Rules control which channel receives a notification for a given event. They can be set at the org level or the realm level. The most specific tier wins at delivery time.

---

**List rules** `POST /v1/orgs/get_notification_rules` or `POST /v1/realms/get_notification_rules`

Request body:
```
org_id     UUID   Required when listing org-level rules (no realm_id)
realm_id   string Optional — when set, lists realm rules instead
team_slug  string Optional — filter to team-scoped rules within a realm
effective  bool   Optional — when set with realm_id, merges org + realm tiers to show what actually fires
```

Response: array of rule objects:
```
id          UUID
realm_id    UUID | null    null for org-level rules
team_slug   string | null  null for rules not scoped to a team
event       string         exact event type, wildcard like run.*, or *
channel_id  UUID
priority    number
created_at  unix ms
updated_at  unix ms
tier        "global" | "realm"   only present when effective=true
```

Rules enforced:
- Realm list: caller must be a realm member
- Org list: caller must be a member of the org

---

**Create or update a rule** `POST /v1/orgs/set_notification_rules` or `POST /v1/realms/set_notification_rules`

> **Path rename**: was `set_notification_rule` (singular) — changing to `set_notification_rules` (plural) to match `get_notification_rules`.

Request body:
```
org_id      UUID   Required when setting an org-level rule
realm_id    string Optional — when set, creates/updates a realm rule
team_slug   string Optional — narrows the rule to a team within the realm
event       string Required — which event this rule covers (exact, wildcard, or *)
channel_id  UUID   Required — which channel to route to
priority    number Optional — tie-break within a tier (default 0)
```

Response: single rule object

Rules enforced:
- Realm rule: caller must be realm notification admin
- Org rule: caller must be org notification admin
- **New rule**: the `channel_id` must belong to the same org as the rule
  - For an org rule: the channel must have `realm_id = null` and the same `org_id`
  - For a realm rule: the channel must belong to the realm directly, or be an org-level channel from that realm's org — but never from a different org
  - If the channel does not pass this check: `"Channel '{id}' does not belong to this organization"`

---

**Delete a rule** `POST /v1/orgs/remove_notification_rules` or `POST /v1/realms/remove_notification_rules`

> **Path rename**: was `remove_notification_rule` (singular) — changing to `remove_notification_rules` (plural).

Request body:
```
id   UUID   Required — rule to delete
```

Response: `{ result: true | false }`

Rules enforced:
- Load the rule first, then authorize against its owning realm or org
- If not found, return false (idempotent)

---

### Inbox

**List in-app notifications** `POST /v1/notifications/get`

Request body:
```
org_id          UUID     Required — bounds which realms appear in the inbox
realm_id        UUID     Optional — legacy single-realm filter
realms          UUID[]   Optional — multi-realm filter
types           string[] Optional — filter by event type
severities      string[] Optional — filter by severity
teams           string[] Optional — filter by team slug
run_id          UUID     Optional — show only notifications for one run
phases          string[] Optional — filter by phase name
q               string   Optional — text search across title, message, event, team, run
since_ms        number   Optional — only rows after this time (unix ms)
until_ms        number   Optional — only rows before this time (unix ms)
initiated_by_me bool     Optional — only events for runs the caller started
limit           number   Optional — page size (default 50)
offset          number   Optional — page offset (default 0)
```

Response:
```
items    NotificationData[]
total    number
offset   number
limit    number
```

Rules enforced:
- Caller must be authenticated and a member of the requested org

---

## Code Quality Gaps to Fix

### 1. Duplicate org authorization check in 4 controllers

The 25-line `assert_org_authorized` method is copy-pasted identically into `NotificationsController`, `RunsController`, `DaemonsController`, and `AgentsController`.

**Fix**: move it to `BaseController` once so all four controllers inherit it.

---

### 2. `create_channel` duplicates the name-check logic

`create_channel` in the service has its own inline uniqueness check (lines 265-281). There is already a private method `assert_channel_name_available` that does the same thing. `create_channel` never calls it.

**Fix**: delete the inline block; call `assert_channel_name_available` instead.

---

### 3. `assert_channel_name_available` only checks within a scope, not across scopes

The method checks: "does this name already exist in this realm?" or "does this name already exist in this org?"
It does **not** check: "does an org-level channel with this name exist for the realm's org?" — and vice versa.

**Fix**: add two cross-scope queries:
- When creating a realm channel → also check the realm's org for an org-level channel with the same name
- When creating an org channel → also check all realms in that org for a realm-level channel with the same name

The `Org` model (in `src/db/models/org.ts`) provides `display_name` and `slug` for the error message.

---

### 4. `NotificationRule.findByPk` called directly in the controller

`rules_remove` does a database lookup (`NotificationRule.findByPk`) before calling the service. Controllers should not touch models directly.

**Fix**: add `NotificationService.get_rule(id)` that returns `NotificationRuleData | null`, and use it in the controller.

---

### 5. `Realm.findByPk` called directly in the controller

`rules_list` calls `Realm.findByPk(realm_id)` to get the org_id before passing it to `list_effective_rules`. That lookup belongs inside the service.

**Fix**: change `list_effective_rules(realm_id, org_id?)` to resolve the org itself when `org_id` is not provided, so the controller just calls `list_effective_rules(realm_id)`.

---

### 6. `list_rules` and `set_rule` return anonymous object types

Both methods have large inline return types like `Promise<Array<{ id: string; realm_id: string | null; ... }>>` instead of using the defined `NotificationRuleData` type.

**Fix**: change return types to `Promise<NotificationRuleData[]>` and `Promise<NotificationRuleData>` respectively.

---

### 7. Complex return type expression in `list_effective_rules`

The local array variable uses `ReturnType<typeof NotificationService.list_effective_rules> extends Promise<(infer T)[]> ? T : never` — this is TypeScript gymnastics to infer its own return type.

**Fix**: declare a named local type or inline using `NotificationRuleData & { tier: 'global' | 'realm' }`.

---

### 8. `to_channel_record` has three `any` casts

The method casts `row as any` three times to access `destinations_rows`, `org_id`, and `user_id` — these fields exist on the model but are not in the function's declared parameter type.

**Fix**: widen the parameter type to include those optional fields explicitly.

---

### 9. Duplicate JSDoc comment on `test_channel`

Lines 424–431 of the service have two `/** ... */` blocks before `test_channel`: the first is the old one (says "Returns counts of..."), and the second is the correct current one. Only one should exist.

**Fix**: remove the first (old) one.

---

### 11. `destinations` is returned as a JSON string instead of a typed array

The `ChannelRecord` type and `NotificationChannelData` Zod schema both declare `destinations` as `string`. The service builds this by calling `JSON.stringify(dest_rows.map(...))` before returning. The SPA then has to call `JSON.parse(ch.destinations)` via a `parse_destinations()` helper just to read it.

This means the response type is wrong — the field should be `Destination[]` where each element is a discriminated union on `type` (one of `slack | email | webhook | http | jira | cliqhub | channel_ref`).

Affected files:
- `src/services/notification.service.ts` — `ChannelRecord.destinations: string` → `Destination[]`; `to_channel_record()` returns the array directly instead of stringifying
- `src/schemas/notifications/data.ts` — `destinations: z.string()` → `z.array(destination_schema)`
- `src/services/notification.service.ts` — `find_channel_by_name` currently parses `target.destinations` as a string; must change once the record type changes
- `cliqhub-frontend/src/pages/account/notification_settings_page.tsx` — `ChannelRow.destinations: string` → `Destination[]`; `parse_destinations()` helper can be deleted; callers that call `parse_destinations(ch.destinations)` become `ch.destinations` directly
- `tests/migrated_platform/notification.service.test.ts` and `notification_channel_secret.test.ts` — remove `JSON.parse(record.destinations)` calls

---

### 10. Sequelize model has wrong unique index

`notification_channel.model.ts` declares `{ unique: true, fields: ['realm_id', 'name'] }`. The actual database has two partial indexes:
- `(realm_id, name) WHERE realm_id IS NOT NULL`
- `(org_id, name) WHERE realm_id IS NULL`

The model index does not match and does not cover the org-level uniqueness constraint.

**Fix**: replace the model index with two partial index definitions that match the database.

---

## Test Cases

### Path rename

- `POST /v1/orgs/set_notification_rules` → 200 (new path works)
- `POST /v1/realms/set_notification_rules` → 200 (new path works)
- `POST /v1/orgs/remove_notification_rules` → 200 (new path works)
- `POST /v1/realms/remove_notification_rules` → 200 (new path works)
- Route inventory test: all four singular path strings updated to plural

---

### Cross-scope channel name uniqueness

1. Org has a channel named "alerts". Creating a realm channel named "alerts" in any realm of that org → 409 conflict, message includes the org name.
2. A realm has a channel named "alerts". Creating an org-level channel named "alerts" for that org → 409 conflict, message includes the realm name.
3. Two different orgs can each have a channel named "alerts" — no conflict.
4. Two different realms in different orgs can each have a channel named "alerts" — no conflict.
5. Updating a channel's name to one that conflicts with an org-level channel → 409.
6. The org name and realm name in the error message come from `display_name` / `name` respectively (not the raw UUID).

---

### Rule channel ownership

7. Set an org rule where `channel_id` belongs to the same org → 200.
8. Set an org rule where `channel_id` belongs to a different org → 403, message: "Channel does not belong to this organization".
9. Set a realm rule where `channel_id` is a realm channel in the same realm → 200.
10. Set a realm rule where `channel_id` is an org-level channel from the same org as the realm → 200 (shared channels are allowed).
11. Set a realm rule where `channel_id` belongs to a completely different org → 403.

---

### Existing paths that must not regress

12. Create org channel with no `org_id` → 400.
13. Create channel with no `destinations` → 400.
14. Create channel with a name already taken in the same realm → 409.
15. Create channel with a name already taken in the same org → 409.
16. Delete a channel that does not exist → returns `false`, no error.
17. Delete a rule that does not exist → returns `false`, no error.
18. List effective rules: org-tier rules that are overridden by a realm rule do not appear in the effective list.
19. List effective rules: org-tier rules for events not overridden by the realm are included.

### `destinations` as typed array

20. Create channel → response `destinations` is an array, not a string.
21. Each item in the array has a `type` field equal to one of the known values (`slack`, `email`, `webhook`, `http`, `jira`, `cliqhub`, `channel_ref`). Passing an unknown type string → 400.
22. `slack` destination without `webhook_url` → 400.
23. `email` destination without `address` → 400.
24. `webhook` destination without `url` → 400.
25. Update channel with `destinations: []` (empty array) → 400 (at least one required).
26. Fetching a channel after update returns destinations as a correctly typed array with all fields present.

---

## Order of Work

1. **Path renames** — change the two singular paths to plural in: routes (realms.ts and orgs.ts), BFF passthrough list, SPA page, schema comments, route inventory test. No logic changes.

2. **`destinations` response type** — change `ChannelRecord` and `NotificationChannelData` from string to `Destination[]`; update `to_channel_record` to return the array; update `find_channel_by_name`; update the SPA interface and remove `parse_destinations()`; update the two test files.

3. **Cross-scope channel name check** — enhance `assert_channel_name_available`; remove the inline duplicate in `create_channel`; add `Org` import from `db/models`.

4. **Rule channel ownership check** — add channel lookup and org validation in `set_rule`.

5. **Controller and service cleanup** — lift `assert_org_authorized` to `BaseController`; add `get_rule(id)` service method; push Realm lookup into `list_effective_rules`; fix return types; fix `any` casts; fix duplicate JSDoc; fix model index.

6. **Run full test suites** across all changed packages.
