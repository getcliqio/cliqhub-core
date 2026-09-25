# DESIGN: HUG Review — User Context & Targeted Notifications

> **Status:** Proposed
> **Date:** 2026-09-07
> **Repos:** `cliqhub` (backend, BFF, frontend), `cliq` (daemon, SDK, agents/hug)

## Problem

HUG reviews are anonymous and unguarded. The system was originally built without
user identity on reviews, resulting in several gaps:

1. **No reviewer assignment.** Reviews broadcast to the entire realm. Any realm
   member can stumble upon a review and submit a verdict. There is no concept of
   "this review is for you."

2. **No access control on detail/verdict.** `/reviews/get` and `/reviews/verdict`
   are ID-gated only — any authenticated user who knows the `review_id` can read
   and decide. The existing `reviews.view` and `reviews.verdict` permissions are
   defined but not wired into any controller.

3. **No per-user notifications.** Notification channels belong to realms or orgs.
   The only auto-provisioned channel is a shared per-realm `cliqhub` in-app
   channel. There is no way to notify a specific user.

4. **`review.reviewers` declared but never used.** The HUG agent manifest
   declares a `reviewers` settings key, but `ReviewConfig` in the agent code
   does not include it, `create_review()` does not send it, and the Hub does not
   store or enforce it.

5. **`reviewer_name` is free-text.** The only record of who decided a review is
   a manually-typed string in the verdict JSONB. No user ID, no auth validation.

6. **`realm_id` on the review is redundant.** The realm is reachable through
   `run_id → run.realm_id`. With org-scoped reviewer assignment, storing
   `realm_id` directly on the review adds no value.

7. **A HUG gate with no reviewers is semantically broken.** A gate without a
   gatekeeper means the review floats until anyone (or no one) acts on it.

## Design Principles

- **Reviewers are explicit.** Every HUG gate must declare who reviews.
- **Teams are portable.** Reviewer declarations use parameterized inputs, not
  hardcoded user IDs. Resolution happens at the realm/org level.
- **Channels are the notification medium.** Reviewer strings resolve to channels
  (which define how to notify — Slack, email, in-app, etc.). The review system
  does not invent its own notification path.
- **Org is the people scope.** The reviewer pool is the org, not the realm.
  Realms are execution environments; orgs are where people and roles live.
- **Inbox is the primary discovery path.** HUG reviews produce notifications
  that land in the user's org-scoped inbox. Each notification includes a link
  to the review detail page. The dedicated HUG page (`/hug`) is a UX
  optimization — a filtered view that watches the inbox for review-related
  notifications and provides quick access. The system must work without it:
  if the `/hug` nav link were removed, users would discover reviews through
  their general notification inbox and click through to the review detail.
- **System events are separate.** `hug.*` events are a system observability
  concern. Review-targeted notifications are a review concern. They are
  independent.

## Architecture

### Review Lifecycle (Revised)

```
Team YAML declares:
    review:
      reviewers:
        - policy: any
          channels: ["$(inputs.reviewers)"]
        - policy: all
          channels: ["$(inputs.approvers)"]

At dispatch:
    inputs.reviewers = ["elan", "ops-lead"]     ← selected via UI picker
    inputs.approvers = ["compliance", "legal"]  ← selected via UI picker

HUG agent reads resolved reviewer groups, sends to Hub:
    POST /v1/reviews/create { ..., reviewers: [
        { policy: "any", channels: ["elan", "ops-lead"] },
        { policy: "all", channels: ["compliance", "legal"] }
    ] }

Hub resolves each string against the org:
    "elan"     → org member → user_id 42  → review_notifications row
    "ops-lead" → channel name             → notification delivered

Hub stores:
    review_notifications row per destination (with user_id for user targets)

Hub delivers notifications:
    For each reviewer string:
      - If it resolves to a user → deliver to that user's personal channel
      - If it resolves to a channel → deliver via that channel's medium

On verdict:
    review_notifications row updated: responded_by = auth.user_id, action, responded_at
```

### Reviewer Resolution

Reviewer strings from inputs are resolved against the org context:

| String         | Resolution                                    | Result                          |
|----------------|-----------------------------------------------|---------------------------------|
| `"elan"`       | Matches org member username                   | user_id → `review_notifications` row + deliver to personal channel |
| `"ops-slack"`  | No username match → matches channel name      | Deliver via that channel (Slack, email, etc.)         |
| `"nobody"`     | No username match, no channel match           | Warning logged, skipped         |

Resolution order: org member usernames take precedence over channel names.
If a string matches a username, it resolves to that user (and their personal
channel). Channel name lookup only applies to strings that did not match any
username.

### Per-User Channel (Foundational)

Every user gets a personal in-app notification channel, auto-created on signup:

- **ID:** `user-{user_id}`
- **Provider:** `cliqhub`
- **Scope:** Org-level (no `realm_id`)
- **Destinations:** `[{ "type": "cliqhub" }]`

This is not HUG-specific — it's foundational infrastructure for any feature
that needs to reach a specific user (task assignments, mentions, DMs, etc.).
HUG is the first consumer.

### Unified Input Syntax

Today there are two different input schemas:

- **Team-level inputs** (provided at dispatch): `{ name, required }` — no type,
  no label, no help, no defaults. Stored in `capability_json.inputs`.
- **HUG review inputs** (filled by reviewer): `{ name, type, label, required,
  help, default, choices, placeholder }`. Full `InputFieldSpec`.

These are unified into a single `InputFieldSpec` used everywhere:

```typescript
interface InputFieldSpec {
    name: string;
    label?: string;
    type?: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'channel';
    required?: boolean;
    help?: string;
    default?: unknown;
    choices?: string[];
    placeholder?: string;
}
```

`type: channel` is inherently multi-value — the picker always allows selecting
one or more users/channels. The resolved value is an array of strings. Template
expansion flattens the array into the parent list:

```yaml
review:
  reviewers:
    - policy: any
      channels: ["$(inputs.reviewers)"]
      # If inputs.reviewers = ["elan", "ops-slack"]
      # resolves to: ["elan", "ops-slack"]
```

Literal and parameterized values can be mixed within a group:

```yaml
review:
  reviewers:
    - policy: all
      channels: ["$(inputs.reviewers)", "compliance"]
      # resolves to: ["elan", "ops-slack", "compliance"]
```

Multiple groups compose AND/OR policies:

```yaml
review:
  reviewers:
    - policy: any
      channels: ["$(inputs.quick_reviewers)"]
      # ANY one of these must approve
    - policy: all
      channels: ["compliance", "legal"]
      # ALL of these must approve
  # Review is decided when BOTH groups are satisfied
```

Team-level inputs adopt the full spec. The YAML top-level `inputs:` block uses
the same syntax as `review.inputs`:

```yaml
inputs:
  - name: reviewers
    type: channel
    required: true
    label: "Reviewers"
  - name: environment
    type: select
    required: true
    choices: ["staging", "production"]
    default: staging
  - name: notes
    type: textarea
    label: "Run notes"
```

This means:
- The dispatch dialog renders proper typed fields (not just bare text boxes)
- `capability_json.inputs` stores the full `InputFieldSpec` array
- One shared component renders inputs everywhere — dispatch dialog, review
  detail page, realm run panel
- `type: channel` renders a searchable multi-select picker populated from org
  members and configured notification channels

When `type` is omitted, it defaults to `text` (backward compatible with
existing team inputs that only have `name` and `required`).

### Portable Team Best Practice

```yaml
name: my-pipeline
inputs:
  - name: reviewers
    type: channel
    required: true
    label: "Reviewers"
  - name: approvers
    type: channel
    required: false
    label: "Required approvers (all must sign off)"

phases:
  - name: build
    type: standard
    agent: exec
    commands:
      - run: echo "building..."

  - name: approve
    type: gate
    agent: hug
    depends_on: [build]
    review:
      reviewers:
        - policy: any
          channels: ["$(inputs.reviewers)"]
        - policy: all
          channels: ["$(inputs.approvers)"]
      timeout: 60
```

The team is portable — it doesn't know who the reviewers are. The dispatching
user selects them via the picker at runtime. Different orgs/realms can have
entirely different reviewer pools. The two-group structure lets the author
express "any engineer can approve, but compliance and legal must both sign off."

### More Examples

**Simple — one reviewer, first to approve wins:**
```yaml
review:
  reviewers:
    - policy: any
      channels: ["$(inputs.reviewer)"]
  timeout: 60
```

**Multiple reviewers, any one is enough:**
```yaml
review:
  reviewers:
    - policy: any
      channels: ["$(inputs.reviewers)"]
  timeout: 60
```
Dispatching user picks `["elan", "alice", "bob"]`. First response decides.

**All must approve:**
```yaml
review:
  reviewers:
    - policy: all
      channels: ["$(inputs.approvers)"]
  timeout: 120
```
Dispatching user picks `["elan", "alice"]`. Both must respond before the gate
opens.

**Quick review + mandatory compliance:**
```yaml
review:
  reviewers:
    - policy: any
      channels: ["$(inputs.reviewers)"]
    - policy: all
      channels: ["compliance", "legal"]
  timeout: 120
```
Any engineer approves (group 0) AND both compliance and legal sign off
(group 1). Both groups must be satisfied.

**Mixed — hardcoded + parameterized:**
```yaml
review:
  reviewers:
    - policy: any
      channels: ["$(inputs.reviewers)", "ops-slack"]
    - policy: all
      channels: ["security"]
  timeout: 60
```
Any of the selected reviewers or anyone from ops-slack (group 0), AND security
must approve (group 1).

**Shared channel, one response sufficient:**
```yaml
review:
  reviewers:
    - policy: any
      channels: ["ops-slack"]
  timeout: 30
```
One notification to the Slack channel. First person to click through and
respond decides.

## Data Model Changes

### `cliq.reviews` — Modified

| Change        | Column          | Type                     | Notes                                       |
|---------------|-----------------|--------------------------|---------------------------------------------|
| **Add**       | `policy`        | JSONB NOT NULL | Reviewer groups with per-group policies (see below) |
| **Drop**      | `realm_id`      | TEXT                     | Redundant — derivable from `run_id`         |

The `verdict` JSONB field is the **final computed verdict** — set when the
policy is satisfied. `reviewer_name` is deprecated; the deciding user is
recorded in `review_notifications` (the `responded_by` column).

The `policy` column stores the reviewer group definitions from the YAML:

```json
{
    "groups": [
        { "idx": 0, "policy": "all", "channels": ["elan", "alice"] },
        { "idx": 1, "policy": "any", "channels": ["ops-slack"] }
    ]
}
```

Per-group policies:

| Policy | Meaning |
|--------|---------|
| `any` | First response from any destination in the group satisfies it |
| `all` | Every destination in the group must respond |

ALL groups must be satisfied for the review to be decided. `review.reviewers`
is mandatory on HUG gate phases — each entry must have a `policy` and
`channels` list.

### `cliq.review_notifications` — New

Each reviewer destination gets a notification row. This is the unit of policy
evaluation and the audit trail. A single user may appear in multiple rows if
they are individually assigned AND a member of a shared channel — no dedup,
each notification is reviewed independently.

```sql
CREATE TABLE cliq.review_notifications (
    id              TEXT PRIMARY KEY,       -- unique notification ID (UUID)
    review_id       TEXT NOT NULL REFERENCES cliq.reviews(id) ON DELETE CASCADE,
    group_idx       SMALLINT NOT NULL,      -- which reviewer group
    channel_target  TEXT NOT NULL,          -- original string: "elan", "ops-slack", etc.
    channel_id      TEXT,                  -- resolved notification_channels.id
    user_id         INTEGER,               -- set when target resolves to a user; NULL for shared channels
    responded_by    INTEGER,               -- user who actually responded (from auth context)
    responded_at    TIMESTAMPTZ,
    action          TEXT,                  -- PASS, REJECT, ROUTE:*
    comment         TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_review_notifications_review
    ON cliq.review_notifications (review_id);
CREATE INDEX idx_review_notifications_user
    ON cliq.review_notifications (user_id)
    WHERE user_id IS NOT NULL;
```

The `group_idx` ties back to the reviewer group in the review's `policy` JSONB,
which stores the group definitions:

```json
{
    "groups": [
        { "idx": 0, "policy": "all", "channels": ["elan", "alice"] },
        { "idx": 1, "policy": "any", "channels": ["ops-slack", "security-slack"] }
    ]
}
```

**Policy evaluation:** When a notification is responded to:
1. Insert `responded_by`, `responded_at`, `action` on the notification row
2. For each group, check if the group's policy is satisfied:
   - `any`: at least one notification in the group has a response
   - `all`: every notification in the group has a response
3. If ALL groups are satisfied → set `verdict` on the review, status → `decided`

**Audit trail example** — elan is assigned individually and is also a member
of ops-slack:

| id | group_idx | channel_target | user_id | responded_by | action |
|----|-----------|----------------|---------|-------------|--------|
| n1 | 0 | elan | 42 | 42 | PASS |
| n2 | 1 | ops-slack | NULL | 42 | PASS |

Both responses are recorded. The trail shows elan approved in his personal
capacity (n1) and on behalf of ops-slack (n2). No dedup, full traceability.

**Access control per notification:**
- User channels (`user_id` set): only the assigned user can respond
- Shared channels (`user_id` NULL): any authenticated org member who arrives
  via that notification link can respond

The notification ID is embedded in the review link
(`/reviews/{review_id}?nid={notification_id}`) so the system knows which
destination is being satisfied.

### `cliq.notification_channels` — New rows (no schema change)

Per-user channels are regular `notification_channels` rows, one per org
membership:

| id                | realm_id | org_id | name   | provider | destinations              |
|-------------------|----------|--------|--------|----------|---------------------------|
| `user-42-org-1`   | NULL     | 1      | `elan` | cliqhub  | `[{"type":"cliqhub"}]`    |
| `user-42-org-5`   | NULL     | 5      | `elan` | cliqhub  | `[{"type":"cliqhub"}]`    |

No schema change needed — the existing model supports this. The `name` field
is set to the username for resolution. Channel name uniqueness is scoped to the
org, so the same username can exist across orgs without collision.

### `cliq.in_app_notifications` — Modified

| Change | Column    | Type         | Notes                                |
|--------|-----------|--------------|--------------------------------------|
| **Add** | `user_id` | INTEGER NULL | Target user for per-user notifications. NULL = realm-wide (existing behavior). |

When a notification is delivered via a per-user `cliqhub` channel, the
deliverer sets `user_id` on the `in_app_notifications` row. The
`InAppNotificationService.list_for_user` query is updated to include rows
where `user_id = caller` in addition to the existing realm membership filter.

## Access Control Changes

### `/reviews/get`

Current: Any authenticated user with a `review_id` can read.

New: Caller must satisfy one of:
- Caller has a `review_notifications` row with their `user_id` for this review
- Caller has `reviews.view` permission in the org (admin override)
- Caller is the daemon that created the review (daemon token)

### `/reviews/verdict`

Current: Any authenticated user can submit.

New: Caller must present a valid `notification_id` (from the review link). The
notification must belong to this review. Access rules:
- User-targeted notification (`user_id` set): only that user can respond
- Shared-channel notification (`user_id` NULL): any authenticated org member
  can respond

Admin override: callers with `reviews.verdict` permission can respond to any
notification.

On submit, the `review_notifications` row is updated (`responded_by`,
`responded_at`, `action`, `comment`). Policy is evaluated — if all groups are
satisfied, `verdict` is set on the review and status moves to `decided`.

### `/reviews/pending`

Current: Returns reviews in realms where the caller is a `RealmMember`.

New: Returns reviews where the caller has a `review_notifications` row (either
by `user_id` match or as a respondent on a shared-channel notification).
Optionally filtered by realm (derived from `run_id → realm_id`). This is a much tighter
query — you see only reviews assigned to you, not everything in your realms.

## Validation

### Publish-Time (Team YAML)

A phase with `agent: hug` **must** have `review.reviewers` — an array of
reviewer groups. If missing, the team fails validation at publish. Each group
must have a `policy` (`any` or `all`) and a non-empty `channels` list.

`channels` values can be:
- A literal list: `reviewers: ["alice", "bob"]`
- A parameterized reference: `reviewers: ["$(inputs.reviewers)"]`
- A mix: `reviewers: ["alice", "$(inputs.approver)"]`

### Dispatch-Time (Run Inputs)

If `review.reviewers` contains parameterized references and the corresponding
inputs are not provided (or resolve to empty), the run is rejected — same as
the existing required input validation.

### Review Creation (Hub)

When the HUG agent calls `POST /v1/reviews/create`, the `reviewers` array
must be non-empty. If resolution produces zero user IDs (no org members
matched), the review is still created (channels may have matched for
notification), but a warning is logged. If resolution produces zero matches
of any kind (no users, no channels), the creation fails with an error —
there's nobody to notify and nobody to gate access.

## HUG Agent Changes

### `ReviewConfig` Interface

```typescript
interface ReviewerGroup {
    policy: 'any' | 'all';
    channels: string[];
}

interface ReviewConfig {
    timeout?: number;
    route_targets?: string[];
    inputs?: InputFieldSpec[];
    reviewers: ReviewerGroup[];  // required on hug phases, at least one group
}
```

### `create_review()` Additions

The `POST /v1/reviews/create` body gains a `reviewers` field:

```typescript
const body: Record<string, unknown> = {
    run_id,
    daemon_id,
    payload,
    timeout_hours,
    reviewers: review_cfg.reviewers,   // required: array of { policy, channels }
};
```

### Verdict Response

The agent currently reads `verdict.reviewer_name` for progress logging.
Updated to use `review_notifications.responded_by` (resolved to display name
by the Hub in the verdict response).

## Frontend Changes

### Channel/User Picker Component

New reusable component for `type: channel` inputs:

- Searchable multi-select dropdown
- Two sections: **People** (org members) and **Channels** (configured notification channels)
- Used in:
  - Run dispatch dialog (for reviewer inputs)
  - Realm teams page inline run panel
  - Review detail page (for `inputs_schema` fields of type `channel`)

### Backend Endpoint for Picker

New endpoint: `POST /v1/org/reviewable_targets`

Returns:
```json
{
  "users": [
    { "user_id": 42, "username": "elan", "display_name": "Elan" }
  ],
  "channels": [
    { "id": "ch-1", "name": "ops-slack", "provider": "slack" },
    { "id": "ch-2", "name": "eng-email", "provider": "email" }
  ]
}
```

Scoped to the caller's org. Used by the picker component.

### Review Detail Page

- Remove the `reviewer_name` text input
- Show notification responses with resolved user names after verdict
- Show assigned reviewers/channels (from `review_notifications`) at the top of the review
- Show per-group policy status (satisfied / pending)

### Notification Inbox (Primary)

- Review notifications land in the user's org-scoped inbox like any other
  notification
- Each notification includes a direct link to the review detail page
- The inbox is the canonical discovery path for all notifications, including
  HUG reviews

### HUG Page (`/hug`) — Optional UX Convenience

- Filtered view of pending reviews assigned to the current user
- Equivalent to the inbox filtered to HUG-type notifications, with review
  status context (pending/decided/expired)
- **Not required.** The implementation must not depend on this page existing.
  All review discovery works through the notification inbox. The HUG page
  may or may not appear in the left nav — that is a UX decision independent
  of the architecture.
- If present, may include a secondary view/tab: "All reviews" for users with
  `reviews.view` permission

## Notification Flow

### On Review Creation

The HUG agent sends raw reviewer strings to the Hub. The Hub handles
everything — the agent has no knowledge of channels, users, or notification
infrastructure.

```
HUG agent:
  POST /v1/reviews/create { run_id, payload, reviewers: [
      { policy: "any", channels: ["elan", "ops-slack"] },
      { policy: "all", channels: ["compliance", "legal"] }
  ] }

Hub (HugReviewsService.create):
  Step 1 — Create the review:
    a. Parse reviewer groups from policy
    b. For each destination in each group:
       - Resolve against org member usernames (precedence) → user_id + personal channel
       - Resolve remaining against notification channel names → channel_id
    c. Insert review row (with policy JSONB)
    d. Insert review_notifications rows (one per destination per group)

  Step 2 — Deliver notifications:
    a. For each resolved user → deliver to their personal channel
    b. For each resolved channel → deliver through that channel's medium
    (Uses existing fan-out/deliverer infrastructure. No new plumbing.)

  Step 3 — System event (separate concern):
    Emit hug.review_requested for observability/audit.
    Admins can route hug.* events via notification rules. Not a review concern.
```

### On Verdict

```
HugReviewsService.submit_verdict():
  1. Validate notification_id belongs to this review
  2. Validate caller has access (user_id match or shared channel + org member)
  3. Update review_notifications row (responded_by, action, comment, responded_at)
  4. Evaluate policy — if all groups satisfied → set verdict, status = decided
  3. Emit hug.review_responded system event (separate concern)
  4. Enqueue verdict delivery to daemon via command_outbox
```

## Migration

### Database

```sql
-- Add policy to reviews
ALTER TABLE cliq.reviews
    ADD COLUMN IF NOT EXISTS policy JSONB NOT NULL DEFAULT '{"groups":[]}';

-- Review notifications (one per destination per group)
CREATE TABLE IF NOT EXISTS cliq.review_notifications (
    id              TEXT PRIMARY KEY,
    review_id       TEXT NOT NULL REFERENCES cliq.reviews(id) ON DELETE CASCADE,
    group_idx       SMALLINT NOT NULL,
    channel_target  TEXT NOT NULL,
    channel_id      TEXT,
    user_id         INTEGER,
    responded_by    INTEGER,
    responded_at    TIMESTAMPTZ,
    action          TEXT,
    comment         TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_review_notifications_review
    ON cliq.review_notifications (review_id);
CREATE INDEX IF NOT EXISTS idx_review_notifications_user
    ON cliq.review_notifications (user_id)
    WHERE user_id IS NOT NULL;

-- Add user_id to in_app_notifications for per-user targeting
ALTER TABLE cliq.in_app_notifications
    ADD COLUMN IF NOT EXISTS user_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_user
    ON cliq.in_app_notifications (user_id)
    WHERE user_id IS NOT NULL;
```

### Per-User Channel Backfill

```sql
-- Create personal channels for all existing users
INSERT INTO cliq.notification_channels (id, realm_id, org_id, name, provider, destinations, enabled, created_at, updated_at)
SELECT
    'user-' || u.id,
    NULL,
    om.org_id,
    u.username,
    'cliqhub',
    '[{"type":"cliqhub"}]',
    1,
    EXTRACT(EPOCH FROM NOW()) * 1000,
    EXTRACT(EPOCH FROM NOW()) * 1000
FROM public.users u
JOIN public.org_members om ON om.user_id = u.id
ON CONFLICT (id) DO NOTHING;
```

### `realm_id` Column on Reviews

The `realm_id` column is dropped in a two-step migration:

1. **First migration:** Create `review_notifications` table, add `policy`
   column. Stop writing `realm_id` on new reviews. Update all read queries
   to join through `run_id` for realm context.
2. **Second migration (later release):** Drop `realm_id` column and its index.

### Existing Reviews

Existing reviews have no `review_notifications` rows. The access control change
means they become invisible in the pending list (no one is assigned). This is
acceptable because:
- Old pending reviews should have expired by now (timeout-based)
- Old decided/completed reviews remain accessible to users with
  `reviews.view` permission

## Implementation Plan

### Phase 1: Data Model & Per-User Channels

**Goal:** Schema changes, per-user channel auto-provisioning, backfill.

- Add `policy` (JSONB) to `cliq.reviews`
- Create `cliq.review_notifications` table
- Add `user_id` (INTEGER) to `cliq.in_app_notifications`
- Auto-create `user-{user_id}` channel on signup (in auth service)
- Backfill per-user channels for existing users (migration)
- Update `InAppNotificationService.list_for_user` to include user-targeted rows
- Update `CliqHubDeliverer` to set `user_id` when delivering to a per-user channel

**Tests:**
- Migration creates tables and columns correctly
- Per-user channel created on signup
- `list_for_user` returns user-targeted notifications
- `CliqHubDeliverer` sets `user_id` for per-user channels

### Phase 2: Reviewer Resolution & Review Creation

**Goal:** Hub resolves reviewer groups to users/channels, creates notification
rows, delivers targeted notifications.

- Add `reviewers` field (array of `{ policy, channels }` groups) to
  `POST /v1/reviews/create` request schema
- Implement `resolve_reviewer_groups(org_id, groups)`:
  - For each group, for each channel string:
    - Match against org member usernames (precedence) → user_id + personal channel
    - Match remaining against notification channel names → channel_id
  - Return resolved groups with user IDs and channel IDs
- Store groups in review `policy` JSONB
- Insert `review_notifications` rows (one per destination per group)
- Deliver notifications to all resolved channels (including per-user channels)
- Embed notification ID in review link (`?nid=...`)
- Log warnings for unresolved strings
- Reject creation if any group resolves to zero destinations

**Tests:**
- Username resolution takes precedence over channel name
- Channel name resolution for non-user strings
- Unresolved strings logged and skipped
- Zero-destination group rejection
- `review_notifications` rows correctly created per destination per group
- Notification IDs embedded in delivered review links
- Multiple groups stored correctly in `policy` JSONB

### Phase 3: Access Control

**Goal:** Gate review endpoints by `review_notifications` and existing permissions.

- `/reviews/get`: Require caller has a `review_notifications` row with their
  `user_id` OR `reviews.view` permission OR daemon token
- `/reviews/verdict`: Require valid `notification_id`. User-targeted
  notifications: only assigned user. Shared-channel notifications: any org
  member. Admin override via `reviews.verdict` permission. Update the
  notification row, evaluate policy.
- `/reviews/pending`: Join on `review_notifications` for caller's user ID
- Wire up existing `reviews.view` and `reviews.verdict` permissions

**Tests:**
- Assigned user can view and verdict
- Non-assigned user without permission gets 403
- Shared-channel notification: any org member can respond
- Admin with `reviews.view` can view any review
- Admin with `reviews.verdict` can verdict any review
- Daemon token can view its own reviews
- Pending list returns only reviews with caller's notifications
- Notification row updated on verdict
- Policy `any`: review decided on first response in group
- Policy `all`: review decided only when all in group respond
- Multi-group: all groups must be satisfied

### Phase 4: Unified Input Syntax

**Goal:** Unify team-level and HUG review input schemas into a single
`InputFieldSpec`. Add `type: channel`.

- Define canonical `InputFieldSpec` (shared between daemon, SDK, Hub, frontend)
- Update `capability_json.inputs` to store full `InputFieldSpec` arrays
- Update publish flow to preserve `type`, `label`, `help`, `default`,
  `choices`, `placeholder` from YAML `inputs:` block
- Update dispatch validation to use the full spec
- Add `type: channel` — renders as user/channel picker in the frontend
- Backward compatible: inputs with only `name` and `required` default to
  `type: text`
- Build shared input rendering component used by dispatch dialog, review
  detail page, and realm run panel

**Tests:**
- Full `InputFieldSpec` round-trips through publish → capability_json → dispatch UI
- `type: channel` accepted and rendered as picker
- Existing inputs without `type` default to text
- Shared component renders all field types correctly

### Phase 5: HUG Agent & YAML Validation

**Goal:** Agent reads `review.reviewers`, sends to Hub. Validation enforced
at publish and dispatch.

- Add `ReviewerGroup` and update `ReviewConfig` interface in HUG agent
- Read `review_cfg.reviewers` (array of groups), include in `create_review()` body
- Publish-time validation: `agent: hug` phase without `review.reviewers` is an
  error. Each group must have `policy` (`any` or `all`) and non-empty `channels`.
- Dispatch-time validation: parameterized channels that resolve to empty are rejected

**Tests:**
- HUG agent sends reviewer groups in create request
- Publish rejects HUG phase without `review.reviewers`
- Publish rejects group without `policy`
- Publish rejects group with empty `channels`
- Publish rejects invalid `policy` value
- Dispatch rejects empty resolved channels

### Phase 6: Frontend — Channel Picker & Review UX

**Goal:** User/channel picker for dispatch, updated review pages.

- `POST /v1/org/reviewable_targets` endpoint
- Channel/user picker component (searchable multi-select)
- Dispatch dialog renders picker for `type: channel` inputs
- Review detail shows notification groups, per-group policy status, and
  responses (no free-text name)
- Verdict submission includes `notification_id` to identify which destination
  is being satisfied

The `/hug` page is not modified in this phase. Review discovery is through
the notification inbox. The HUG page may be updated or removed independently
as a future UX decision.

**Tests:**
- Picker renders org members and channels
- Picker selection populates input correctly
- Review detail shows notification groups with policy status
- Inbox shows review notifications for assigned users
- Verdict submission sends `notification_id`

### Phase 7: Update Built-in Teams

**Goal:** Update `hello-world` and `hello-hug` to use the new reviewer
architecture.

- **`hello-world` seed** (`seed.ts`): Add `reviewers` input with
  `type: channel`, add `review.reviewers` with a single `{ policy: any,
  channels: ["$(inputs.reviewers)"] }` group to the HUG gate phase, update
  `capability_json` to include the full `InputFieldSpec`.
- **`hello-hug` example** (`examples/hello-hug/team.yml`): Same — add
  `reviewers` input and wire it into the review block.
- Update any other example teams with HUG gates to include `review.reviewers`.

Before:
```yaml
inputs:
  - name: name
    required: true

phases:
  - name: human-review
    type: gate
    agent: hug
    review:
      timeout: 30
```

After:
```yaml
inputs:
  - name: name
    type: text
    required: true
    label: "Who to greet"
  - name: reviewers
    type: channel
    required: true
    label: "Reviewers"

phases:
  - name: human-review
    type: gate
    agent: hug
    review:
      reviewers:
        - policy: any
          channels: ["$(inputs.reviewers)"]
      timeout: 30
```

**Tests:**
- Seed creates team with reviewers input in `capability_json`
- Dispatch of `hello-world` requires reviewers input
- Example YAMLs pass publish-time validation

### Phase 8: Cleanup & realm_id Removal

**Goal:** Remove deprecated fields and dead code.

- Drop `realm_id` from `cliq.reviews` (second migration)
- Remove `reviewer_name` from verdict submission UI
- Deprecate `reviewer_name` in API schema (accept but ignore)
- Clean up `review_chat_messages` table (drop or mark deprecated)
- Remove realm-based filtering from `ReviewPendingService`

**Tests:**
- Reviews work without `realm_id`
- Old reviews with `realm_id` still accessible
- `reviewer_name` in old verdicts doesn't break rendering

## Scoping

Per-user channels are created per org membership (one `user-{user_id}` row per
org the user belongs to). Channel name uniqueness is scoped to the org — two
orgs can each have a channel named "ops-lead" without collision.

Reviews themselves have no explicit org scoping. The org context flows through
naturally: reviewer resolution runs against org members, notifications deliver
through org-scoped channels, and access control is via `review_notifications`
(per-destination rows with user IDs for user-targeted notifications). The run provides realm/org context when needed.

