# SLICE: Reviews API flat hard-cut

**Status:** locked for implementation  
**Rule:** hard-cut only — **no aliases**, no dual paths, no “compat” shims.  
**Naming:** Hub flat `/v1/resource/action` (same as `runs/get` + `runs/get_by_id`). **No** nested `/reviews/messages/*`.

---

## 1. Locked endpoint set

### Keep / rename

| Method | Path | Role | Was |
|--------|------|------|-----|
| POST | `/v1/reviews/get` | List + filters (inbox) | `/v1/reviews/pending` |
| POST | `/v1/reviews/get_by_id` | Single review (SPA + agent poll) | `/v1/reviews/get` |
| POST | `/v1/reviews/create` | Daemon/agent opens review | same |
| POST | `/v1/reviews/verdict` | Human state transition (not a chat message) | same |
| POST | `/v1/reviews/ack` | Daemon confirms consumed verdict | same |
| POST | `/v1/reviews/get_messages` | Chat history | `/v1/reviews/messages/get` |
| POST | `/v1/reviews/send_message` | Human **or** agent message (speaker from auth) | `messages/send` + `messages/agent` |
| GET | `/v1/reviews/stream_messages` | SSE (like `runs/stream`) | `/v1/reviews/messages/stream` |

Adjacent (moved): `POST /v1/orgs/get_reviewable_targets` — Organizations resource (not Reviews).

### Drop (delete routes, OpenAPI, BFF allowlist, tests)

| Path | Reason |
|------|--------|
| `/v1/reviews/remind` | Hub sweep owns reminders |
| `/v1/reviews/typing` | No callers |
| `/v1/reviews/tokens/run` | Compat leftover; no callers |
| `/v1/reviews/claim` | Auto-claim on first human `send_message` |
| `/v1/reviews/unclaim` | Same; remove SPA claim/release buttons |
| `/v1/reviews/pending` | Folded into `get` |
| `/v1/reviews/messages/*` | Flattened |

### Explicit non-goals

- Do **not** fold `verdict` into `send_message` (different auth, policy, status→decided, daemon push).
- Do **not** merge list `get` and `get_by_id` into one handler.
- Do **not** add `/reviews/update` in this slice (claim UI goes away; revisit later if needed).
- Do **not** change notification inbox `/v1/notifications/hug_pending` (sidebar badge).

---

## 2. Semantics

### `POST /v1/reviews/get` (list)

Body (Zod): same fields as today’s `pending_schema`:

```ts
{
  realm_id?: string,
  statuses?: string[],   // default ['pending']
  limit?: number,
  offset?: number,
}
```

Response shape: unchanged from today’s pending list DTO.

### `POST /v1/reviews/get_by_id`

Body: `{ review_id: string }`.  
Response: today’s detail DTO (`ReviewDto` including `claimed_by`, `message_count`, …).

### `POST /v1/reviews/send_message` (unified)

| Auth | Behavior |
|------|----------|
| Session / user PAT | Today’s `send_user_message` (auto-claim if unclaimed; reject if claimed by other) |
| Daemon token | Today’s `send_agent_message` (requires `daemon_id` in body or from auth context) |

Zod (discriminated by auth in controller, one schema with optional fields):

```ts
{
  review_id: string,
  text: string,           // 1..10000
  daemon_id?: string,     // required when auth_via === daemon_token
}
```

### `POST /v1/reviews/verdict`

Unchanged body/behavior. Remains the only way to decide a review.

### Remind → Hub sweep (replaces HTTP)

1. **Create:** accept optional `remind_every_minutes: number` (or parse duration string once in controller). Persist on review row (new column) or in `payload`/`policy` JSON — prefer **column** `remind_every_minutes INTEGER NULL` for sweep queries.
2. **Agent:** stop calling `/remind`; pass `remind_every` on `create` (from team `review.remind_every`).
3. **Hub:** extend `review_expiry_sweep` (or sibling `review_remind_sweep`) every ~60s:
   - pending reviews where `remind_every_minutes > 0`
   - and `last_reminded_at` is null → first remind after create + interval, or
   - `now - last_reminded_at >= remind_every_minutes`
   - reuse `HugReviewsService.remind(review_id)` internals (extract shared emit; delete HTTP handler)
4. Keep existing guards (skip if run not running/awaiting_input).

Default if omitted: null → no Hub reminders (agent no longer drives them).

---

## 3. Zod / MVC layout

**Move** all review request schemas out of the controller into:

`cliqhub/services/backend/src/schemas/reviews_schemas.ts`

Export:

- `reviews_get_schema` (list)
- `reviews_get_by_id_schema`
- `reviews_create_schema` (+ `remind_every_minutes` optional)
- `reviews_verdict_schema`
- `reviews_ack_schema`
- `reviews_get_messages_schema`
- `reviews_send_message_schema`
- `reviews_stream_messages_query_schema` (querystring)
- `reviewable_targets_schema` (can stay or move; same file OK)

Controller: parse only; services unchanged except send_message dispatch + remind sweep.

OpenAPI generator already reads routes + Zod — regen after route rename.

---

## 4. Auth allowlists

### `daemon_token_gate.ts`

**Allow:**

- `/v1/reviews/create`
- `/v1/reviews/get_by_id`
- `/v1/reviews/ack`
- `/v1/reviews/send_message`

**Remove:** `remind`, old `get`, `messages/agent`.

**Do not allow:** `get` (list), `verdict`, `get_messages`, `stream_messages` (human/session).

### BFF `control_plane_routes.ts`

Replace reviews block with the keep set (POST paths).  
`app.ts`: change SSE proxy from `/v1/reviews/messages/stream` → `/v1/reviews/stream_messages`.

---

## 5. Callers to update (wire)

| Repo / package | File(s) | Change |
|----------------|---------|--------|
| cliqhub SPA | `reviews_page.tsx` | `pending` → `get` |
| cliqhub SPA | `review_detail_page.tsx` | `get` → `get_by_id`; `messages/get` → `get_messages` |
| cliqhub SPA | `review_chat_panel.tsx` | `get_messages`, `send_message`, EventSource `stream_messages` |
| cliqhub SPA | `review_claim_banner.tsx` | **Remove** claim/unclaim actions; show read-only “Claimed by …” from `get_by_id` (or delete banner if redundant with chat panel) |
| cliqhub SPA tests | `__tests__/reviews_*.tsx`, `review_chat_*.tsx`, `review_claim_*.tsx`, `review_detail_*.tsx` | Path strings + drop claim POST expectations |
| cliq-agents/hug | `index.ts` | `get`→`get_by_id`; remove `send_remind` + remind loop; pass `remind_every_minutes` on create; keep `ack`/`create` |
| cliq-agents/hug | rebuild `agent.js` if that’s the shipped artifact | Same |
| cliq-platform SDK | `sdk/src/agents/human_input.ts` | create path unchanged; if it ever polls Hub get, use `get_by_id` |
| cliq-platform daemon | `hug.controller.ts` | outbox `/v1/reviews/send_message` (body: review_id, daemon_id, text) |
| Bundled agents | Only if they hardcode Hub get/remind (HUG agent); SDK-inlined create stays `/create` | Rebuild/publish agent pack as needed |

---

## 6. Documentation (same session — must push)

| Artifact | Action |
|----------|--------|
| `documentation/scripts/generate_hub_openapi.py` | Tag map still `^/v1/reviews/` — OK |
| Regenerate | `python3 scripts/generate_hub_openapi.py` + `sync_hub_api_nav.py` |
| `openapi/hub-by-tag/hub-reviews.yaml` | Derived — only new paths |
| `hub-api/reviews.mdx` | Overview: list vs get_by_id; verdict ≠ message; Hub-owned remind |
| `docs.json` | Only if nav groups change |
| Design mirrors | Update `DESIGN-hug-protocol-modes.md` path table to locked set (mark old nested paths obsolete) — optional but preferred so design doesn’t lie |
| Push | `documentation` → `origin/main` (Mintlify) |

---

## 7. Implementation order

1. **Schemas + migration** — `reviews_schemas.ts`; column `remind_every_minutes`; create accepts it.
2. **Services** — unify send dispatch; extract remind emit for sweep; extend sweep.
3. **Routes + controller** — register locked paths only; delete dropped handlers.
4. **daemon_token_gate + BFF allowlist + SSE path.**
5. **SPA** — paths + claim UI hard-cut.
6. **Daemon outbox + HUG agent** — paths + drop remind loop + pass remind_every on create.
7. **Tests** (below).
8. **OpenAPI regen + docs push.**
9. **Rebuild backend `dist/`** before final verify.
10. Commit/push product repos only when asked (docs push required by workspace rule).

---

## 8. Testing matrix (Done = all green this turn)

### Backend (`cliqhub/services/backend`)

| Suite / file | Updates |
|--------------|---------|
| `tests/migrated_platform/reviews_pending.test.ts` | Hit `/v1/reviews/get`; rename describe |
| `tests/migrated_platform/review_messages.test.ts` | `get_messages` / `send_message`; drop claim/unclaim HTTP tests; keep auto-claim on send; daemon send via same path |
| New or extend | `review_remind_sweep` unit/integration: create with `remind_every_minutes`, advance time / call sweep tick → `hug.review_reminded` + `last_reminded_at` |
| `daemon_token_gate.test.ts` | Allow `get_by_id`, `send_message`; deny list `get`, `verdict`; no `remind` |
| `platform_route_inventory.test.ts` | Expect new paths; no pending/messages/* |
| Full | `npm test` → `BACKEND_EXIT:0` |

### BFF (`cliqhub/services/bff`)

| Suite | Updates |
|-------|---------|
| `route_surface_audit` / allowlist | New paths present; dropped absent |
| `app` stream proxy | If covered, assert `stream_messages` |
| Full | `npm test` → `BFF_UNIT_EXIT:0` |
| Full | `npm run test:e2e` → `BFF_E2E_EXIT:0` (even if no reviews e2e, suite must stay green) |

### SPA (`cliqhub`)

| Suite | Updates |
|-------|---------|
| `reviews_page.test.tsx` | `/v1/reviews/get` |
| `review_detail_chat_mode.test.tsx` | `get_by_id`, `get_messages` |
| `review_chat_panel.test.tsx` | `send_message` / stream URL |
| `review_claim_banner.test.tsx` | Rewrite for read-only claim state **or** delete with component |
| Full | `npm test` → `SPA_EXIT:0` |

### CLI / daemon contract (required — endpoint↔daemon rule)

| Proof | How |
|-------|-----|
| Daemon outbox path | Unit/integration: `hug.controller` enqueues `/v1/reviews/send_message` |
| HUG agent | Unit or recorded: create uses `/create` with `remind_every_minutes`; poll uses `/get_by_id`; **no** `/remind`; ack still `/ack` |
| Live smoke (if env available) | `cliq` enroll → run HUG gate → Hub inbox shows review; message round-trip; no remind 404s in daemon logs |

Print `EXIT:$?` for every suite. Do not claim Done with any failure deferred.

---

## 9. Acceptance checklist

- [ ] Only locked routes registered under `/v1/reviews/*`
- [ ] Zod in `schemas/reviews_schemas.ts`; OpenAPI matches
- [ ] No `/remind`, `/typing`, `/tokens/run`, `/claim`, `/unclaim`, `/pending`, `/messages/*`
- [ ] List = `get`, detail = `get_by_id`
- [ ] Human + agent chat = one `send_message`
- [ ] Verdict remains separate
- [ ] Hub remind sweep works without agent HTTP
- [ ] SPA claim buttons gone; auto-claim still works
- [ ] Docs regenerated and **pushed** to `documentation` `origin/main`
- [ ] Backend + BFF unit + BFF e2e + SPA tests all exit 0
- [ ] Daemon/agent path strings updated and covered by at least one automated test

---

## 10. Architecture answers (locked)

1. **Needed?** Yes — rename/fold existing product surface; not new product.
2. **Merged?** Yes — pending→get; messages→flat; send+agent→send_message; remind→sweep.
3. **Model?** Session/SPA vs daemon_token allowlist; BFF passthrough only for locked paths.
4. **Hard-cut?** Yes — delete old paths in the same PR; update all callers together.
