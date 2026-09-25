# SLICE: Notifications / channels / rules / webhooks hard-cut

**Status:** done — hard-cut landed; suites green; docs pushed  
**Rule:** hard-cut only — **no aliases**. Hub flat `/v1/resource/action`.

## Architecture answers

1. **Needed?** Yes — existing surface is over-split and mis-tagged; not new product.
2. **Merged?** Yes — rules → org/realm; deliveries → channels; drop unused verbs.
3. **Model?** Channels = config; Notifications = delivered inbox; Rules = org/realm routing; Webhook = channel type (not a resource).
4. **Hard-cut?** Yes — update all callers in the same PR set; no dual paths.

---

## Locked end-state

### `notification_channels` (config)

| Method | Path |
|--------|------|
| POST | `/v1/notification_channels/get` |
| POST | `/v1/notification_channels/create` |
| POST | `/v1/notification_channels/update` |
| POST | `/v1/notification_channels/remove` |
| POST | `/v1/notification_channels/test` |

**Drop:** `get_by_id`, `get_by_name`, `rotate-secret`, `get_deliveries`, nested `/notifications/channels/*`, `/webhooks/*`.

### Rules — folded into org / realm (not a separate resource)

| Scope | Paths |
|-------|--------|
| Org defaults | `POST /v1/orgs/get_notification_rules` · `set_notification_rule` · `remove_notification_rule` |
| Realm (+ optional `team_slug`) | `POST /v1/realms/get_notification_rules` · `set_notification_rule` · `remove_notification_rule` |

**Drop:** `/v1/notifications/rules/*`.

### `notifications` (inbox only)

| Method | Path |
|--------|------|
| POST | `/v1/notifications/get` |

**Drop:** `list`, `hug_pending` (sidebar uses `reviews/get` + `total`).

### Unchanged

- `POST /v1/integrations/jira/rotate_secret` (and other Jira integration routes)

---

## Micro-slices (implement in order)

### Slice A — Channels rename + drop dead endpoints
- Routes/controller/schemas → `notification_channels/*`
- Delete get_by_id, get_by_name, rotate-secret handlers
- SPA settings page + BFF allowlist + tests
- Regen OpenAPI (partial OK until all slices land)

### Slice B — Drop deliveries list API
- Hard-cut `get_deliveries` (was temporarily under channels); no Hub/Forge delivery audit UI
- Webhook attempt rows may still be recorded for ops/retention — not exposed on `/v1`

### Slice C — Rules → orgs + realms
- Move list/set/remove onto OrgsController + RealmController (or thin wrappers calling NotificationService)
- Org tier: no realm_id; Realm tier: realm_id from body + optional team_slug
- SPA Rules_tab: org vs realm fetch paths
- Delete `/notifications/rules/*`

### Slice D — Inbox + drop hug_pending
- `notifications/list` → `notifications/get`
- Remove hug_pending route; update `use_sidebar_badges` + `events_page` to `reviews/get` with limit 1 / total
- Tests

### Slice E — Docs + full verify
- OpenAPI tag map: Notification channels / Organizations / Realms / Notifications; drop Webhooks (or empty)
- Mintlify MDX overviews; push `documentation` origin/main
- Backend + BFF unit + BFF e2e + SPA — all EXIT 0

---

## Done means

Every changed package green; docs pushed; no old path strings in SPA/BFF/daemon/Forge Hub clients.
