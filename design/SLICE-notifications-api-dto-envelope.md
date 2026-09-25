# SLICE: Notifications API `{ ok, data }` DTO hard-cut

**Status:** done — Core + SPA + docs + BFF unit + BFF e2e green  
**Depends on:** `SLICE-notifications-api-flat-hard-cut.md` (paths locked — **no path changes**)  
**Authorized by:** `SLICE-agents-api-dto-envelope.md` §6 (notifications next)  
**Rule:** hard-cut envelope only — **no** dual shapes (`channels` / `data` aliases).

## Architecture answers

1. **Needed?** Yes — align with Hub `{ ok, data }` + agents coding standards. Paths already correct.
2. **Merged?** No new endpoints. Rules stay on orgs/realms routes; same controller methods.
3. **Model?** Channels / Rules / Inbox remain three concerns; one DTO each.
4. **Hard-cut?** Yes — Core + SPA (`cliqhub-frontend`) + BFF e2e in same change set.

## Envelope map

| Path | Today (flat) | After |
|------|----------------|-------|
| `notification_channels/get` | `{ channels }` | `data: NotificationChannelData[]` |
| `…/create` · `…/update` | `{ channel }` | `data: NotificationChannelData` |
| `…/remove` | `{ removed }` | `data: BooleanData` |
| `…/test` | `{ delivered, errors }` | `data: NotificationChannelTestData` |
| `orgs|realms/*_notification_rule(s)` | `{ rules }` / `{ rule }` / `{ removed }` | `NotificationRuleData[]` / `NotificationRuleData` / `BooleanData` |
| `notifications/get` | `{ notifications, total, offset, limit }` | `data: PagedData<NotificationData>` |

## Types (reuse / OO)

- One `NotificationChannelData`, `NotificationRuleData`, `NotificationData` — list = `T[]`, one = `T`.
- Reuse `BooleanData` for remove.
- Reuse platform `PagedData<T>` for inbox (not `NotificationListData`).
- `NotificationChannelTestData = { delivered: number; errors: string[] }` — one test result type (not parallel top-level keys).

## Controller

- `NotificationsController` extends `BaseController`; instance async methods; routes `controller.wrap(…)`.
- PascalCase Zod `*Input` in `schemas/notifications/inputs.ts`; DTOs in `data.ts`.

## Callers

- Core migrated tests asserting `body.channels` / `body.notifications` → `body.data`.
- SPA: `cliqhub-frontend` notification settings + events/sidebar (and monorepo mirror if still used).
- Docs/OpenAPI source lines when regenerated.

## Non-goals

- No path renames / no re-opening flat-cut slice.
- No `ChannelGetData` / `ChannelListData` / `*RemovalResult`.
- Do not fold rules onto a new `/notification_rules` resource.
