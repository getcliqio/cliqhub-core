# DESIGN: Notifications v2 — Channels, Rules, and Tiered Inheritance

> **Status:** Proposed
> **Date:** 2026-08-31
> **Repos:** `cliqhub` (backend, BFF, frontend), `cliq` (daemon, SDK)

## Problem

The current notification system has evolved organically across both repos. The daemon handles both event emission and channel delivery, manifests couple event→channel mappings directly, and there's no coherent tiered model for routing configuration.

**Key gaps:**

1. **Manifests couple events to channels.** The `notify:` block maps lifecycle events to channel names (`notify: { on_error: "ops" }`). This couples team definitions to infrastructure and makes teams non-portable across realms with different channel setups.

2. **No channel composition.** A channel is a single destination. There's no way to create a group like "architects-and-designers" that fans out to multiple named channels.

3. **No tiered inheritance.** Channels and notification rules are either account-scoped or realm-scoped. There's no team-in-realm tier, and no "replace" semantics — just flat bindings.

4. **No custom event types.** Teams can only trigger system lifecycle events. There's no way for a team to declare domain-specific events (e.g., `custom.enrichment_stale`).

5. **Agent-initiated `notify` messages are dropped.** `base_agent.ts` posts `event_type: 'notification'` with a channel name, but `EventsController._maybe_notify` doesn't handle that event type.

6. **No `notification.failed` event.** When a channel delivery fails, it's logged but doesn't fire a system event. Operators have no way to route delivery failures to a fallback channel.

7. **Two event vocabularies.** The daemon uses legacy `on_*` keys (`on_start`, `on_error`). The Hub uses catalog types (`run.started`, `run.failed`). Mapping tables exist but add cognitive overhead.

## Design

### Core Principle

**Manifests declare events. The Hub routes events to channels.**

The daemon is a pure event emitter. It does not know about channels. All routing — which events go where — is configured in the Hub via notification rules. This cleanly separates the "what happened" concern (daemon/team) from the "who to tell" concern (Hub/operator).

### Concepts

**Event** — a typed occurrence in the system. Two categories:

- **System events** — lifecycle events emitted automatically by the daemon: `run.started`, `run.failed`, `phase.escalated`, `daemon.offline`, etc. These are the existing Hub catalog types. Every phase emits them — no manifest declaration needed.
- **Custom events** — domain-specific events declared by a team in its manifest and emitted by agents at runtime. Prefixed with `custom.` (e.g., `custom.enrichment_stale`, `custom.threshold_breached`).

**Channel** — a named destination group. Contains one or more *destinations* (email, Slack webhook, Jira webhook, generic HTTP endpoint) and zero or more *channel references* (pointers to other named channels). Channel references enable composition.

**Notification rule** — a mapping from an event type (or event group like `run.*`, `custom.*`) to one or more channels. Configured at three tiers with replace semantics.

### Manifest Event Declaration

An optional top-level `events:` array declares custom event types the team uses. This is a best-practice for discoverability — the Hub reads it at install time to pre-populate the notification rules UI so realm admins can configure routing before any events fire:

```yaml
name: crm-enrichment
events:                              # optional, recommended
  - custom.enrichment_stale
  - custom.data_quality_alert
  - custom.api_quota_warning
phases:
  - name: enrich
    agent: cursor
    ...
```

System events (`run.*`, `phase.*`) are implicit and do not need to be declared — the daemon emits them for every phase automatically. The `events:` array is for `custom.*` types only.

If `events:` is omitted, everything still works. Custom events emitted via `notify:` blocks or `ctx.emit()` are discovered dynamically by the Hub when they first fire and appear in the rules UI at that point. Declaring `events:` upfront provides two benefits:

1. **Pre-populated rules UI** — realm admins see available custom events at team install, before any runs.
2. **Install-time validation** — if `events:` is present, `notify:` block references are validated against it to catch typos early. If `events:` is absent, no cross-validation occurs.

### Phase `notify:` Block (Declarative Event Emission)

The `notify:` block on phases is **retained**, but its semantics change: it maps lifecycle hooks to **custom event types**, not to channel names. The Hub routes events to channels — the manifest never references channels.

**Before (old — maps lifecycle hooks to channel names):**
```yaml
phases:
  - name: enrich
    agent: cursor
    notify:
      on_error: [ops, pager]
      on_complete: done
```

**After (new — maps lifecycle hooks to custom events):**
```yaml
phases:
  - name: enrich
    agent: cursor
    notify:
      on_error:
        event: custom.enrichment_failed
        message: "Enrichment failed on phase {phase_name}"
      on_complete:
        event: custom.enrichment_done
        message: "Enrichment completed for {run_id}"
```

**Shorthand** (event type only, no custom message — the Hub uses a default template):
```yaml
phases:
  - name: enrich
    agent: cursor
    notify:
      on_error: custom.enrichment_failed
      on_complete: custom.enrichment_done
```

**Supported lifecycle hooks:** `on_start`, `on_complete`, `on_error`, `on_skip`, `on_escalate`, `on_timeout`. Each accepts either a string (shorthand) or an object with `event` and optional `message`.

**How it works:** When the daemon executes a phase and a lifecycle hook fires, it checks the `notify:` block. If a mapping exists for that hook, the daemon emits the specified custom event (with the optional message) to the Hub via `POST /v1/events/submit`. The Hub's notification rules route it to the appropriate channels. The daemon never needs to know about channels.

If the top-level `events:` array is present, manifest validation checks that all events referenced in `notify:` blocks appear in it — a typo like `custom.enrichment_failedd` is caught at install time. If `events:` is omitted, no cross-validation occurs and `notify:` references are accepted as-is.

### Agent Event Emission (Runtime)

For dynamic or conditional events that can't be declared statically in YAML, agents emit events at runtime:

**Before (old — channel-based):**
```typescript
ctx.notify("ops", "Enrichment data is stale");
```

**After (new — event-based):**
```typescript
ctx.emit("custom.enrichment_stale", "Enrichment data is stale");
```

The daemon posts the event to the Hub via `POST /v1/events/submit`. The Hub's notification rules route it to the appropriate channels. The daemon never needs to know about channels.

### Two Emission Paths

| Path | Where | When to use |
|------|-------|-------------|
| **Declarative (`notify:` in YAML)** | Phase lifecycle hooks | Predictable events tied to phase success/failure. No agent code needed. |
| **Runtime (`ctx.emit()` in agents)** | Agent execution | Conditional, data-driven, or mid-execution events. Requires agent code. |

Both paths produce identical events that flow through the Hub's rules engine. If declared, the `events:` array should be the union of all custom events a team may emit via either path. If omitted, events are discovered dynamically by the Hub on first occurrence.

### Tiered Inheritance (Replace Semantics)

Three tiers, with the **most specific rule winning** (replace, not additive):

| Tier | Scope | Who sets it | Stored where |
|------|-------|-------------|-------------|
| **Global** | Account | Account owner | `notification_rules` with `realm_id IS NULL` and `team_slug IS NULL` |
| **Realm** | Realm | Realm admin | `notification_rules` with `realm_id` set, `team_slug IS NULL` |
| **Team-in-realm** | Realm × Team | Realm admin (at team install or later) | `notification_rules` with `realm_id` and `team_slug` set |

**Resolution order for a given event + realm + team:**

```
1. Look for a team-in-realm rule (realm_id + team_slug + event)
2. If not found, look for a realm rule (realm_id + event)
3. If not found, look for a global rule (event)
4. If not found, no notification fires
```

The most specific tier wins completely. To silence an event at a given tier, define a rule with no channels — it replaces the parent and delivers nowhere.

**Channels themselves are defined at two tiers only:**

| Tier | Who defines | Purpose |
|------|------------|---------|
| **Global** | Account owner | Shared infrastructure channels (e.g., `#ops-alerts`, `engineering-email`) |
| **Realm** | Realm admin | Realm-specific channels (e.g., `prod-pager`, `staging-slack`) |

Teams don't define channels. Teams declare events. The Hub routes events to channels.

### Channel Composition

A channel's `destinations` array contains typed entries:

```typescript
type Destination =
    | { type: 'email'; address: string; smtp_config?: SmtpConfig }
    | { type: 'slack'; webhook_url: string }
    | { type: 'jira'; url: string; project_key: string; issue_type: string; auth?: JiraAuth }
    | { type: 'http'; url: string; headers?: Record<string, string> }
    | { type: 'channel_ref'; name: string }    // composition
    | { type: 'cliqhub' }                      // in-app notification
```

`channel_ref` enables composition. A channel `"architects-and-designers"` can reference `"architects"` and `"designers"`. Cycles are detected at save time via DFS.

### Event Taxonomy

The Hub catalog types are the single canonical event vocabulary. All daemon-side `on_*` keys are removed.

**System events (closed catalog, extensible via Hub migration):**

| Family | Events |
|--------|--------|
| `run.*` | `run.started`, `run.resumed`, `run.completed`, `run.failed`, `run.crashed`, `run.cancelled` |
| `phase.*` | `phase.started`, `phase.completed`, `phase.failed`, `phase.skipped`, `phase.escalated`, `phase.input_required`, `phase.inputs_supplied`, `phase.timed_out` |
| `hug.*` | `hug.review_requested`, `hug.review_approved`, `hug.review_rejected`, `hug.review_expired` |
| `daemon.*` | `daemon.online`, `daemon.offline`, `daemon.heartbeat_missed` |
| `realm.*` | `realm.member_joined`, `realm.member_left`, `realm.settings_changed` |
| `team.*` | `team.installed`, `team.removed`, `team.updated` |
| `notification.*` | `notification.test`, `notification.failed` *(new)* |
| `custom.*` | *(team-declared, open-ended)* |

**Wildcard selectors in rules:** `run.*` matches all run events. `custom.*` matches all custom events. `*` matches everything.

### `notification.failed` Event

When a channel delivery fails (any provider — Slack, email, webhook):

1. Emit a `notification.failed` system event with payload: `{ original_event, channel_name, provider, error_message }`
2. This event routes through the normal notification rule hierarchy
3. **Guard against recursion:** if a `notification.failed` event itself fails delivery, log it but do not emit another `notification.failed`

This allows operators to route delivery failures to a known-good fallback (e.g., email or in-app).

## Data Model

### Schema Changes (CliqHub PostgreSQL)

**Modify `cliq.notification_channels`:**

```sql
ALTER TABLE cliq.notification_channels
    ADD COLUMN IF NOT EXISTS destinations JSONB NOT NULL DEFAULT '[]';

-- Migrate existing single-provider channels to destinations format:
-- { type: provider, ...JSON.parse(config) }
-- Keep provider and config columns during migration window
```

**New `cliq.notification_rules` table:**

```sql
CREATE TABLE IF NOT EXISTS cliq.notification_rules (
    id          SERIAL PRIMARY KEY,
    realm_id    TEXT REFERENCES cliq.realms(id) ON DELETE CASCADE,
    team_slug   TEXT,
    event       TEXT NOT NULL,           -- catalog type or wildcard (e.g., 'run.*', 'custom.*')
    channel_id  TEXT REFERENCES cliq.notification_channels(id) ON DELETE CASCADE,
    priority    INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),

    UNIQUE NULLS NOT DISTINCT (realm_id, team_slug, event, channel_id)
);

CREATE INDEX idx_notification_rules_realm ON cliq.notification_rules (realm_id);
CREATE INDEX idx_notification_rules_event ON cliq.notification_rules (event);
```

**Tier encoding:**

| Tier | `realm_id` | `team_slug` |
|------|-----------|-------------|
| Global | `NULL` | `NULL` |
| Realm | set | `NULL` |
| Team-in-realm | set | set |

**Relationship to existing `cliq.notification_subscriptions`:**

The `notification_rules` table replaces `notification_subscriptions`. Migration:

1. Create `notification_rules` table
2. Migrate existing subscriptions to rules (account bindings → global rules, realm bindings → realm rules)
3. Update fan-out service to read from `notification_rules` using tiered resolution
4. Deprecate `notification_subscriptions` (keep during rollout)
5. Drop `notification_subscriptions` in a later release

### Daemon-Side Changes

The daemon becomes a pure event emitter:

1. Emit system events to Hub via `POST /v1/events/submit` (already works)
2. Emit custom events to Hub via the same endpoint (new — two paths):
   - **Declarative:** `notify:` blocks on phases trigger custom event emission on lifecycle hooks (daemon handles automatically)
   - **Runtime:** agents call `ctx.emit(event_type, message)` for dynamic/conditional events
3. **Remove** all local channel resolution, `NotificationService.dispatch`, and channel-based delivery
4. **Rewrite** the manifest `notify:` schema — values change from channel names to custom event types (string or `{ event, message }`)
5. **Add** top-level `events:` array to the manifest schema (list of `custom.*` event type strings)
6. **Add** cross-validation: `notify:` references must exist in `events:`
7. **Change** agent protocol: replace `ctx.notify(channel, message)` with `ctx.emit(event_type, message)`

For standalone mode (no Hub), custom events are logged locally but not routed to channels. System events continue to be logged in the run record. A future `~/.cliqrc/rules.json` could provide local routing if needed.

### Manifest Schema Change

**Before (old — `notify:` maps to channel names):**

```yaml
phases:
  - name: enrich
    agent: cursor
    notify:
      on_error: [ops, pager]
      on_complete: done
```

**After (new — `notify:` maps to custom events; top-level `events:` declares the catalog):**

```yaml
events:
  - custom.enrichment_stale
  - custom.enrichment_done

phases:
  - name: enrich
    agent: cursor
    notify:
      on_error:
        event: custom.enrichment_stale
        message: "Enrichment failed on {phase_name}"
      on_complete: custom.enrichment_done
```

The `notify:` block stays, but its values change from channel names to custom event types. Each value is either a string (event type shorthand) or an object `{ event, message }`. The optional top-level `events:` array declares `custom.*` events for Hub discoverability — if present, validation checks that `notify:` references match. System events (`run.*`, `phase.*`) continue to fire automatically and do not need `notify:` entries.

## UX: What Exists Today and What Needs to Be Built

### What Exists Today

The current notification UX lives in three locations:

#### 1. Global Notifications — `Settings > Notifications` tab

**File:** `src/pages/account/notification_settings_page.tsx`

Single-page panel with two wizard flows:

- **Channel list** — flat list of channels (cards), each showing its provider badge (`slack` / `email` / `webhook`), binding count, and inline binding list. Actions per channel: "Bind events", "Remove". Search/filter by name and provider.
- **"Add channel" wizard (Step 1 of 2)** — form: name, provider dropdown, provider-specific config fields (Slack webhook URL, email to/cc/bcc, webhook URL). On save, proceeds to Step 2.
- **"Bind events" wizard (Step 2 of 2)** — event selector dropdown (grouped by family with wildcard support: `run.*`, `phase.*`, etc.), channel selector, realm picker (checkboxes — account-scoped events like `team.*` skip the realm picker). Creates one `notification_subscription` row per event × realm.
- **Orphan bindings section** — shows subscriptions pointing to deleted channels.

The channel model is **single-provider, single-destination**: one channel = one Slack webhook OR one email address OR one HTTP endpoint. No composition.

The binding model is **flat subscriptions**: `(channel_id, event, realm_id?)`. No tiering beyond account vs. realm. No team-level scope.

#### 2. Realm Notifications — `Realm > Settings > Notifications > {Channels, Bindings}`

**File:** `src/pages/account/realm_detail_page.tsx` (subtabs within realm settings)

Two subtabs within realm settings:

- **Channels tab** — shows realm-owned channels + read-only account (global) channels. Same CRUD as global. "CliqHub" in-app provider auto-excluded from display.
- **Bindings tab** — event selector (realm scope only — `run.*`, `phase.*`, `hug.*`, `daemon.*`, `realm.*`), channel selector (union of realm + account channels). Creates subscriptions scoped to this realm.
- **"Reset to global" button** — wipes all realm bindings and re-snapshots from account bindings.

No team-in-realm tier exists. All realm bindings apply to every team in the realm equally.

#### 3. Realm Notification Inbox — `Realm > Notifications`

**File:** `src/pages/account/realm_notifications_inbox.tsx`

Read-only feed of delivered in-app notifications, with faceted filtering (event type, severity, team, phase). This is a consumer of notifications, not a configuration surface.

#### 4. Shared Components

| Component | File | Purpose |
|-----------|------|---------|
| Event selector dropdown | `src/components/event_selector_dropdown.tsx` | Multi-select with grouped events, wildcard toggle, indeterminate checkboxes |
| Event catalog | `src/lib/notification_event_catalog.ts` | Static taxonomy: `REALM_GROUPS` (run, phase, hug, daemon, realm), `ACCOUNT_GROUPS` (team, auth), standalone leaves (`notification.test`). Scope partitioning for binding creation. |
| Channel providers | `src/lib/channel_providers.ts` | Provider metadata (icon, label, description), config form helpers |
| Channel provider form | `src/components/channel_provider_form.tsx` | Shared form fields per provider |

#### 5. Backend Endpoints (Current)

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/notifications/channels/get` | List channels (by account or realm) |
| `POST /v1/notifications/channels/create` | Create channel (name, provider, config) |
| `POST /v1/notifications/channels/remove` | Delete channel |
| `POST /v1/notifications/subscriptions/get` | List subscriptions (by channel or realm) |
| `POST /v1/notifications/subscriptions/create` | Create subscription (channel_id, event, realm_id?) |
| `POST /v1/notifications/subscriptions/remove_binding` | Delete subscription |

### What Needs to Be Built

#### A. Channel UX Changes

**1. Destinations array editor (replaces single-provider model)**

The current "Add channel" form creates a channel with a single provider + config. This needs to become a **destinations list editor**:

- Channel form: name field (unchanged) + destinations list.
- Each destination is a row with a type picker: `slack`, `email`, `webhook`, `http`, `jira`, `channel_ref`, `cliqhub`.
- For `channel_ref`: an autocomplete that searches available channel names (cycle detection on save, with a clear error message).
- "Add destination" button appends a row. Minimum 1 destination per channel. Trash icon per row to remove.
- Provider-specific config fields render inline per row (same fields as today, but per-destination instead of per-channel).

**Reusable:** `channel_providers.ts` metadata, provider config field components. Add `jira`, `http`, and `channel_ref` provider definitions.

**2. Channel composition indicator**

In the channel list, show a small `+N` badge or "composite" tag for channels containing `channel_ref` destinations. On expand, show the full destination list with resolved channel names.

**3. No change to channel tiering**

Channels remain global (account) or realm. No team-level channels. This is correct — channels are infrastructure, not team-specific.

#### B. Rules UX (Replaces "Bind Events")

The current "Bind events" wizard creates flat subscriptions. This is replaced by a **notification rules** table with tiered inheritance.

**1. Global Rules — `Settings > Notifications > Rules` tab**

New tab alongside the existing Channels tab. Replaces the current "Bind events" flow.

| Event | Channel(s) | Actions |
|-------|-----------|---------|
| `run.*` | ops-slack, eng-email | Edit, Remove |
| `phase.escalated` | pager-duty | Edit, Remove |
| `notification.failed` | admin-email | Edit, Remove |

- **"Add rule" button** — opens inline form: event selector (dropdown, same grouped UX), channel multi-select, save.
- **Edit** — inline editable: change event selector or channel list.
- **Remove** — deletes the rule.
- **Filter** — by event family or channel name.

Global rules have no tier indicator — they are the base layer.

**2. Realm Rules — `Realm > Settings > Notifications > Rules` tab**

Shows the **effective rules** for this realm: global rules plus realm overrides.

| Event | Channel(s) | Source | Actions |
|-------|-----------|--------|---------|
| `run.*` | ops-slack, eng-email | 🌐 Global | Override, — |
| `phase.escalated` | prod-pager | 🗺️ Realm | Edit, Remove |
| `custom.enrichment_stale` | data-eng-slack | 🗺️ Realm | Edit, Remove |
| `notification.failed` | admin-email | 🌐 Global | Override, — |

- **Source column:** Globe icon (🌐) for inherited global rules, map icon (🗺️) for realm-level rules. Same icon pattern used in agent settings.
- **"Override" action** on inherited rules — creates a realm-level rule for the same event, pre-populated with the global channels. User can then edit the channel list. Once overridden, the source column flips to 🗺️ Realm.
- **"Remove" on a realm rule** — deletes the realm override; the row reverts to the global rule (or disappears if no global rule exists).
- **"Silence" action** — creates a rule with empty channel list. Shows as "—" or "Silenced" in the Channels column. This is how you suppress an event at the realm level.
- **Custom events section** — events declared in installed team manifests' `events:` arrays appear as available selectors. Grouped under `custom.*` family in the event dropdown.

**3. Team-in-Realm Rules — `Realm > Teams > [team] > Notifications` tab (NEW)**

Does not exist today. New tab on the team detail within a realm.

Shows effective rules for this team in this realm: global → realm → team overrides.

| Event | Channel(s) | Source | Actions |
|-------|-----------|--------|---------|
| `run.*` | ops-slack, eng-email | 🌐 Global | Override |
| `phase.escalated` | prod-pager | 🗺️ Realm | Override |
| `custom.enrichment_stale` | enrichment-alerts | 📦 Team | Edit, Remove |

- **Source column:** Globe (🌐) for global, map (🗺️) for realm, package (📦) for team-in-realm.
- **"Override" action** — creates a team-in-realm rule, copying the parent tier's channels as a starting point.
- **Custom events** — only shows custom events from *this* team's manifest, not all teams. System events are still available since they apply to all teams.
- This view is the most specific tier. Rules set here always win for this team in this realm.

**4. Event Selector Updates**

The existing `notification_event_catalog.ts` has a static taxonomy. Changes needed:

- Add `custom.*` as a group with **dynamic children** populated from two sources: (a) team manifests' `events:` arrays (pre-declared, if present), and (b) custom events the Hub has seen at runtime (dynamically discovered).
- Add `notification.failed` to a new `notification.*` group.
- The event selector dropdown component needs to accept dynamic custom events (passed as props from the parent page, which fetches them from the Hub).
- At the global level, `custom.*` wildcard is available but individual custom events are not (since they're team-specific). At the realm level, custom events from all realm teams are shown (both declared and discovered). At the team level, only that team's custom events are shown.

**5. Rule Creation Flow**

The current two-step wizard (Create channel → Bind events) becomes:

1. **Channels** — same CRUD as today, but with destinations array.
2. **Rules** — separate tab. "Add rule" is a simple inline form (event selector + channel picker + save). No wizard needed.

At team install time, if the team declares `events:`, a prompt could suggest creating rules for those custom events ("This team emits 3 custom events. Configure notifications?"). This is optional and can be deferred.

#### C. Navigation Changes

| Location | Current | v2 |
|----------|---------|-----|
| `Settings > Notifications` | Single page: channels + bindings | Two tabs: **Channels** and **Rules** |
| `Realm > Settings > Notifications > Channels` | Realm channels | Same (with destinations editor) |
| `Realm > Settings > Notifications > Bindings` | Realm bindings | Renamed to **Rules** with tiered display |
| `Realm > Teams > [team]` | No notifications tab | **New Notifications tab** with team-in-realm rules |

The existing `/v1/notifications/subscriptions/*` endpoints are deprecated in favor of `/v1/notifications/rules/*` endpoints. The "Bind events" wizard is removed. The notification inbox (`Realm > Notifications`) is unchanged.

#### D. Summary of Reusable vs. New Components

| Component | Status | Notes |
|-----------|--------|-------|
| `event_selector_dropdown.tsx` | **Extend** | Accept dynamic `custom.*` events as props |
| `notification_event_catalog.ts` | **Extend** | Add `notification.*` group, `custom.*` dynamic group factory |
| `channel_providers.ts` | **Extend** | Add `jira`, `http`, `channel_ref` provider types |
| `channel_provider_form.tsx` | **Extend** | Per-destination-type config fields |
| `notification_settings_page.tsx` | **Rewrite** | Split into Channels tab + Rules tab. Channels get destinations editor. Rules replace bindings. |
| `realm_detail_page.tsx` (notifications section) | **Rewrite** | Channels get destinations editor. Bindings tab → Rules tab with tiered display. |
| `realm_notifications_inbox.tsx` | **Unchanged** | Consumer only, no config changes |
| Team detail notifications tab | **New** | Team-in-realm rules view |
| Destinations list editor | **New** | Inline multi-destination editor with type picker and channel_ref autocomplete |
| Rules table with inheritance | **New** | Table showing effective rules with source icons and override/silence actions |

## Current State (Code Audit)

### cliq (Daemon + SDK)

| Component | File | Status |
|-----------|------|--------|
| **Manifest `notify:` schema** | `daemon/src/core/lib/manifest.ts` ~51–54 | `z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()` — maps lifecycle hooks to **channel names** |
| **Manifest `events:` field** | — | **Does not exist** |
| **Agent `ctx.notify()`** | `sdk/src/agents/base_agent.ts` ~145 | Posts `event_type: 'notification'` with `{ channel, message }` — **dead path** (`EventsController._maybe_notify` ignores this event type) |
| **Agent `ctx.emit()`** | — | **Does not exist** |
| **`dispatch_phase_notify`** | `daemon/src/core/service/run_executor.ts` ~1250–1278 | Reads `phase.notify[event_key]`, emits `phase_notification` via `emit_event`. **Bug:** this event never reaches `NotificationService.dispatch` — channel delivery is broken for manifest-declared notifications |
| **`_dispatch_implicit_notification`** | `daemon/src/core/service/run_executor.ts` ~1284–1306 | Calls `NotificationService.dispatch` directly for error/escalate/input/stuck/timeout — **works** for local channels |
| **`EventsController._maybe_notify`** | `daemon/src/core/controller/events.controller.ts` ~160–224 | Maps stream event types to `on_*` keys, calls `dispatch` + `emit_hub_for_stream_event`. Handles `phase_notification` specially. Does **not** handle `notification` event type |
| **`NotificationService`** | `daemon/src/core/service/notification.service.ts` | Full local delivery: `dispatch()` → subscription matching → `_send_slack/_send_email/_send_webhook/_send_cliqhub`. Also `emit_hub_for_stream_event` and `emit_catalog_event` for Hub forwarding |
| **`DAEMON_TO_HUB_EVENT` mapping** | `daemon/src/core/service/notification.service.ts` ~85–103 | Maps `on_*` keys to Hub catalog types (`run.started`, `phase.completed`, etc.) — the dual-vocabulary bridge |
| **Notification CRUD routes** | `daemon/src/routes.ts` ~135–143 | Full channel + subscription CRUD at `/v1/notifications/*` |
| **SDK repositories** | `sdk/src/repositories/notification_repository.ts` | `NotificationChannelRepository` + `NotificationSubscriptionRepository` — HTTP clients for daemon/Hub notification APIs |
| **Invoke schema** | `sdk/src/protocol/types/schemas.ts` ~626–654 | `notify_channels: Record<string, string \| string[]>` on Invoke payload |

**Known bugs v2 will fix by removal:**
1. Manifest `notify:` channel delivery is broken — `phase_notification` from executor bypasses `dispatch`
2. Agent `ctx.notify` is dead — event type `notification` not handled
3. Dual event vocabulary (`on_*` vs catalog types) adds cognitive overhead

### cliqhub (Hub Backend + Frontend)

| Component | File | Status |
|-----------|------|--------|
| **Channel model** | `services/backend/src/core_api/models/notification_channel.model.ts` | Single-provider: `provider` TEXT + `config` TEXT. **No `destinations` JSONB**, no `channel_ref`, no composition |
| **Subscription model** | `services/backend/src/core_api/models/notification_subscription.model.ts` | Flat: `(realm_id?, channel_id, event, scope)`. **No `team_slug`**, no tiering beyond account/realm |
| **Notification rules table** | — | **Does not exist** |
| **NotificationService** | `services/backend/src/core_api/services/notification.service.ts` | Channel CRUD, subscription CRUD, `ensure_realm_cliqhub_channel`, `snapshot_account_bindings_to_realm`, `reset_realm_bindings_to_account` |
| **Fan-out service** | `services/backend/src/core_api/notifications/fan_out.service.ts` | `notify_realm` / `notify_account`: match subscriptions → dedupe channels → deliver. **No** recursive destination resolution, **no** `notification.failed` emission |
| **Event submission** | `services/backend/src/core_api/events/submit.service.ts` | Validates via closed catalog (`is_event_type`), persists to `cliq.events`, dispatches handler. **Does not accept `custom.*`** |
| **Event types catalog** | `services/backend/src/core_api/events/types.ts` | 36 fixed types. **No `custom.*`**, **no `notification.failed`** |
| **Deliverers** | `services/backend/src/core_api/notifications/deliverers/` | `slack`, `email`, `webhook`, `cliqhub` |
| **Schema migrations** | `services/backend/src/core_api/db/schema_migrations.ts` | `notification_channels` (provider+config), `notification_subscriptions`, `events`, `in_app_notifications`. **No `notification_rules`**, **no `destinations` column** |
| **BFF passthrough** | `services/bff/src/lib/control_plane_routes.ts` ~128–149 | Full channels + subscriptions + events. **No rules endpoints** |
| **Frontend event catalog** | `src/lib/notification_event_catalog.ts` | Static: `run.*`, `phase.*`, `hug.*`, `daemon.*`, `realm.*`, `team.*`, `auth.*`, `notification.test`. **No `custom.*`**, **no `notification.failed`** |
| **Frontend channel providers** | `src/lib/channel_providers.ts` | `slack`, `email`, `webhook`, `cliqhub`. **No `jira`**, **no `http`**, **no `channel_ref`** |
| **Frontend channels UI** | `src/pages/account/notification_settings_page.tsx` | Single-provider channel cards + flat binding wizard. **No destinations editor**, **no rules table** |
| **Frontend realm UI** | `src/pages/account/realm_detail_page.tsx` | Realm bindings + reset-to-global. **No team-in-realm tier** |
| **Team install events:** registration | — | **Does not exist** — manifest `events:` not read at install time |

## Implementation Plan

### Phase 1: Custom Events in Manifest & Agent Protocol (Daemon + SDK)

**Goal:** Change `notify:` semantics from channel names to custom event types; add `events:` declaration; add `ctx.emit()` runtime API.

**Current state:**
- `notify_schema` (~manifest.ts:51–54): `z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()` — keys are lifecycle hooks, values are channel name(s)
- `dispatch_phase_notify` (~run_executor.ts:1250–1278): reads `phase.notify[event_key]`, emits `phase_notification` stream event. Channel delivery is **broken** (never reaches `dispatch`)
- `_dispatch_implicit_notification` (~run_executor.ts:1284–1306): calls `dispatch` directly for error/escalate/etc — only working notify path
- `ctx.notify(channel, message)` (~base_agent.ts:145): posts `event_type: 'notification'` — **dead path** (not handled by `_maybe_notify`)
- `notify_channels` on Invoke payload (~schemas.ts:626–654): `Record<string, string | string[]>`
- `dispatch_notify` (~base_agent.ts:104–111): maps lifecycle events to channels, calls `ctx.notify` per channel
- No `ctx.emit()`, no `manifest_events`, no `EmitEvent` schema, no top-level `events:` field

**Changes:**

- `cliq/daemon/src/core/lib/manifest.ts` — rewrite `notify_schema` (~line 51): values change from channel name strings/arrays to either a string (custom event type) or `{ event: string, message?: string }`. Add top-level `events: z.array(z.string().regex(/^custom\./)).optional()` to `manifest_schema` (~line 104). Add optional cross-validation: if `events:` is present, verify that every event referenced in `notify:` exists in it.
- `cliq/daemon/src/core/service/run_executor.ts` — rewrite `dispatch_phase_notify` (~line 1250): instead of emitting `phase_notification` stream events (broken path), resolve the `notify:` mapping for the current lifecycle hook, extract the event type and optional message, and emit via `emit_catalog_event`. Remove `_dispatch_implicit_notification` (~line 1284) — its Hub forwarding is subsumed by the rewritten `dispatch_phase_notify`. Replace `notify_channels` in invoke payload (~line 703) with `manifest_events` (the declared custom event types) so agents know what they can emit at runtime.
- `cliq/sdk/src/agents/base_agent.ts` — remove `dispatch_notify` (~line 104), `ctx.notify` (~line 145), and `notify_channels` from `BaseContext`; add `ctx.emit(event_type: string, message: string)` that posts `event_type: 'custom_event'` with `{ custom_type, message }` to the daemon events endpoint
- `cliq/sdk/src/agents/types.ts` — remove `notify_channels` from `BaseContext` (~line 63) and `notify` callback (~line 85); add `emit: (event_type: string, message: string) => void`
- `cliq/daemon/src/core/controller/events.controller.ts` — add `custom_event` to `_maybe_notify` (~line 160): forward to Hub via `emit_catalog_event` with `type = payload.custom_type`
- `cliq/sdk/src/protocol/types/schemas.ts` — remove `notify_channels` from `Invoke` (~line 634); add `manifest_events: z.array(z.string()).optional()`; remove `Notify` schema (~line 736); add `EmitEvent` schema
- `cliq/cli/src/cli/lib/manifest_validator.ts` — add validation for `events:` array (must be `custom.*` prefixed strings); if `events:` is present, validate `notify:` block references only declared events

### Phase 2: Channel Composition (Hub backend)

**Goal:** Add `destinations` array to channels; support `channel_ref` type; cycle detection.

**Current state:**
- Channel model (~notification_channel.model.ts:4–44): `provider` TEXT + `config` TEXT (JSON string). Single provider per channel.
- Channel config schemas (~channel_config.ts:10–57): Zod validators for `slack` (webhook_url), `email` (to/cc/bcc), `webhook` (url). No `jira`, `http`, or `channel_ref`.
- Fan-out (~fan_out.service.ts:15–167): flat subscription matching → channel load → provider deliverer. No recursive resolution.
- Deliverers (~deliverers/): `slack.ts`, `email.ts`, `webhook.ts`, `cliqhub.ts`. One per provider.
- Migration (~schema_migrations.ts:57–65, 194–255): `notification_channels` table with `provider` + `config` columns.

**Changes:**

- `cliqhub/services/backend/src/core_api/models/notification_channel.model.ts` — add `destinations` column (JSONB)
- `cliqhub/services/backend/src/core_api/db/schema_migrations.ts` — ALTER TABLE migration to add `destinations`; backfill existing channels: `[{ type: provider, ...JSON.parse(config) }]`
- `cliqhub/services/backend/src/core_api/controllers/notification.controller.ts` (~line 118) — update `channels_create`/`channels_update` to accept `destinations` array; validate `channel_ref` targets exist; DFS cycle detection at save time
- `cliqhub/services/backend/src/core_api/notifications/fan_out.service.ts` (~line 15) — recursive destination resolution with visited-set cycle guard; resolve `channel_ref` entries by loading referenced channels
- `cliqhub/services/backend/src/core_api/notifications/channel_config.ts` — add Zod schemas for `jira`, `http`, and `channel_ref` destination types
- Backward compat: channels without `destinations` fall back to `[{ type: provider, ...JSON.parse(config) }]`

### Phase 3: Notification Rules Table (Hub backend)

**Goal:** Replace subscriptions with tiered rules; implement replace semantics.

**Current state:**
- Subscription model (~notification_subscription.model.ts:4–41): flat `(realm_id?, channel_id, event, scope)`. No `team_slug`, no tiering beyond account/realm.
- NotificationService matching (~notification.service.ts:306–335): `find_matching_for_event({ realm_id, type })` and `find_matching_for_account_event({ type })` using `selectors_matching_event` wildcard expansion.
- Fan-out (~fan_out.service.ts): calls `find_matching_for_event` → dedupe → deliver. No tier resolution.
- Realm lifecycle helpers (~notification.service.ts:527–661): `ensure_default_realm_bindings`, `snapshot_account_bindings_to_realm`, `reset_realm_bindings_to_account`.

**Changes:**

- `cliqhub/services/backend/src/core_api/models/notification_rule.model.ts` — new Sequelize model
- `cliqhub/services/backend/src/core_api/db/schema_migrations.ts` — CREATE TABLE migration
- `cliqhub/services/backend/src/core_api/services/notification.service.ts` — new `resolve_rules(event, realm_id, team_slug)` method implementing the three-tier lookup; replaces `find_matching_for_event` and `find_matching_for_account_event`
- `cliqhub/services/backend/src/core_api/notifications/fan_out.service.ts` — replace subscription matching with rule resolution via `resolve_rules`
- `cliqhub/services/backend/src/core_api/controllers/notification.controller.ts` — CRUD endpoints for rules (`/v1/notifications/rules/list`, `/v1/notifications/rules/set`, `/v1/notifications/rules/remove`)
- `cliqhub/services/backend/src/core_api/routes.ts` — register new rule endpoints
- `cliqhub/services/bff/src/lib/control_plane_routes.ts` (~line 137) — add rule routes to passthrough
- Migration script: convert existing `notification_subscriptions` rows to `notification_rules` (see Data Migration section)

### Phase 4: Custom Event Discovery (Hub backend)

**Goal:** Surface custom event types in the rules UI via two discovery paths: manifest declaration and runtime observation.

**Current state:**
- Event types (~types.ts:7–44): closed catalog of 36 types. `is_event_type()` rejects anything not in the list.
- Submit schema (~submit_schema.ts:27–66): validates `data.type` via `is_event_type` — rejects `custom.*`.
- Event submission (~submit.service.ts:92–157): persists to `cliq.events`, dispatches handler. No custom event handling.
- Team install flow (~dispatch.service.ts): sends manifest to daemon, upserts team row. No `events:` parsing.

**Changes:**

- `cliqhub/services/backend/src/core_api/events/types.ts` — add `custom.*` as a recognized event family; `is_event_type` accepts any string matching `/^custom\./`
- `cliqhub/services/backend/src/core_api/events/submit_schema.ts` (~line 27) — accept `custom.*` event types in the Zod validator
- `cliqhub/services/backend/src/core_api/notifications/handlers/family_handlers.ts` (~line 7) — add `custom.*` handler that routes to `notify_realm` (custom events are realm-scoped)
- New `cliq.custom_events` table — stores discovered custom event types with source (`declared` from manifest `events:` array, or `observed` from runtime emission) and team reference
- Team install flow — on install, if the manifest has an `events:` array, register those types as `declared`
- Event submission handler (~submit.service.ts) — on receiving a `custom.*` event not yet in the table, register it as `observed`
- New endpoint `POST /v1/events/custom/list` — returns all known custom events (declared + observed) for the rules UI; filterable by realm/team

### Phase 5: `notification.failed` Event (Hub)

**Goal:** Emit a system event when channel delivery fails; guard against recursion.

**Current state:**
- Event types catalog (~types.ts:7–44): 36 fixed types. No `notification.failed`.
- Fan-out delivery failures (~fan_out.service.ts:120–160): logged per-channel but not emitted as events.
- Daemon delivery failures (~notification.service.ts:172–185): caught and logged in `_send`, no event emission.

**Changes:**

- `cliqhub/services/backend/src/core_api/events/types.ts` — add `notification.failed` to `EVENT_TYPES` (line ~44)
- `cliqhub/services/backend/src/core_api/notifications/fan_out.service.ts` — on delivery failure (~line 140), call `EventSubmitService.submit({ type: 'notification.failed', ... })` with recursion guard (skip if the failing event is itself `notification.failed`)
- Daemon-side: no changes needed — after Phase 7, the daemon has no local delivery, so all failures occur Hub-side

### Phase 6: Hub Frontend — Channel & Rule Management UI

**Goal:** UX for managing channels and notification rules at each tier.

**Current state:**
- Global channels UI (~notification_settings_page.tsx:943 lines): single-provider channel cards + "Add channel" wizard (name + provider + config) + "Bind events" wizard (event selector + channel picker + realm checkboxes). Calls `/v1/notifications/subscriptions/create`.
- Realm channels UI (~realm_detail_page.tsx): bindings tab with realm event selectors + account channel picker. "Reset to defaults" button (~line 559). No realm-local channel creation.
- Event catalog (~notification_event_catalog.ts): static groups `run.*`, `phase.*`, `hug.*`, `daemon.*`, `realm.*`, `team.*`, `auth.*` + `notification.test` leaf. No `custom.*`, no `notification.failed`.
- Channel providers (~channel_providers.ts): `slack`, `email`, `webhook`, `cliqhub`. No `jira`, `http`, `channel_ref`.
- Event selector (~event_selector_dropdown.tsx): grouped checkbox dropdown with wildcard support. Static groups only.

**Changes:**

**Channels UI:**

- **Global channels** — `Settings > Notifications > Channels` tab. Rewrite channel cards into table with inline destination editing. "Test" button per channel.
- **Realm channels** — `Realm > Notifications > Channels` tab. Same layout; shows realm-specific channels plus read-only inherited global channels.
- **Channel composer** — rewrite "Add channel" wizard: destination list with type picker. `channel_ref` shows an autocomplete of available channel names.
- **Channel test flow** — clicking "Test" on a channel sends a `notification.test` event directly to that channel, bypassing the rules engine entirely. This verifies that the channel's destinations are correctly configured (Slack webhook is valid, email address is reachable, HTTP endpoint responds). The test resolves all destinations including `channel_ref` composition, so it validates the full delivery tree. On success, a brief toast confirms delivery. On failure, the error is shown inline (e.g., "Slack webhook returned 403") and a `notification.failed` event is emitted through the normal rules pipeline so the operator can catch systemic issues. The test button is available on both global and realm channels.
- **Provider updates** — add `jira`, `http`, `channel_ref` to `channel_providers.ts`; add config form fields to `channel_provider_form.tsx`

**Rules UI:**

- **Global rules** — `Settings > Notifications > Rules` tab (replaces "Bind events" wizard). Table: event (or wildcard) → channel(s). Filter by event family.
- **Realm rules** — `Realm > Notifications > Rules` tab (replaces Bindings tab). Shows effective rules (global + realm overrides). Realm-level rules shown with realm icon; inherited global rules shown with globe icon. "Override" action to create a realm-level replacement.
- **Team-in-realm rules** — `Realm > Teams > [team] > Notifications` tab (**new**). Shows effective rules for this team in this realm. Same override UX. Custom events declared in the team manifest appear in the event type picker.
- **Event catalog updates** — add `notification.*` group with `notification.test` + `notification.failed` to `notification_event_catalog.ts`; add `custom.*` dynamic group factory that accepts custom events fetched from `/v1/events/custom/list`; update `event_selector_dropdown.tsx` to accept dynamic custom events as props

### Phase 7: Daemon Cleanup

**Goal:** Remove all legacy channel delivery infrastructure from the daemon. The daemon retains `notify:` block handling (now event-based) and `ctx.emit()` support but sheds all local channel resolution and delivery code.

**Current state:**
- `NotificationService` (~notification.service.ts:1–589): full local delivery with `dispatch()`, `_send_slack()`, `_send_email()`, `_send_webhook()`, `_send_cliqhub()`, plus `DAEMON_TO_HUB_EVENT` mapping (~line 85) and `STREAM_TO_HUB_EVENT` (~line 59)
- `EventsController._maybe_notify` (~events.controller.ts:160–224): maps stream events to `on_*` keys, calls both `dispatch` and `emit_hub_for_stream_event`
- `NotificationController` (~notification.controller.ts:1–143): full channel/subscription CRUD (8 endpoints)
- Daemon routes (~routes.ts:135–143): 8 `/v1/notifications/*` routes
- BFF client stubs (~bff/client.ts:718–770): `NotificationChannelRepository` and `NotificationSubscriptionRepository` return empty lists locally
- SDK repos (~notification_repository.ts:1–128): `NotificationChannelRepository` + `NotificationSubscriptionRepository` HTTP clients

**Changes:**

- `cliq/daemon/src/core/service/notification.service.ts` — remove `dispatch()` (~line 121), `_send()` (~line 172), `_send_slack()` (~line 192), `_send_email()` (~line 473), `_send_webhook()` (~line 243), `_send_cliqhub()` (~line 464), `_format_slack()`, `_format_email_*()`, `_smtp_send()`, `DAEMON_TO_HUB_EVENT` mapping (~line 85). Keep only `emit_hub_for_stream_event()` (~line 274) and `emit_catalog_event()` (~line 303).
- `cliq/daemon/src/core/service/run_executor.ts` — remove `_dispatch_implicit_notification` (~line 1284) (already removed in Phase 1). The rewritten `dispatch_phase_notify` (from Phase 1) that emits custom events stays.
- `cliq/daemon/src/core/controller/events.controller.ts` — simplify `_maybe_notify` (~line 160): remove all `NotificationService.dispatch` calls, keep only `emit_hub_for_stream_event` / `emit_catalog_event` forwarding
- `cliq/daemon/src/core/bff/client.ts` — remove stub `NotificationChannelRepository` and `NotificationSubscriptionRepository` (~line 718)
- `cliq/daemon/src/core/controller/notification.controller.ts` — remove entire file (channel/subscription CRUD endpoints are Hub-only now)
- `cliq/daemon/src/routes.ts` — remove `/notifications/*` routes (~line 135)
- `cliq/sdk/src/repositories/notification_repository.ts` — remove entire file (channels/subscriptions are Hub-managed via UI, not SDK)
- `cliq/sdk/src/repositories/index.ts` — remove notification repo export (~line 13)
- `cliq/sdk/src/repositories/types.ts` — remove notification-related types (~line 200)

### Phase 8: Hub Subscription Cleanup

**Goal:** Remove legacy subscription system.

**Current state:**
- Subscription model (~notification_subscription.model.ts:4–41): `cliq.notification_subscriptions` table
- NotificationService (~notification.service.ts): `create_subscription`, `create_account_subscription`, `find_matching_for_event`, `find_matching_for_account_event`, `ensure_default_realm_bindings`, `snapshot_account_bindings_to_realm`, `reset_realm_bindings_to_account`
- Notification controller (~notification.controller.ts:118–421): `subscriptions_get`, `subscriptions_create`, `subscriptions_remove`, `subscriptions_remove_binding`, `subscriptions_reset_to_global`
- BFF passthrough (~control_plane_routes.ts:137–149): `/v1/notifications/subscriptions/*` routes
- Frontend: all binding creation calls `/v1/notifications/subscriptions/create`

**Changes:**

- Drop `cliq.notification_subscriptions` table (migration)
- Remove subscription model, CRUD methods from `NotificationService` (~line 337–661)
- Remove subscription controller endpoints from `notification.controller.ts`
- Remove subscription BFF passthrough routes
- Remove `provider` and `config` columns from `notification_channels` (replaced by `destinations`)
- Remove legacy `selectors_matching_event` helpers from `NotificationService`
- Clean up frontend: remove all `/v1/notifications/subscriptions/*` calls (replaced by `/v1/notifications/rules/*` in Phase 6)

## Test Coverage

Each phase includes test requirements. Tests marked **[DONE]** have been implemented.

### Phase 1 Tests **[DONE]**

**Daemon — `manifest_notify_v2.spec.ts`:**
- `notify:` accepts `custom.*` string shorthand — **[DONE]**
- `notify:` accepts `{event, message}` object form — **[DONE]**
- `notify:` rejects non-`custom.*` string value — **[DONE]**
- `notify:` rejects object with non-`custom.*` event — **[DONE]**
- Manifest without `notify:` is valid — **[DONE]**
- `events:` array with valid `custom.*` entries — **[DONE]**
- `events:` rejects non-`custom.*` prefix — **[DONE]**
- Manifest without `events:` is valid — **[DONE]**
- Cross-validation passes when `notify:` references declared events — **[DONE]**
- Cross-validation fails when `notify:` references undeclared event — **[DONE]**
- No cross-validation when `events:` is absent — **[DONE]**

**CLI — `manifest_validator.test.ts` (additions):**
- `validate_manifest` accepts valid `custom.*` events array — **[DONE]**
- `validate_manifest` errors on non-`custom.*` events — **[DONE]**
- `validate_manifest` valid when events omitted — **[DONE]**
- `validate_manifest` errors when events is not an array — **[DONE]**
- Notify cross-validation: errors on non-`custom.*` notify value — **[DONE]**
- Notify cross-validation: warns on undeclared event reference — **[DONE]**
- Notify cross-validation: no warning when reference matches — **[DONE]**
- Notify cross-validation: no warning when events is omitted — **[DONE]**
- Notify cross-validation: validates object-form notify entry — **[DONE]**

**SDK — `validators.test.ts` (additions):**
- `EmitEvent` schema accepts valid payload — **[DONE]**
- `EmitEvent` schema accepts optional phase/agent refs — **[DONE]**
- `EmitEvent` rejects missing `custom_type` — **[DONE]**
- `EmitEvent` rejects missing `message` — **[DONE]**
- `EmitEvent` rejects empty `custom_type` — **[DONE]**
- `Invoke` schema accepts `manifest_events` — **[DONE]**
- `Invoke` schema accepts without `manifest_events` (optional) — **[DONE]**
- `Invoke` schema accepts empty `manifest_events` — **[DONE]**
- `emit_event` is in `MESSAGE_TYPES`, `notify` is not — **[DONE]**
- `emit_event` envelope parses as valid `Message` — **[DONE]**

### Phase 2 Tests **[DONE]**

**Hub backend — `channel_config.test.ts` (additions):**
- `destination_schema` accepts each destination type (slack, email, webhook, http, jira, channel_ref, cliqhub) — **[DONE]**
- `destination_schema` rejects unknown type — **[DONE]**
- `destination_schema` rejects slack without `webhook_url` — **[DONE]**
- `destination_schema` rejects email without `address` — **[DONE]**
- `destination_schema` rejects jira without `project_key` — **[DONE]**
- `destinations_array_schema` accepts single destination — **[DONE]**
- `destinations_array_schema` accepts mixed types — **[DONE]**
- `destinations_array_schema` rejects empty array — **[DONE]**
- `parse_destinations` validates and returns typed — **[DONE]**
- `parse_destinations` throws on invalid input — **[DONE]**

### Phase 3 Tests **[DONE]**

**Hub backend — `rules.test.ts`:**
- `resolve_rules` returns empty when no rules exist — **[DONE]**
- `resolve_rules` resolves global rules when no realm/team — **[DONE]**
- Realm rules replace global rules (replace semantics) — **[DONE]**
- Team-in-realm rules replace realm rules — **[DONE]**
- Falls back to realm when team has no matching rule — **[DONE]**
- Falls back to global when realm has no matching rule — **[DONE]**
- Matches exact event type — **[DONE]**
- Matches wildcard selector for event family (e.g. `phase.*`) — **[DONE]**
- Matches global wildcard `*` — **[DONE]**
- Deduplicates channel IDs — **[DONE]**
- Returns multiple channels from same tier — **[DONE]**

### Phase 4 Tests **[DONE]**

**Hub backend — `custom_events.test.ts`:**
- `is_event_type` accepts `custom.*` strings — **[DONE]**
- `is_event_type` rejects bare `custom.` (no suffix) — **[DONE]**
- `is_event_type` rejects non-custom unknown types — **[DONE]**
- `submit_schema` validates `custom.*` event types with `realm_id` — **[DONE]**
- `submit_schema` rejects `custom.*` without `realm_id` — **[DONE]**
- `submit_schema` still rejects unknown types — **[DONE]**
- `required_fields_for` requires `realm_id` for `custom.*` family — **[DONE]**
- `create_handler_for_type` returns `CustomEventHandler` for `custom.*` — **[DONE]**
- `get_notification_handler` resolves `custom.*` dynamically — **[DONE]**
- `get_notification_handler` still works for cataloged types — **[DONE]**
- `CustomEventService.register_declared` inserts new declared events — **[DONE]**
- `CustomEventService.register_declared` is idempotent — **[DONE]**
- `CustomEventService.register_declared` upgrades `observed` to `declared` — **[DONE]**
- `CustomEventService.register_declared` ignores non-custom.* events — **[DONE]**
- `CustomEventService.register_observed` inserts new observed event — **[DONE]**
- `CustomEventService.register_observed` no-op when already exists — **[DONE]**
- `CustomEventService.register_observed` ignores non-custom.* types — **[DONE]**
- `CustomEventService.list` returns sorted events — **[DONE]**
- `CustomEventService.list` returns empty when none — **[DONE]**
- `CustomEventService.remove_declared_for_team` removes declared entries — **[DONE]**

### Phase 5 Tests **[DONE]**

**Hub backend — `notification_failed.test.ts`:**
- `notification.failed` is in `EVENT_TYPES` — **[DONE]**
- `notification.failed` recognized by `is_event_type` — **[DONE]**
- `notification.failed` has `error` severity — **[DONE]**
- `notification.*` is in `EVENT_GROUPS` — **[DONE]**
- `notification.*` group contains `notification.test` and `notification.failed` — **[DONE]**
- `notification` alias resolves to `notification.*` — **[DONE]**
- `is_valid_event_selector` accepts `notification.*` — **[DONE]**
- `expand_event_selector` expands `notification.*` — **[DONE]**
- `create_handler_for_type` returns `NotificationFailedHandler` — **[DONE]**
- `get_notification_handler` returns `NotificationFailedHandler` — **[DONE]**
- Recursion guard: structural verification that `notification.failed` flows through fan-out and guard prevents re-emission — **[DONE]**

### Phase 6 Tests

**Hub frontend — component tests (Vitest + React Testing Library):**
- Channel table renders destinations correctly
- Channel "Test" button triggers `notification.test` event
- Rule table renders tiered rules with correct icons (globe/realm)
- Rule "Override" creates realm-level rule replacing global
- Event selector includes `custom.*` events fetched from API
- `notification.failed` appears in event catalog

### Phase 7 Tests

**Daemon — `notification_cleanup.spec.ts`:**
- `NotificationService` no longer exposes `dispatch()`, `_send_slack()`, `_send_email()`, `_send_webhook()`
- `EventsController._maybe_notify` does not call `NotificationService.dispatch`
- Daemon routes do not include `/v1/notifications/*` paths
- SDK does not export `NotificationChannelRepository` or `NotificationSubscriptionRepository`

### Phase 8 Tests

**Hub backend — `subscription_cleanup.test.ts`:**
- `notification_subscriptions` table does not exist after migration
- `NotificationService` does not expose subscription CRUD methods
- `/v1/notifications/subscriptions/*` routes return 404
- `fan_out.service.ts` has no subscription fallback code path

---

## Migration Strategy

### Breaking Changes

- **Manifest `notify:` values** — change from channel names to custom event types. `notify: { on_error: ops }` becomes `notify: { on_error: custom.my_error }` or `notify: { on_error: { event: custom.my_error, message: "..." } }`. An optional top-level `events:` array can declare custom events for discoverability. Existing manifests referencing channel names will fail validation.
- **Agent `ctx.notify(channel, message)`** — removed. Agents must use `ctx.emit(event_type, message)`.
- **Daemon notification channel/subscription CRUD** — removed. All channel and rule management moves to the Hub UI.

### Data Migration (Phase 3)

```sql
-- Account subscriptions → global rules
INSERT INTO cliq.notification_rules (realm_id, team_slug, event, channel_id)
SELECT NULL, NULL, event, channel_id
FROM cliq.notification_subscriptions
WHERE realm_id IS NULL;

-- Realm subscriptions → realm rules
INSERT INTO cliq.notification_rules (realm_id, team_slug, event, channel_id)
SELECT realm_id, NULL, event, channel_id
FROM cliq.notification_subscriptions
WHERE realm_id IS NOT NULL;
```

## Open Questions

1. **Rate limiting / digest mode.** Should notification rules support a "digest" option that batches events over a time window? Deferred — can be added later as a rule option without schema changes.

2. **Delivery retry.** Currently fire-and-forget. Should we add a delivery queue with retry? The `notification.failed` event provides observability; a retry queue adds complexity. Deferred.

3. **Per-destination templating.** Different providers need different payload formats (Slack blocks vs. email HTML vs. Jira structured fields). The existing per-provider formatters in Hub deliverers handle this. A user-configurable template system could come later.

4. **Standalone daemon notifications.** Without Hub enrollment, custom events are logged locally but not routed. A future `~/.cliqrc/rules.json` could provide local routing if needed. System events remain in the run record regardless.

5. **Custom event cleanup.** Custom events are discovered from manifest `events:` arrays (optional) and runtime observation. When a team is removed, its custom events and any associated rules are cleaned up automatically. The custom event catalog always reflects the current roster of installed teams.
