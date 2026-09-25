# SLICE: Daemons explicit `org_id` + drop header tenancy (DAE-ORG)

**Status:** in progress on branch `slice/daemons-explicit-org-id`  
**Rule:** hard-cut — org-scoped `POST /v1/daemons/get` never invents from `X-Org-Id` / `current_org_id`  
**Depends on:** RUN-ORG / REV-ORG patterns

## Architecture

1. **Needed?** Yes — `DaemonController.get` uses `req.user.current_org_id`.
2. **Merged?** No new endpoints.
3. **Model?** Body `org_id` required unless `realm_id`. Register/heartbeat/get_by_id/remove unchanged (daemon-token or id-keyed).
4. **Hard-cut?** Yes.

### Callers needing `org_id`

| Caller | Action |
|--------|--------|
| SPA admin `daemons_page` | Add `org_id` |
| SPA `hub_activity_context` daemons probe | Add `org_id` |
| Realm-scoped callers | Already pass `realm_id` — no change |

## Checklist

- [ ] Core schema + controller + unit test
- [ ] SPA admin + hub_activity
- [ ] OpenAPI + suites + push
