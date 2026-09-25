# DESIGN: Runs logs + telemetry (no action mega-endpoints)

> **Status:** Logs + telemetry hard-cut under Runs (no root `/v1/logs` / `/v1/telemetry`, no `{ action }`).  
> **Rule:** Hard cut, no aliases. Hub + BFF + SPA + daemon (+ CLI if local paths move) + OpenAPI + full suites + `dist/` + docs push.

## Architecture answers

1. **Needed?** Yes — run-scoped append/get for logs and report/get for telemetry.
2. **Merge?** No action mega-endpoints. Telemetry subtypes via `kind` on two verbs only.
3. **Model?** Under **Runs** (not root Logs/Telemetry resources). Hub `/v1/events` unchanged (notifications). Live activity stays `report_activity` + `stream`.
4. **Hard cut?** Yes. Hub + platform same-day for outbox URL changes.

---

## Locked path map

### `/v1/runs` — lifecycle, control, status, artifacts, live stream, logs, telemetry

| Path | Who | Body notes |
|------|-----|------------|
| `get`, `get_by_id` | SPA | |
| `create`, `complete` | Daemon | |
| `resume` (optional `from_phase`) | Daemon / user | |
| `supply_inputs` | SPA → daemon | |
| `cancel` | SPA | |
| `enqueue`, `claim` | SPA / daemon | |
| `get_status` / `update_status` | SPA / daemon | |
| `artifacts/create` | Daemon | |
| `report_activity` | Daemon | |
| `GET /v1/runs/stream?run_id=` | SPA | |
| **`append_logs`** | Daemon | `{ run_id, chunk, concern?, tx_id? }` |
| **`get_logs`** | SPA / site admin | filters; `realm_id` required unless site admin |
| **`report_telemetry`** | Daemon | `kind: usage \| traces` |
| **`get_telemetry`** | SPA | `kind: usage \| spans \| summary` |

### Removed (hard cut — no aliases)

- `POST /v1/logs` `{ action: append \| search }`
- `POST /v1/telemetry` `{ action: usage_snapshot \| usage_get \| traces_ingest \| spans_get \| summary }`
- Prior Runs nested: `logs/*`, `usage/*`, `traces/*`, `spans/*`, `telemetry/summary`

### `/v1/events` — notifications (unchanged)

`submit`, `get_by_id`, `types/list`, `custom/*`

---

## Clarifications: awaiting + reconcile (unchanged intent)

### `set_awaiting_input`

Prefer durable state as a side effect of `report_activity` / lifecycle (`phase.input_required`). Drop dedicated verb when ready.

### `reconcile`

Daemon safety timer — candidate to delete after lease/complete confidence. Not a product OpenAPI star.

---

## Non-goals

- Root `/v1/run_events`, `/v1/logs`, `/v1/telemetry`
- Action mega-endpoints
- Moving notifications into Runs
- Putting logs inside telemetry
- Dual-serve / aliases
