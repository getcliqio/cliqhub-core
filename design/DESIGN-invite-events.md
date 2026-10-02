# Invites as events, delivered through notification channels

Status: **PROPOSED, not implemented.** Inventory of today's notification model in core6 plus a design for the user's decisions:

- Invites are events, and the existing notification channels deliver them. Email is a channel.
- The invite events are `sent`, `accepted`, `declined`, `revoked` and `expired`, for org, realm and owner invites. A resend is `sent` again. There are no reminders.
- The email channel is configured by default. Orgs cannot change how invite events reach the invited person.
- Default channels and rules are seeded when orgs and users are created.

---

## Part 1 — Today (inventory, core6 as committed + the sandbox invite/email draft)

### 1.1 Tables

| Table (schema `cliq`) | Columns that matter | Level | Notes |
|---|---|---|---|
| `notification_channels` | `id` TEXT PK, `realm_id`, `org_id`, `user_id`, `name`, `secret`, `enabled` INT, `created_at`/`updated_at` BIGINT | realm (`realm_id` set) · org (`org_id`, no realm) · personal (`user_id` + `org_id`) | No provider column: the transport lives on destinations. The unique indexes are `(realm_id, name)` when realm is set and `(org_id, name)` when realm is null. A personal channel is looked up by `(user_id, org_id)`. The legacy DDL in `control_plane_schema_migrations.ts` still declares `provider`/`config`/`name UNIQUE`, but the model no longer uses them. |
| `channel_destinations` | `id`, `channel_id` (FK cascade), `type` (`email`, `slack`, `webhook`, `http`, `jira`, `cliqhub`, `channel_ref`), `config` JSONB | per channel | One channel can have many destinations. An `email` destination has `{ address, cc?, bcc? }`, mapped to `{ to, cc, bcc }` at delivery. |
| `notification_rules` | `id`, `realm_id`, `org_id`, `team_slug`, `event` (a type or a group selector), `channel_id`, `priority` | team (realm + team) · realm · org ("global tier", realm null) | Unique `(realm_id, team_slug, event, channel_id)`. There is no `enabled`, no lock and no recipient column. |
| `notification_subscriptions` | `realm_id`, `channel_id`, `event`, `scope` | realm | Legacy. Rows are only ever deleted (realm/org/user removal); nothing reads them for routing. |
| `in_app_notifications` | `event`, `title`, `message`, `realm_id`, `org_id`, `user_id`, `team`, `run_id`, `phase`, `severity`, `review_id`, `payload_json` | per user (`user_id`) or realm broadcast (`user_id` null) | The inbox (`/v1/notifications/get`) shows the user's own rows plus broadcasts from realms the user is a member of. |
| `events` (model `HubEvent`) | `type`, `realm_id`, `org_id`, `team`, `run_id`, `phase`, `daemon_id`, `title`, `message`, `severity`, **`payload_json`**, `actor_id` | — | Every submitted event is stored with its whole payload, so **nothing secret may go in a payload**. |
| `custom_events` | `event_type`, `source` (`declared`/`observed`), `realm_id`, `team_slug` | realm | Catalogue of `custom.*` events. |
| `review_notifications` | `review_id`, `user_id`, `channel_id`, `channel_target`, `action`, `responded_by` | per user | Per-reviewer delivery log for HUG reviews. |

### 1.2 Events: definition, emission, routing

- **Definition:** `schemas/event_types.ts` has a closed list `EVENT_TYPES`, plus `custom.*`.
  - `run.started|resumed|completed|failed|crashed|cancelled`
  - `phase.started|completed|failed|skipped|escalated|input_required|inputs_supplied|timed_out|idle`
  - `hug.review_requested|review_reminded|review_responded|routing_requested|review_resolved|review_expired`
  - `team.published|visibility_changed`
  - `daemon.enrolled|removed|online|offline|outbox.dead|outbox.recovered`
  - `realm.created|deleted|member_added|member_removed|member_role_changed|token_created|token_revoked|key_rotated`
  - `auth.api_key_created|api_key_revoked`
  - `notification.test|failed`
  - Groups (`run.*`, `phase.*`, …) are selectors in `notifications/types.ts`.
  - **There are no `invite.*` or `org.*` events.**
- **Emission:** `EventSubmitService.submit()` (also `POST /v1/events/submit`) inserts into `events`, then calls `route_event()` synchronously and returns the dispatch status (`dispatched`/`skipped`/`failed`). An optional `target_channels` list delivers to specific channels in addition to the rules; HUG reviewers are reached that way.
- **Routing** (`notifications/router.ts`):
  - **Realm events** (run, phase, hug, daemon, realm, custom) go to `notify_realm`:
    - `payload.notify.channels === false` mutes the event; a non-empty list of channel refs delivers to those channels.
    - Otherwise `resolve_rules` runs. If no rule matches and the event is a default-notify event (`run.failed`, `run.crashed`, `phase.input_required|idle|timed_out`), it goes to the realm's `realm:all_users` channel.
  - **Account events** (team, auth) go to `notify_account`, which uses org-tier rules only.
  - **Any other prefix throws** ("No notification route"), so new event families must be added to the router.
- **Rule matching** (`NotificationService.resolve_rules`): the selectors are the event type plus its group. Tiers are tried in order, and **the first tier that has any match wins** (there is no union across tiers): team rules (realm + team), then realm rules, then org rules (`realm_id IS NULL`, filtered by `org_id` when the event has one).
  - ⚠ Finding: an event with **no `org_id`** matches org-tier rules of **every org**.
  - ⚠ Finding: rules with `org_id IS NULL` are never matched when the event has an `org_id`. Hub-level rules therefore do not work today.

### 1.3 Deliverers and recipients

| Deliverer | Recipients | Dynamic recipient? |
|---|---|---|
| `email` | `to`/`cc`/`bcc` from the destination config (static addresses). The sandbox draft sends through Brevo (`lib/email`). Without a key it logs and skips. | **No.** A rule cannot say "the invitee" or "the org owners"; there is only a fixed address on the channel. |
| `cliqhub` (in-app) | The channel's `user_id` (that user's inbox), otherwise a realm broadcast | Only through a personal channel per user |
| `slack` / `webhook` / `http` / `jira` | Static URL | No |
| `channel_ref` | Another channel by name (recursive, with cycle guard) | No |

The only existing case of a dynamic recipient is **HUG reviews**: `hug_reviews.service.ts` resolves reviewer users, calls `ensure_per_user_channel(user, org)` and submits with `target_channels`.

### 1.4 What gets seeded today

| When | Rows written | Where |
|---|---|---|
| **Org create** (`orgs/new`, `create_org_with_owner`) | Nothing notification-related. The org default realm is made after commit (see realm create). | `orgs_service.ts` |
| **Signup** (user + personal org) | After commit: one personal channel `notification_channels {user_id, org_id = personal org, name = username}` with one `channel_destinations {type: cliqhub}`. Then `ensure_account_default_realm` runs (see realm create). | `auth_service.ts:210` |
| **Admin user create** (`users/new`) | No channel. The personal realm comes through `ensure_personal_realm` (see realm create). | `users_service.ts` |
| **Invite accept** (org / realm / owner) | No personal channel. Org default realm and personal realm through `ensure_*_realm` (see realm create). | `invitations_service.ts` |
| **`orgs/add_member`** (site-admin direct add) | Personal channel `(user, org)` with a cliqhub destination | `orgs_service.ts:596` |
| **Realm create** (`RealmService.create`, used by `ensure_org_default_realm` / `ensure_personal_realm` / `realms/create`) | Channel `id = cliqhub-<realm>`, `name = cliqhub`, `realm_id`, enabled, plus one `cliqhub` destination | `realm.service.ts:355` |
| **First default-notify event in a realm** (lazy) | Channel `id = all_users-<realm>`, `name = realm:all_users`, plus a cliqhub destination. It is re-enabled if someone disabled it. | `fan_out.service.ts:64` |
| **First HUG review for a reviewer** (lazy) | Personal channel `(user, org)` | `hug_reviews.service.ts:306` |
| **Jira integration** | Realm rules pointing at its channel | `jira_integration.service.ts` |
| **Boot migrations** | **No channel or rule rows.** `control_plane_seed.ts` seeds only settings keys (`notifications.idle_threshold_minutes`, `notifications.on_complete.enabled`, `notifications.on_error.enabled`). | — |

**No org or user starts with any notification rule.**

### 1.5 Locks

There are none. No `system`/`locked` columns exist on channels or rules. The nearest thing is behavioural: `ensure_realm_all_users_channel` / `ensure_realm_cliqhub_channel` re-enable themselves when disabled, but they can still be renamed, deleted or rerouted. Editing is gated only by permissions (`channels.manage[.realm]`, `rules.manage[.realm]`) through the route policy.

### 1.6 Routes and where it shows

- **Core:**
  - `notification_channels/get|create|update|remove|test`
  - `orgs|realms/get|set|remove_notification_rules`
  - `notifications/get` (inbox)
  - `events/submit|get_by_id|types/list|custom/*`
- **BFF:**
  - pass-through for all of the above;
  - `notification_center/get|check|set_rules` composes per-org and per-realm rules and channels for one page.
- **SPA:**
  - `/notifications` (Notification center: rules and channels per org/realm, "Check a realm" tab). It already shows a 🔒 "view only" state, but that reflects **permissions**, not locks.
  - The realm settings page links there.
  - The Org page has a "Notifications" permission group.
  - The inbox lives in the shell.
  - `/account/notification-channels` redirects to `/notifications`.

### 1.7 The sandbox invite/email draft (not committed; this design re-routes it)

| Draft piece | Keep / change |
|---|---|
| `lib/email/*`: `EmailSender`, `BrevoEmailSender` (fetch with timeout, typed errors, no key/body logging), `NoopEmailSender`, config validation, `.env.example` | **Keep** as the email channel's transport |
| `lib/email/templates.ts` (org, owner, realm invite, notification) | **Keep the layout**; re-key it by event name (see 2.6) |
| `EmailDeliverer` wired to the sender | **Keep**; extend it with the recipient selector and per-event templates |
| `invite_issue.deliver_invite()`: the invitations service **sends email directly** | **Move to events**: issuing an invite emits `invite.*.sent`, and the locked system rule delivers it |
| Owner invites reserving a name, owner-create on accept, consent for existing users, `add_member` → invite for non-site-admins, `orgs/new` union, BFF/SPA picker + link fallback | **Keep** (unchanged by this decision) |
| Response `{ email_sent, invite_url? }` | **Keep the shape.** `email_sent` becomes the dispatch result of the locked delivery. `invite_url` stays the fallback when it was not delivered. |

---

## Part 2 — Proposal

### 2.1 Event catalogue

One family, `invite.*`, with three kinds. Prefixes route as follows:
- `invite.realm.*` takes the realm path (`realm_id` set);
- `invite.org.*` takes the org path (`org_id` set);
- `invite.owner.*` (an org that doesn't exist yet) takes the hub path (no org).

| Event | Emitted by | Severity |
|---|---|---|
| `invite.org.sent` / `invite.realm.sent` / `invite.owner.sent` | create, and **resend** (same event, `resend: n`) | info |
| `invite.*.accepted` | accept | info |
| `invite.*.declined` | decline (new public action, token) | info |
| `invite.*.revoked` | revoke | info |
| `invite.*.expired` | expiry sweep (new, same pattern as `review_expiry_sweep`), once per invite | warn |

Each event type is added to `EVENT_TYPES`, the group `invite.*` is added, and the router learns the prefixes. No reminders.

**Payload (persisted, so no token):**

| Field | sent | accepted | declined | revoked | expired |
|---|---|---|---|---|---|
| `invite_id`, `kind` (org/realm/owner), `role`, `expires_at` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `invitee_email`, `invitee_display_name`, `account_exists` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `org_id`, `org_slug`, `org_display_name` (owner: reserved slug and name, `org_id` null until accept) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `realm_id`, `realm_slug`, `realm_name` (realm kind) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `inviter_id`, `inviter_name` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `resend` (0 = first send) | ✓ | | | | |
| `accepted_user_id`, `accepted_username`, `created_org` | | ✓ | | | |
| `revoked_by` | | | | ✓ | |

**How the accept link reaches the template without storing the token.** `EventSubmitService.submit()` gets an **ephemeral** input, `{ ephemeral: { accept_url } }`, that is handed to `route_event()` → `deliver` in memory and is **never written** to `events.payload_json` or logs. Templates read `accept_url` from it.

Because the raw token is unrecoverable, a **resend rotates the token**: it writes a new `token_hash`, the old link dies, and `invite.*.sent` is emitted with `resend: n`. Retrying a failed delivery is done the same way, by a resend.

### 2.2 Recipient model

Channel = transport; rule = who. A new rule column, `recipients`, holds a selector resolved at delivery:

| Selector | Resolves to | Delivered via |
|---|---|---|
| `invitee` | `payload.invitee_email` | Hub system channel `system:email` (to that address). If the email has an account, that user's personal channel too (in-app). |
| `org_owners` / `org_admins` | Members with the owner / admin role in `payload.org_id` | Each user's **personal channel** (their in-app + email preferences) |
| `realm_admins` | Realm admins of `payload.realm_id` | Personal channels |
| `inviter` | `payload.inviter_id` | Personal channel |
| `site_admins` | Users with `role = admin` (owner-create events: there is no org yet) | Personal channels |
| `null` (today's behaviour) | The channel's own destinations | The channel |

**One hub-level email channel, not one per org.**
- There is one transport (one Brevo key, one verified sender) and one delivery rule that orgs must not change. A hub row is the single thing to lock.
- The invitee isn't an org member, so there is no org-owned channel that would naturally reach them.
- Per-org copies would multiply rows, drift and need a backfill for every org.
- Orgs keep full control of their own channels (Slack, webhooks, their own email lists) through their editable rules.

**Personal channel per user (one, hub-level).** It holds `user_id` with `org_id` null, and two destinations:
- `cliqhub` (in-app, locked on);
- `email` with `address: self`, resolved to the user's current email and **toggleable by the user**.

This is where a user's own email/in-app preferences live. Today's per-(user, org) channels stay as they are for reviews and realm delivery.

**Routing change.** `resolve_rules` returns **locked rules ∪ the normal tier result**. Locked rules always fire, are never shadowed by team or realm tiers, and ignore `notify.channels = false`. Hub-level rules (`org_id IS NULL`) are matched for every org; this fixes the 1.2 finding for locked rules. Separately, events with no `org_id` should stop matching all orgs' rules.

### 2.3 Schema changes

| Table | Add | Purpose |
|---|---|---|
| `notification_rules` | `recipients TEXT NULL`, `locked BOOLEAN NOT NULL DEFAULT false`, `enabled BOOLEAN NOT NULL DEFAULT true`, `system_key TEXT NULL UNIQUE`, `lock_reason TEXT NULL` | Dynamic recipients, locks, user can mute an editable default, idempotent seeding |
| `notification_channels` | `locked BOOLEAN NOT NULL DEFAULT false`, `system_key TEXT NULL UNIQUE`, `lock_reason TEXT NULL` | System channels |
| `channel_destinations` | `locked BOOLEAN NOT NULL DEFAULT false` | The in-app destination of a personal channel |
| `events` | none (ephemeral input is never stored) | — |
| `account_invites` / `realm_invites` | status `expired` and `declined` (today expiry writes `revoked`), `resend_count`, `declined_at` | Event lifecycle, events emitted once |

### 2.4 Seeding matrix (exact rows; every write idempotent through `system_key`)

| When | Rows | `system_key` | Locked |
|---|---|---|---|
| **Boot, once (hub)** | Channel `system:email`, org/realm/user null; destination `email {address: '$recipient'}` | `hub:email` | ✓ |
| | Rule `invite.org.sent` → `system:email`, recipients `invitee` | `hub:invite.org.sent` | ✓ |
| | Rule `invite.realm.sent` → same | `hub:invite.realm.sent` | ✓ |
| | Rule `invite.owner.sent` → same | `hub:invite.owner.sent` | ✓ |
| | Rule `invite.owner.accepted|declined|expired` → recipients `site_admins` | `hub:invite.owner.<ev>` | — (site admins can edit) |
| **Org create** (signup's personal org, `orgs/new` with an existing owner, owner-invite accept), inside the create transaction | Rules `invite.org.accepted`, `invite.org.declined`, `invite.org.expired` → recipients `org_owners` (personal channels), org-tier | `org:<id>:invite.org.<ev>` | — (editable / disable-able) |
| | No org channel: owners are reached through their personal channels | — | — |
| **User create** (signup, `users/new`, invite accept, owner-invite accept), inside the create transaction | Personal channel `user:<id>` (`user_id`, org null); destinations `cliqhub` (locked) + `email {address: 'self'}` (enabled) | `user:<id>` | channel ✓ (can't delete), email destination ✗ (user toggles) |
| **Realm create** (`RealmService.create`) | Keep `cliqhub-<realm>` as today. Rules `invite.realm.accepted`, `invite.realm.declined`, `invite.realm.expired` → recipients `realm_admins`, realm-tier | `realm:<id>:invite.realm.<ev>` | — |
| **Boot backfill** (`migrate_notification_defaults`, after `migrate_org_roles`, idempotent, logged with counts) | All hub rows above, plus every live org, user and realm missing its seeded rows. Existing per-(user, org) channels untouched. | same keys | same |

`revoked` gets no default rule: the actor revoked it. Orgs can add a rule.

### 2.5 Locking

| Layer | Behaviour |
|---|---|
| Core | `set_rule`, `remove_rule`, `update_channel`, `remove_channel`, destination edits: a locked target → **409 `locked`**, *"Built in — invite emails always reach the invited person. Org rules can add more channels but can't change this one."* (`details: { system_key, lock_reason }`). Locked rows are created only by the seeder. Site admins get the same refusal (change it in code, not data). |
| Core reads | `locked`, `lock_reason`, `recipients` on rule and channel DTOs. Hub-level locked rules are included in every org's rule list (read-only). |
| BFF | Pass-through; `notification_center` carries `locked` / `lock_reason` per rule and channel. No new endpoints. |
| SPA | `/notifications`: locked rows show a 🔒 with the `lock_reason` tooltip/text, and no edit, delete or move controls. Personal channel: in-app shown as always on, email as a toggle. Editable defaults show a "Default" pill and can be disabled. |

### 2.6 Templates (one per event, chosen by event name, same layout)

| Template | To | Inputs |
|---|---|---|
| `invite.org.sent` | invitee | `org_display_name`, `org_slug`, `role`, `inviter_name`, `invitee_display_name`, `accept_url`*, `expires_at`, `account_exists` (wording: "sign in to accept" vs "create your account") |
| `invite.realm.sent` | invitee | `realm_name`, `org_slug`, `role`, `inviter_name`, `invitee_display_name`, `accept_url`*, `expires_at`, `account_exists` |
| `invite.owner.sent` | invitee | `org_display_name`, `org_slug` (reserved), `inviter_name`, `invitee_display_name`, `accept_url`*, `expires_at`, `account_exists`, `creates_org` |
| `invite.*.accepted` | owners / realm admins / site admins | `invitee_email`, `accepted_username`, target names, `role`, `created_org`, `org_url` |
| `invite.*.declined` | same | `invitee_email`, target names, `role`, `inviter_name` |
| `invite.*.revoked` | (no default) | `invitee_email`, target names, `revoked_by` |
| `invite.*.expired` | same | `invitee_email`, target names, `role`, `expires_at`, `resend_url` (the org page link) |
| fallback | any | today's `notification_email` (title, message, facts) |

\* `accept_url` comes only from the ephemeral input and is never stored. All templates share one layout: escaped values, absolute links, text version.

### 2.7 Scope of work

| Repo | Work | Size |
|---|---|---|
| **Core** | Event types, `invite.*` group, router prefixes; ephemeral submit input | S |
| | Rule/channel/destination columns + migration + boot backfill seeder (`migrate_notification_defaults`) + create-path seeding (org, user, realm) inside the existing transactions | M |
| | Recipient resolver in fan-out (`invitee`, `org_owners`, `org_admins`, `realm_admins`, `inviter`, `site_admins`, `self`); locked ∪ tiers; hub-level rule matching; stop no-org events matching all orgs | M |
| | Lock refusals (409) in `NotificationService`; DTO fields | S |
| | Invitations: emit `sent`/`accepted`/`revoked` instead of `deliver_invite`; add `decline` + `resend` (token rotation); expiry sweep; statuses `expired`/`declined` | M |
| | `EmailDeliverer`: template by event name, recipient from resolver; templates re-keyed | S |
| | Tests on real Postgres: seeding per create path + backfill idempotent; locked rule fires despite realm rules and mute; 409 on edit; token never in `events`; resend rotates the token; expiry emits once | M |
| **BFF** | Types for `locked`, `lock_reason`, `recipients`, `enabled`; notification_center pass-through | S |
| | `invitations/decline` and `/resend`: **new routes** — see Q3 | S |
| **SPA** | Notification center lock UI + "Default" pill + personal email toggle | S–M |
| | Invite page "Decline"; org/realm pending invites "Resend" | S |
| | Existing draft UI unchanged (email_sent / link fallback) | — |

Migrations, all idempotent in `migrate_hub_schema` plus the new backfill:
- the new columns;
- partial unique indexes on `system_key`;
- invite statuses;
- backfill of the hub rows and per-org/user/realm defaults.

### 2.8 Open questions for the user

1. **Locked invite rules: hub-level once (recommended), or a copy seeded into every org?** Both look the same in the UI, a 🔒 row in each org. Hub-level is one row to maintain; per-org copies match "seeded at org create" literally.
2. **Who gets accepted/declined/expired by default:** org owners only (proposed), or the inviter as well?
3. **Decline and resend need two new endpoints** (Core + BFF pass-through + SPA buttons), which the "BFF must not create endpoints" rule forbids. Approve `invitations/decline` and `invitations/resend`?
4. **Personal email preference default:** should org-facing invite notifications email owners by default (proposed: yes, in-app + email), or in-app only until they opt in?
