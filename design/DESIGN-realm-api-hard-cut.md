# Realm API hard-cut (complete)

> Status: **done** (2026-09). No backward-compat aliases.

## Locked public surface

| Resource | Endpoints |
|----------|-----------|
| Realms | `create`, `get`, `get_by_id`, `update`, `delete`, `get_members`, `add_member`, `remove_member`, `add_team`, `remove_team` |
| Realm A2A admin | `POST /v1/realms/a2a` `{ action, realm_id, … }` |
| A2A bearer | `POST /v1/auth/generate_token` / `rotate_token` `{ type: 'a2a', realm_id }` |
| Invite search | `POST /v1/users/get` `{ realm_id, query }` |
| Team roster / coverage | `POST /v1/teams/get` `{ realm_id, … }` |

`get_by_id` accepts `realm_id` **or** `{ slug, org_slug? }` (service still has `get_by_slug`; there is **no** HTTP `get_by_slug`).

## Removed

`get_by_slug`, `grant`, `revoke`, `search_users`, `members/add|remove`, `teams/get` under realms, all `team-list/*`, `a2a/*` subpaths including `rotate_bearer`.

## Fan-out

`add_team` / `remove_team` update realm `team_list` JSONB and enqueue install/uninstall via outbox (`RealmTeamListService.sync_team`).

## Checklist

- [x] Core routes + controllers
- [x] BFF passthrough + teams/users `realm_id` + auth `type=a2a`
- [x] SPA callers
- [x] Backend / BFF unit / SPA / BFF Playwright e2e green
- [x] OpenAPI + Mintlify guides updated
