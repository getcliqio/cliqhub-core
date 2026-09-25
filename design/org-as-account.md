# Org-as-Account: Unified Organization Model

## Status: Draft

## Summary

Promote organizations from a team-publishing grouping mechanism to the
**primary unit of ownership** for all CliqHub resources. Every user
operates in the context of exactly one org at a time. The personal org
(created at signup, `slug === username`) provides the solo-user experience
with no "organization" language visible. Shared orgs (`@acme`) provide
multi-user collaboration with admin-provisioned permissions.

---

## Motivation

Today, resources are scattered across inconsistent ownership models:

| Resource              | Currently scoped to                        |
|-----------------------|--------------------------------------------|
| Agent settings        | `user_id` (personal)                       |
| Notification channels | Global (`realm_id IS NULL`) or per-realm   |
| Notification rules    | Global / realm / team-in-realm             |
| Scopes & teams        | Per-org (via scope membership)             |
| Realms                | Per-user (`owner_user_id`) + realm_members |

This creates real problems:

- **No shared credentials.** If an `@acme` admin configures an OpenAI key,
  teammates don't inherit it. Each user must configure their own.
- **No shared channels.** A Slack channel configured by one user is invisible
  to their teammate's realms.
- **Ambiguous "account" tier.** The global notification tier (`realm_id IS NULL`)
  has no org affiliation — it's per-user in agent settings but truly global
  in channels.
- **Realm ownership is personal.** Realms are user-owned, shared via manual
  `realm_members` management. If the owner leaves the company, the realm
  is orphaned.

---

## Design

### Core Principle

**An org is an account.** Everything a user does — creating realms, configuring
channels, setting agent credentials, running teams — happens within the context
of an org. The personal org makes this invisible to solo users.

### Resource Ownership

After this change, every resource has a clear owner:

| Resource              | Owner     | Key                                  |
|-----------------------|-----------|--------------------------------------|
| Realms                | Org       | `realm.org_id` (new FK)              |
| Notification channels | Org or Realm | `channel.org_id` or `channel.realm_id` |
| Notification rules    | Org, Realm, or Team-in-Realm | Tiered: org → realm → team |
| Agent settings        | Org or Realm | `org_id` replaces `user_id`       |
| Scopes & teams        | Org       | Unchanged (`scope.org_id`)           |
| Daemons               | Realm     | Unchanged (enrolled into realm)      |
| Runs                  | Realm     | Unchanged                            |

### Inheritance Chain

```
Org defaults → Realm overrides → Team-in-realm overrides
```

- **Channels:** Org-level channels are available to all realms in the org.
  Realm-level channels are scoped to that realm. Same as today's
  global → realm model, but "global" becomes "org."
- **Notification rules:** Three tiers with replace semantics (unchanged).
  Org tier replaces the current "global" tier.
- **Agent settings:** Org provides defaults. Realm can override per-agent-key.
  No per-user override within an org (simplifies sharing; users who want
  personal keys use their personal org).

### Org Context

A user always operates within exactly one org. The org context determines:

- Which realms are visible
- Which channels, rules, and agent settings apply
- Which scopes are available for team publishing
- Which members are visible for collaboration

**Switching orgs** changes the entire view — like switching Slack workspaces.
A realm created in `@acme` is never visible when operating in `@myname`.

### Personal Org UX

The personal org (`slug === username`) is the default context after login.
The UI **never uses the word "organization"** for personal orgs:

- Header shows the user's display name / avatar, not "org: alice"
- Settings page says "Settings", not "Organization Settings"
- The org switcher only appears when the user belongs to multiple orgs
- When it does appear, the personal org is labeled with the user's name,
  shared orgs use their display name

Solo users who never join a shared org will never encounter org concepts.

---

## Permission Model

### Architecture: Permissions + Roles

Instead of a fixed role hierarchy, CliqHub uses a **permission vocabulary**
with **customizable roles**:

1. **Permissions** are atomic capabilities (e.g., `teams.run`, `channels.manage`).
2. **Roles** are named bundles of permissions, defined per-org.
3. **Default roles** ship preconfigured but can be edited by admins.
4. **Custom roles** can be created by admins for org-specific needs.

This gives admins full control over who can do what, without forcing
every org into the same operator-vs-member split.

### Permission Vocabulary

Every gateable action maps to exactly one permission. Permissions are
grouped by domain for readability but are flat strings in the system.

#### Org Management

| Permission              | Description                              |
|-------------------------|------------------------------------------|
| `org.settings`          | Update org name, logo, settings          |
| `org.members.manage`    | Add/remove members, set roles, invite    |
| `org.scopes.manage`     | Create/delete publishing scopes, assign scope members |
| `org.delete`            | Delete the org (owner-only, cannot be assigned to roles) |
| `org.transfer`          | Transfer ownership (owner-only, cannot be assigned to roles) |

#### Realm Lifecycle

| Permission              | Description                              |
|-------------------------|------------------------------------------|
| `realms.create`         | Create new realms in the org             |
| `realms.delete`         | Delete realms                            |
| `realms.update`         | Update realm name, settings, description |
| `realms.members.manage` | Manage realm-level access restrictions   |
| `realms.teams.manage`   | Add/remove teams from realm roster       |
| `realms.view`           | View realm details and members           |

#### Daemon & Infrastructure

| Permission              | Description                              |
|-------------------------|------------------------------------------|
| `daemons.enroll`        | Enroll new daemons into realms           |
| `daemons.remove`        | Remove daemons from realms               |
| `daemons.view`          | View daemon list and status              |
| `tokens.manage`         | Create/revoke realm and daemon tokens    |
| `dispatch_keys.manage`  | Rotate dispatch key pairs                |

#### Team Execution

| Permission              | Description                              |
|-------------------------|------------------------------------------|
| `teams.run`             | Dispatch / run teams on daemons          |
| `teams.cancel`          | Cancel in-progress runs                  |
| `teams.inputs`          | Supply human inputs to running teams     |
| `teams.install`         | Install / uninstall teams on daemons     |
| `runs.view`             | View runs, logs, and artifacts           |

#### Publishing

| Permission              | Description                              |
|-------------------------|------------------------------------------|
| `teams.publish`         | Publish / update teams to org scopes     |
| `teams.publish.delete`  | Delete published teams or versions       |
| `teams.catalog.view`    | Browse the team catalog                  |

#### Notification Configuration

| Permission              | Description                              |
|-------------------------|------------------------------------------|
| `channels.manage`       | Create/edit/delete org-level channels    |
| `channels.manage.realm` | Create/edit/delete realm-level channels  |
| `channels.test`         | Send test notifications to channels      |
| `rules.manage`          | Configure org-level notification rules   |
| `rules.manage.realm`    | Configure realm and team-in-realm rules  |
| `inbox.view`            | View notification inbox                  |

#### Agent Configuration

| Permission              | Description                              |
|-------------------------|------------------------------------------|
| `agents.manage`         | Set org-level agent credentials          |
| `agents.manage.realm`   | Set realm-level agent credentials        |
| `agents.view`           | View agent configuration (masked values) |
| `agents.reveal`         | Reveal plaintext credential values       |

#### HUG Reviews

| Permission              | Description                              |
|-------------------------|------------------------------------------|
| `reviews.verdict`       | Submit approval/rejection verdicts       |
| `reviews.view`          | View pending reviews                     |

### Default Roles

Four roles ship out of the box. Admins can rename them, change their
permissions, or delete non-system roles.

#### `owner` (system — not editable, not deletable)

The org creator. Exactly one per org. Has **all permissions** implicitly,
including `org.delete` and `org.transfer` which cannot be assigned to
any other role. For personal orgs, this is always the user.

Ownership is transferred explicitly, not by role assignment.

#### `admin` (default — editable)

Full operational control. Default permissions: **all permissions except
`org.delete` and `org.transfer`**.

Intended for: org co-admins, team leads.

#### `operator` (default — editable)

Day-to-day execution and realm management. Default permissions:

| Granted                    | Not granted                    |
|----------------------------|--------------------------------|
| `realms.view`              | `org.settings`                 |
| `realms.teams.manage`      | `org.members.manage`           |
| `daemons.enroll`           | `org.scopes.manage`            |
| `daemons.view`             | `realms.create`                |
| `teams.run`                | `realms.delete`                |
| `teams.cancel`             | `realms.update`                |
| `teams.inputs`             | `realms.members.manage`        |
| `teams.install`            | `daemons.remove`               |
| `teams.publish`            | `tokens.manage`                |
| `teams.catalog.view`       | `dispatch_keys.manage`         |
| `runs.view`                | `teams.publish.delete`         |
| `rules.manage.realm`       | `channels.manage`              |
| `inbox.view`               | `channels.test`                |
| `reviews.verdict`          | `rules.manage`                 |
| `reviews.view`             | `agents.manage`                |
| `agents.view`              | `agents.reveal`                |
| `channels.manage.realm`    |                                |
| `agents.manage.realm`      |                                |

Intended for: engineers who run and configure teams but don't manage
org infrastructure.

#### `member` (default — editable)

Read-only access. Default permissions:

- `realms.view`
- `daemons.view`
- `runs.view`
- `teams.catalog.view`
- `inbox.view`
- `reviews.view`
- `agents.view`

Intended for: stakeholders, auditors, new team members during onboarding.

### Custom Roles

Admins can create custom roles with any subset of permissions (except
`org.delete` and `org.transfer`). Examples:

- **`deployer`** — `teams.install` + `teams.run` + `daemons.enroll` +
  `runs.view` + `daemons.view` + `realms.view`
- **`notification-admin`** — `channels.manage` + `channels.manage.realm` +
  `channels.test` + `rules.manage` + `rules.manage.realm` + `inbox.view` +
  `realms.view`
- **`publisher`** — `teams.publish` + `teams.publish.delete` +
  `teams.catalog.view` + `realms.view`

### Role Data Model

```sql
CREATE TABLE org_roles (
    id          SERIAL PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES orgs(id),
    slug        TEXT NOT NULL,              -- e.g. 'admin', 'operator', 'deployer'
    name        TEXT NOT NULL,              -- display name, e.g. 'Deployer'
    permissions TEXT[] NOT NULL DEFAULT '{}', -- array of permission strings
    is_system   BOOLEAN NOT NULL DEFAULT FALSE, -- true for 'owner'; cannot be deleted
    is_default  BOOLEAN NOT NULL DEFAULT FALSE, -- true for the 4 shipped roles
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, slug)
);
```

`org_members.role` changes from a string to a FK into `org_roles`:

```sql
ALTER TABLE org_members ADD COLUMN role_id INTEGER REFERENCES org_roles(id);
```

### Permission Check Flow

```
request → resolve org_id → load member's role_id → load role.permissions
  → if 'owner' role: allow everything
  → else: check required permission ∈ role.permissions
  → if site admin: allow everything (bypass)
```

Single helper: `require_permission(org_id, user_id, permission)`.

### Personal Org Behavior

The personal org has the four default roles, but only the owner exists
as a member. The role editor is hidden in the personal org UI — solo
users don't need to think about permissions. If they later invite
someone to their personal org (promoting it to a shared org), the
role management UI appears.

---

## Data Model Changes

### New / Modified Tables

```sql
-- Customizable roles per org
CREATE TABLE org_roles (
    id          SERIAL PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES orgs(id),
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    permissions TEXT[] NOT NULL DEFAULT '{}',
    is_system   BOOLEAN NOT NULL DEFAULT FALSE,
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, slug)
);

-- Switch org_members.role from string to FK
ALTER TABLE org_members ADD COLUMN role_id INTEGER REFERENCES org_roles(id);

-- Add org_id FK to realms (replaces owner_user_id as primary ownership)
ALTER TABLE cliq.realms ADD COLUMN org_id INTEGER REFERENCES public.orgs(id);

-- Org-scoped agent settings (replaces account_agent_settings)
CREATE TABLE org_agent_settings (
    org_id      INTEGER NOT NULL REFERENCES orgs(id),
    agent_name  TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_by  INTEGER REFERENCES users(id),
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (org_id, agent_name, setting_key)
);

-- Realm agent settings: replace user_id with org_id context
-- (realm already implies org, but we keep the key for the override pattern)
ALTER TABLE cliq.realm_agent_settings ADD COLUMN org_id INTEGER REFERENCES orgs(id);

-- Notification channels: add org_id for org-level channels
ALTER TABLE cliq.notification_channels ADD COLUMN org_id INTEGER REFERENCES orgs(id);
-- Existing realm_id channels remain unchanged (realm implies org).
-- "Global" channels (realm_id IS NULL) become org-scoped (org_id set).

-- Notification rules: add org_id for org-level rules
ALTER TABLE cliq.notification_rules ADD COLUMN org_id INTEGER REFERENCES orgs(id);
-- Existing realm_id rules remain unchanged.
-- "Global" rules (realm_id IS NULL) become org-scoped (org_id set).
```

### Dropped Columns (after migration)

```sql
-- realm.owner_user_id → replaced by realm.org_id
-- account_agent_settings table → replaced by org_agent_settings
-- realm_agent_settings.user_id → replaced by org_id (or dropped entirely)
-- org_members.role (string) → replaced by org_members.role_id (FK)
```

### Unchanged Tables

- `orgs`, `org_members` — unchanged structure, just used more broadly
- `scopes`, `scope_members` — unchanged (already org-scoped)
- `teams`, `team_versions` — unchanged
- `runs`, `run_events`, `run_logs` — unchanged (realm-scoped)
- `daemons`, `daemon_config` — unchanged (realm-scoped)
- `notification_subscriptions` — already removed (Phase 8)

---

## UI Changes

### Org Switcher

- Appears in the header/sidebar only when user belongs to 2+ orgs
- Personal org labeled with user's display name and avatar
- Shared orgs labeled with org display name
- Switching orgs navigates to that org's default realm (or dashboard)
- Current org context persisted in URL path prefix or session state

### Navigation Structure

**Personal org (solo user — no org switcher visible):**

```
[User avatar + name]
├── Dashboard
├── Realms
│   └── {realm} → Runs, Teams, Daemons, Agents, Channels, Notifications, Settings
├── Settings
│   ├── Channels          (org-level channels — labeled "Your channels")
│   ├── Notifications     (org-level rules — labeled "Default notifications")
│   ├── Agents            (org-level credentials — labeled "Agent credentials")
│   └── Profile           (username, email, password)
├── Teams                 (team catalog / publishing)
└── Organizations         (only visible if user is in 2+ orgs)
```

**Shared org (`@acme`):**

```
[Acme logo + name] [switcher ▾]
├── Dashboard
├── Realms
│   └── {realm} → Runs, Teams, Daemons, Agents, Channels, Notifications, Settings
├── Settings
│   ├── Channels          (org-level channels)
│   ├── Notifications     (org-level default rules)
│   ├── Agents            (org-level shared credentials)
│   ├── Members           (org member management — admin only)
│   ├── Roles             (role editor — admin only)
│   └── Scopes            (publishing scopes — admin only)
├── Teams                 (org's team catalog)
```

### Role Management UI

The **Roles** page (visible to users with `org.members.manage`) shows
a table of all roles in the org:

| Name       | Members | Actions        |
|------------|---------|----------------|
| Owner      | 1       | —              |
| Admin      | 3       | Edit           |
| Operator   | 12      | Edit, Delete   |
| Member     | 5       | Edit, Delete   |
| Deployer   | 2       | Edit, Delete   |

Expanding a role shows the permission editor: a grouped checklist of
all permissions. The grouping mirrors the permission vocabulary sections
(Org, Realm, Daemon, Execution, etc.).

**Creating new roles — "Save" vs "Save As New Role":**

When editing any role's permissions, the footer shows two buttons:

- **Save** — overwrites the current role's permissions in place.
- **Save As New Role** — prompts for a name, then creates a new role
  with the modified permission set. The original role is unchanged.

This means role creation is always a fork of an existing role. There is
no blank "New Role" form — you start from the closest match and adjust.

**Constraints:**

- The `owner` row is read-only (all permissions, not editable).
- Default roles (`admin`, `operator`, `member`) can be edited but not
  deleted.
- Custom roles can be edited and deleted. Deleting a role that still
  has members assigned prompts to reassign them first.
- When assigning a member, the role dropdown shows all available roles.

The role editor is hidden for personal orgs unless the user has invited
at least one other member.

### Relabeling

| Current label               | New label (personal org)    | New label (shared org) |
|-----------------------------|-----------------------------|------------------------|
| "Account Settings"          | "Settings"                  | "Settings"             |
| "Global Channels"           | "Your channels"             | "Channels"             |
| "Global Notifications"      | "Default notifications"     | "Default notifications"|
| "Account Agent Settings"    | "Agent credentials"         | "Agent credentials"    |
| "Organizations" page        | Hidden (1 org) / "Switch"   | Org switcher           |

---

## Implementation Plan

### Phase 1: Schema & Migration

**Goal:** Add `org_id` columns, create `org_roles` table, backfill from
existing data, maintain backward compatibility during transition.

1. Create `org_roles` table.
2. Seed default roles (`owner`, `admin`, `operator`, `member`) for every
   existing org, with the permission sets defined above.
3. Add `role_id` column to `org_members` (nullable initially).
4. Backfill `role_id`: map existing `role = 'admin'` → admin role,
   `role = 'member'` → member role. Map org creators → owner role.
5. Add `org_id` column to `cliq.realms` (nullable initially).
6. Add `org_id` column to `cliq.notification_channels` (nullable initially).
7. Add `org_id` column to `cliq.notification_rules` (nullable initially).
8. Create `org_agent_settings` table.
9. Write migration to backfill:
   - `realm.org_id` from `realm.owner_user_id` → user's personal org id.
     For realms whose slug starts with an org slug, resolve to that org.
   - `notification_channels.org_id` from null → channel creator's personal
     org (or resolve from realm's org for realm-scoped channels).
   - `notification_rules.org_id` from null → rule creator's personal org.
   - Copy `account_agent_settings` rows into `org_agent_settings` keyed
     by user's personal org id.
   - Copy `realm_agent_settings` rows, resolving `org_id` from the realm.
10. Add NOT NULL constraint to `realm.org_id` after backfill.
11. Add NOT NULL constraint to `org_members.role_id` after backfill.
12. Add foreign key indexes.

**Tests:** Migration is idempotent; verify all existing realms get an
org_id; verify agent settings are preserved; verify every org has four
default roles; verify every member has a role_id.

### Phase 2: Backend — Org Context on APIs

**Goal:** All resource APIs accept and enforce org context.

1. Add `org_id` to the auth context (`AuthContext.current_org_id`),
   resolved from request header or session.
2. Update `RealmService.create` to require `org_id` instead of
   `owner_user_id`. Realm slug validation: must match org slug prefix.
3. Update `NotificationService` channel/rule methods to filter by `org_id`
   instead of the "account" (`realm_id IS NULL`) pattern.
4. Create `OrgAgentSettingService` (replaces `AccountAgentSettingService`).
5. Update `RealmAgentSettingService` to resolve org defaults from
   `org_agent_settings` instead of `account_agent_settings`.
6. Update all "list" endpoints (realms, channels, rules, runs, daemons)
   to filter by the current org context.
7. Ensure realm membership is derived from org membership by default
   (all org members can access all org realms unless restricted).

**Tests:** Verify org isolation — resources from org A are invisible
when querying in org B context.

### Phase 3: Permission Enforcement

**Goal:** Implement the permission-based authorization model with
customizable roles.

1. Create `OrgRoleService` with CRUD for roles:
   - `create_role(org_id, slug, name, permissions)` — validate permission
     strings against the vocabulary; reject `org.delete` and `org.transfer`.
   - `update_role(org_id, role_id, { name?, permissions? })` — block
     editing the `owner` system role.
   - `delete_role(org_id, role_id)` — block deleting system roles or
     roles still assigned to members.
   - `list_roles(org_id)` — return all roles for the org.
   - `seed_defaults(org_id)` — create the four default roles for a new org.
2. Create `require_permission(org_id, user_id, permission)` helper:
   - Load member's `role_id` → load `org_roles.permissions`.
   - If role is `owner` (system): allow everything.
   - If site admin: allow everything (bypass).
   - Otherwise: check `permission ∈ role.permissions`.
3. Ensure new orgs get default roles seeded on creation.
4. Update every endpoint gate to use `require_permission`:
   - Replace `require_account_notification_admin` → `require_permission(org_id, user_id, 'rules.manage')`.
   - Replace `require_realm_notification_admin` → `require_permission(org_id, user_id, 'rules.manage.realm')`.
   - Replace `RealmService.require_admin` → `require_permission(org_id, user_id, ...)` with
     the specific permission for each action (e.g., `realms.update`, `realms.delete`,
     `realms.members.manage`).
   - Replace `_require_org_admin` → `require_permission(org_id, user_id, 'org.members.manage')`
     or whichever specific permission applies.
5. Add role management API endpoints:
   - `GET    /v1/orgs/:id/roles` — list roles (any member).
   - `POST   /v1/orgs/:id/roles` — create role (requires `org.members.manage`).
   - `PUT    /v1/orgs/:id/roles/:role_id` — update role (requires `org.members.manage`).
   - `DELETE /v1/orgs/:id/roles/:role_id` — delete role (requires `org.members.manage`).
   - `GET    /v1/permissions` — list the full permission vocabulary (public).
6. Update member management to assign `role_id` instead of string role.
7. Update token grant model: daemon tokens scoped to org + realm.
8. Plug auth gaps identified in the audit (run get_by_id, secrets,
   control-plane team writes, HUG verdict — all need org membership checks).

**Tests:** For each default role, verify allowed and denied actions.
Test custom role with a subset of permissions. Test that personal org
owner can do everything. Test that editing the owner role is rejected.
Test that deleting an assigned role is rejected.

### Phase 4: Frontend — Org Switcher & Context

**Goal:** Add org context to the frontend; relabel UI; build role editor.

1. Add org switcher component to the header. Hidden for single-org users.
2. Store current org context in URL path or React context; persist across
   navigation.
3. Update all API calls to include org context (header or body param).
4. Update the "Account" page → "Settings" with org-scoped content.
5. Update realm list page to filter by current org.
6. Update dashboard to scope to current org's realms.
7. Relabel as described in the UI Changes section.
8. Hide "Organizations" page; replace with org switcher + org settings
   within the current org context.
9. Build the **Roles** settings page:
   - Role table with expand-to-edit.
   - Permission checklist editor grouped by domain.
   - "Save" (overwrite) and "Save As New Role" (fork) buttons.
   - Delete action with reassignment prompt if role has members.
   - Role assignment dropdown in the member management UI.
   - Hidden for personal orgs with a single member.
10. Update the member invite/add flow to assign a role (defaulting
    to `member`).

**Tests:** Visual regression; verify solo user never sees org language;
verify multi-org user sees correct data after switching; verify role
editor CRUD.

### Phase 5: Migration Cleanup

**Goal:** Remove legacy ownership model.

1. Drop `realm.owner_user_id` column (after confirming `org_id` is
   fully populated and all code uses it).
2. Drop `account_agent_settings` table (replaced by `org_agent_settings`).
3. Drop `realm_agent_settings.user_id` column.
4. Remove `AccountAgentSettingService` and its routes.
5. Remove "account" tier language from notification service
   (`is_account_event_selector`, account-specific helpers).
6. Remove legacy `LEGACY_TAB_PATH` redirects from `realm_detail_page.tsx`.
7. Clean up `migrate_account_owned_realms.ts` (no longer needed after
   org_id is the canonical owner).

**Tests:** Full regression suite; verify no references to dropped columns.

### Phase 6: Org → Realm Membership Model

**Goal:** Define the relationship between org membership and realm access.

**Principle:** Realm membership is always explicit. Adding a user to an
org does NOT automatically grant them access to any realm. The org
controls *who you are* (billing, credentials, roles); the realm controls
*where you work* (daemons, teams, runs). Org membership is a
prerequisite for realm access — you cannot join an org's realm without
being in the org — but it is not sufficient.

1. When a user is added to an org → they gain eligibility to be added
   to org realms but receive no realm access by default. The admin
   assigns realm membership explicitly (per-realm or bulk "add to all").
2. When a user is removed from an org → cascade-revoke their membership
   from all org realms (cannot be in a realm without being in the org).
   Skip realms the user owns (personal defaults).
3. Org role changes do NOT propagate to realm roles. Realm roles are
   managed independently — an org admin is not necessarily a realm admin.
4. A convenience bulk action ("add member to all org realms") exists as
   an explicit admin opt-in, not a default.
5. New realm creation does NOT auto-grant access to existing org members.
   The creator is the only initial member (admin).

**Tests:** Remove user from org → verify realm access revoked across all
org realms. Add user to org → verify NO realm access granted. Bulk-add
to all realms → verify explicit grant works.

---

## Backward Compatibility

- **API:** During transition (Phases 1-2), endpoints accept both the old
  pattern (no org context, infer from user) and the new pattern (explicit
  org_id). After Phase 5, old pattern is removed.
- **Daemon tokens:** Existing daemon tokens continue to work — they're
  realm-scoped, and realm.org_id is backfilled. No daemon-side changes.
- **CLI (`cliq`):** No changes needed. The daemon authenticates with a
  realm token, which resolves to the realm's org automatically.
- **Existing data:** All existing resources are migrated to the user's
  personal org. No data loss. Multi-org users may need to manually
  reassign realms to shared orgs if they were previously personal.

---

## Decisions

1. **Org billing:** Deferred. The `owner` role is reserved for it.
2. **Cross-org visibility:** No. Orgs are fully isolated. Cross-org
   resource copying may be added later, but shared visibility is out
   of scope to avoid breaking the permission model.
3. **Realm transfer:** Out of scope. Not an architectural concern.
4. **Personal org deletion:** Impossible. Tied to user account lifecycle.
5. **Permission granularity:** Start with ~30 permissions; subdivide
   as needs arise. Adding finer-grained permissions is backward
   compatible (existing roles keep working).
6. **Shared org creation:** Admin-provisioned only in v1. Realm
   membership already provides invite-based collaboration for casual
   use. Shared orgs serve real organizations that need centralized
   infrastructure (credentials, channels, scopes, roles). Self-service
   org creation can be added later without architectural changes.
