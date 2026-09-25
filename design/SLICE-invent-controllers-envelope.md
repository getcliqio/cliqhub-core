# Umbrella: Invent controllers → `{ ok, data }` envelope (ENV)

**Status:** In progress — **TEL-ENV done** (2026-09-25); next DASH-ENV  
**Depends on:** Invent org_id hard-cuts + structure S0 (TEL/DASH/DAE/REV/RUN MVC) — done  
**Sibling (separate):** Realms **RM-ENV** (same envelope rules; not in this umbrella)  
**Out of scope:** HDR-1; LogsController / RunEventStreamController; new endpoints; path renames

## Architecture answers (mandatory before impl)

1. **Is this endpoint needed?** No new endpoints. Existing invent paths only — change **response payload shape**.
2. **Can it be merged?** Do **not** fold create/get/list into fewer paths. One resource per ENV slice; one envelope rule for all of them.
3. **Does it match the model?** Core owns wire `{ ok, data }`. BFF **passthrough** (no second wrap — see `hub_passthrough.ts`). SPA unwraps via `hub_envelope` (`hub_payload` / `hub_list`). Daemon/CLI parse Core (or BFF-forwarded Core) bodies — must move to `data` in the **same** slice as Core.
4. **Hard-cut vs shim?** **Hard-cut on Core** — no dual shapes (`{ ok, runs }` **and** `{ ok, data }`). Same rule as Agents / Notifications ENV. SPA may keep `hub_list`/`hub_payload` flat fallbacks only as deploy safety; Core tests must assert `data` only.

## Goal

Bring TEL / DASH / DAE / REV / RUN success payloads to **Agents / Notifications parity**:

| Concern | Target |
|---------|--------|
| Success | `{ ok: true, data: T }` via `BaseController.ok` |
| Error | `{ ok: false, error: { code, message } }` via `error_handler` |
| List | `data: T[]` **or** `data: PagedData<T>` (`items`, `total`, `offset`, `limit`) — reuse platform `PagedData`; never invent `*ListData` |
| One entity | `data: T` (one Zod `*Data` for list and get) |
| Mutations with no entity | `data: BooleanData` (or small result DTO when fields are required, e.g. `{ count }`) |
| Request Zod | `schemas/<resource>/inputs.ts` — every field `.describe` |
| Response Zod | `schemas/<resource>/data.ts` — every field `.describe` |
| Controller | `ApiRequest` / `ApiOkResponse` (drop `FlatApi*`); JSDoc on every public handler |
| Routes | Unchanged paths; still `c.wrap(c.method)` / `with_dedup(c.wrap(…))` |
| Docs | Regenerate Hub OpenAPI + Mintlify in the **same** session (`docs-must-update-on-push`) |

Parity references:

- Controllers: `AgentsController`, `NotificationsController`
- Design: [`SLICE-agents-api-dto-envelope.md`](./SLICE-agents-api-dto-envelope.md), [`SLICE-notifications-api-dto-envelope.md`](./SLICE-notifications-api-dto-envelope.md)
- Rules: `hub-core-api-standards`, `backend-mvc-layers`, `architecture-endpoints-before-impl`, `endpoint-cli-contract-tests`, `verify-before-claiming-fixed`, `docs-must-update-on-push`

## Why separate from structure S0

S0 moved BaseController + request Zod and **kept flat wire**. ENV is a **wire break** — daemon outbox, SPA, BFF e2e, and OpenAPI must move with Core. Splitting kept invent/structure diffs reviewable; payload parity was incomplete until this umbrella.

## Slice order (smallest blast → largest)

| # | Slice | Controller | Paths | Relative wire risk |
|---|-------|------------|-------|--------------------|
| 1 | **TEL-ENV** | `TelemetryController` | `/v1/runs/report_telemetry`, `/v1/runs/get_telemetry` | Medium — daemon outbox + SPA usage |
| 2 | **DASH-ENV** | `DashboardController` | `/internal/dashboard/summary`, `/internal/dashboard/realms` | Medium — SPA home; BFF may proxy |
| 3 | **DAE-ENV** | `DaemonController` | `/v1/daemons/*` | High — enroll/heartbeat/register |
| 4 | **REV-ENV** | `ReviewsController` | `/v1/reviews/*` | High — SPA + hug/daemon |
| 5 | **RUN-ENV** ✅ | `RunController` | `/v1/runs/*` (excl. logs/telemetry/stream) | **Done** — `slice/runs-envelope` |

Do **not** start the next ENV slice until the previous slice’s verifying suites are green across **every** changed repo.

## GitNexus (baseline 2026-09-25 — index may be stale; re-run at slice start)

| Symbol | Graph risk | Note |
|--------|------------|------|
| `TelemetryController` | HIGH (BaseController interface floor) | Path grep SoT |
| `DashboardController` | HIGH (interface floor) | Path grep SoT |
| `DaemonController` | LOW (5 upstream) | **Under-count** — daemon enroll is critical |
| `ReviewsController` | LOW (5 upstream) | **Under-count** — SPA + hug |
| `RunController` | LOW (5 upstream) | **Under-count** — largest wire surface |

`api_impact` on Express controller files often returns empty — **do not trust empty**. Mandatory SoT for each slice:

1. `impact` on controller symbol (reindex if stale).
2. Path-string greps in **cliqhub-core**, **cliqhub-bff**, **cliqhub-frontend**, **cliq-platform**, **documentation**.
3. List every daemon `fetch(\`${api_url}/v1/...\`)` / outbox path and every SPA `hub_payload` / flat key reader.

## Cross-repo blast (path greps — lower bound)

| Repo | Role in ENV |
|------|-------------|
| **cliqhub-core** | Envelope cut, Zod `data.ts`, JSDoc, unit/integration tests, OpenAPI generators |
| **cliqhub-bff** | Passthrough only (no re-wrap). Update e2e assertions that read flat keys. Dashboard controller if it shapes responses. |
| **cliqhub-frontend** | Switch readers to `hub_payload` / `hub_list` / `data.items`. Prefer hard preference for `data`; keep flat fallback only if needed for mixed deploy. |
| **cliq-platform** | Daemon outbox + hub mirror + CLI paths that parse run/daemon/review/telemetry bodies — **contract tests required**. |
| **documentation** | Regenerate OpenAPI (`scripts/generate_hub_openapi.py` or current SoT) + Mintlify pages; **commit + push** same session. |

## Per-slice checklist (mandatory)

1. **Architecture** — reaffirm the four answers above; cite this umbrella.
2. **GitNexus + path greps** — record results in the slice doc before coding.
3. **Core** — `data.ts` + `.describe` on all input **and** response fields; `this.ok`; JSDoc every handler; drop `FlatApi*`; early returns / no `else`; snake_case.
4. **Callers** — every repo that parses the response in the **same** change set (no “SPA later”).
5. **Docs** — OpenAPI regen + push `documentation/`.
6. **Verify** (print `EXIT:$?`):
   - Core `npm test`
   - BFF `npm test` + `npm run test:e2e`
   - SPA `npm test`
   - Platform `npm run test:all` (+ daemon contract / live smoke when enroll/outbox touched)
7. **Branch** — `slice/<resource>-envelope` (or continue from invent tip); push all touched repos.

## Envelope map (target shapes)

### TEL-ENV

| Path | Today (flat) | After `data` |
|------|--------------|--------------|
| `report_telemetry` (ack) | `{ ok: true }` / `{ ok, inserted, received }` | `BooleanData` or `TelemetryReportData` |
| `get_telemetry` spans | `{ ok, spans }` | `TelemetrySpanData[]` |
| `get_telemetry` summary | `{ ok, …summary fields }` | `TelemetrySummaryData` |

### DASH-ENV

| Path | Today | After |
|------|-------|-------|
| `summary` | flat rollup fields | `DashboardSummaryData` |
| `realms` | `{ realms, totals }` | `DashboardRealmsData` (`{ realms, totals }` **inside** `data`) |

### DAE-ENV

| Path | Today | After |
|------|-------|-------|
| `get` | `{ daemons }` / similar | `DaemonData[]` or paged if applicable |
| `get_by_id` / register result | `{ daemon }` | `DaemonData` |
| heartbeat / deregister / ack | `{ ok: true }` | `BooleanData` |

### REV-ENV

| Path | Today | After |
|------|-------|-------|
| list / get | often `{ ok, data }` already (inconsistent) | Canonical `ReviewData` / `ReviewData[]` via `this.ok` + Zod `data.ts` |
| messages | `{ ok, data: { messages } }` | Prefer `ReviewMessageData[]` or `{ messages }` **inside** one DTO — one clear shape |
| mutations | mixed | `ReviewData` / `BooleanData` |

### RUN-ENV

| Path | Today | After |
|------|-------|-------|
| `get` (paged) | `{ ok, runs, total, offset, limit }` | `PagedData<RunData>` |
| `get` (keyed lists) | `{ ok, runs }` | `RunData[]` |
| `get_by_id` | `{ ok, run }` | `RunData` |
| create | `{ ok, run_id }` | small `RunCreateData` or `RunData` |
| complete / update_status / … | `{ ok: true }` | `BooleanData` |
| claim / queue | `{ ok, item }` | typed queue DTO in `data` |
| events / artifacts lists | `{ ok, events }` / `{ ok, artifacts }` | `T[]` or `PagedData<T>` |

## Non-goals

- Do not invent or rename paths.
- Do not cut Logs / stream / Realms in these slices (Realms = **RM-ENV** separately).
- Do not leave Core green while SPA/daemon still expect flat keys.
- Do not add Core aliases for flat keys “for compatibility.”

## Design docs

- [`SLICE-TEL-ENV-telemetry-envelope.md`](./SLICE-TEL-ENV-telemetry-envelope.md)
- [`SLICE-DASH-ENV-dashboard-envelope.md`](./SLICE-DASH-ENV-dashboard-envelope.md)
- [`SLICE-DAE-ENV-daemons-envelope.md`](./SLICE-DAE-ENV-daemons-envelope.md)
- [`SLICE-REV-ENV-reviews-envelope.md`](./SLICE-REV-ENV-reviews-envelope.md)
- [`SLICE-RUN-ENV-runs-envelope.md`](./SLICE-RUN-ENV-runs-envelope.md)

## Also finish with ENV (standards debt from S0)

Each ENV slice **must** close S0 gaps for that resource:

- JSDoc on every public handler
- `.describe` on every Zod input **and** response field
- OpenAPI / Mintlify regenerated and pushed
