# DESIGN: Daemon ↔ Hub Phase Gate (pre-phase cost guard)

**Status:** Draft — pending review (2026-09-06)
**Repos:** `cliq-platform` (daemon executor), `cliqhub` (backend, UI)
**Related:**
- [`DESIGN-control-message-reliability.md`](./DESIGN-control-message-reliability.md) — envelope, `tx_id`, control classes
- [`DESIGN-outbox-sync-protocol.md`](./DESIGN-outbox-sync-protocol.md) — daemon `hub_outbox`, Hub `command_outbox`

**Terminology.** We call the checkpoint between phases the **phase gate**
throughout this doc. It is *not* a "mode" the operator switches into —
it's a mechanism that runs implicitly for every cloud-mode run, at every
phase boundary, and is skipped entirely for local runs. The gate either
opens (proceed to phase N+1) or holds closed (pause the run). The name
draws on parallel-computing "sync barriers" but reframes them as a
platform-native concept — a `run` is a sequence of `phase`s, and the
gate lives between them.

---

## 1. Problem

Today a cloud-mode run keeps executing its phases regardless of whether the
daemon is actually in sync with the Hub. Concretely, the two failure modes:

1. **Outbound drift.** The daemon has completed phase N and produced state
   updates (`run.phase.complete`, span batch, artifact registration). Those
   are sitting in the daemon's `hub_outbox` because Hub is unreachable / slow
   / auth-expired. The daemon proceeds to phase N+1 anyway. The Hub UI shows
   the run mid-phase N; the operator's cancel decision is based on stale data.
2. **Inbound drift.** The operator clicked Cancel 4 minutes ago. The row is
   sitting in Hub's `command_outbox` waiting for the daemon to pull it. The
   daemon hasn't polled recently (backoff, transient error, network wedge).
   The daemon starts phase N+1 — which is the LLM call the operator was
   trying to stop. Cost is burned; the cancel eventually lands and terminates
   phase N+2 (or nothing, if it was the last phase).

Neither of these is a health failure. The daemon is alive, heartbeating,
executing. It's just not *current with the Hub*, and it's about to spend
money as if it were.

The fix currently shipping ([4bbcabb](https://github.com/getcliqio/cliqhub/commit/4bbcabb))
gives the operator honest UI feedback when a cancel is queued and unacked.
This document proposes the complementary daemon-side change: **don't start
the next phase until both queues have drained**.

---

## 2. Goals

1. **Cost-safety at phase boundaries.** No cloud-mode phase starts while the
   daemon and Hub are not fully in sync in both directions.
2. **Cancel always wins the race** against the next phase. If Cancel is
   queued anywhere in the system before the phase gate runs, it takes effect
   before N+1 begins — never as a "too late, tokens already spent" event.
3. **Local runs untouched.** No phase gate, no pause, no daemon-tokens
   requirement, no network dependency. Local is local.
4. **Honest UI.** Operators can see when a run is paused waiting for sync,
   for how long, and why (last outbox error, unacked queue depth).
5. **Automatic recovery.** When sync is restored, the paused run auto-resumes
   after a small stability window. No operator action required in the
   happy path.

### Non-goals (v1)

- **Intra-phase abort.** If a phase runs for hours (long LLM chain, big
  batch), sync loss mid-phase does *not* trigger a mid-flight abort. The
  cost is committed the moment the phase starts; we accept that. Cancel
  takes effect at the *next* phase boundary. Revisit if we see real
  damage from long unattended phases (Section 10).
- **Per-phase opt-out.** A team manifest cannot say "phase 3 is safe to
  run without sync." All-or-nothing per run, with a daemon-config kill
  switch for dev environments.
- **Backpressure inside a phase.** We don't slow down or pace an in-flight
  phase based on outbox depth. Phase gate is a boundary check, not a governor.
- **Bidirectional two-phase commit** between daemon and Hub for phase
  starts. We're not making phase dispatch transactional across the wire;
  the phase gate is a *drain* check, not a commit protocol.

---

## 3. Two sync states, not one

Reachability is not enough. The daemon can be talking to the Hub over TCP
and still be badly out of sync in either direction. The gate opens only
when **two independent booleans** are both true, computed from concrete
queue state — not from a background health tick.

| Signal | Question it answers | Concrete definition |
|--------|--------------------|----------------------|
| `outbound_synced` | "Has Hub received everything I've told it?" | `hub_outbox` has 0 undelivered entries **older than the outbound grace window** (default 15 s). Entries younger than the window are treated as in-flight, not drift. |
| `inbound_synced` | "Do I have all commands Hub tried to give me?" | Most recent successful pull of `/v1/commands/pull` (or equivalent for this daemon's transport) returned within the inbound grace window (default 30 s) **and** emptied the queue on that pull. |

**Both must be true to advance.**

Reachability (successful HTTP round-trip) is a necessary condition for each
signal, but not sufficient. A Hub that accepts the pull but returns 500 for
outbox POSTs leaves `outbound_synced = false` while `inbound_synced = true`.
That's still "not in sync"; the phase gate still holds.

### Why not a single `hub_reachable` boolean

- It hides the failure mode. "Not in sync" tells the operator nothing about
  which direction is broken; the two signals make it diagnosable.
- It invites bugs where reachability is true but drift is real. See the
  "Hub accepts pull, rejects push" scenario above — a single boolean cannot
  express that state.
- It requires a background health loop that is stale by definition (last
  tick was N seconds ago). The two-signal check is computed *at the moment
  it matters* — right before we spend money.

---

## 4. The phase gate

Between every phase, in cloud-mode runs, the executor runs this sequence
before dispatching phase N+1. This is the only new mechanism this doc adds.

```text
gate(run):
  if run.execution_type != 'cloud':
      return PROCEED                          # local mode — skip entirely

  if daemon.config.pause_on_hub_unreachable == false:
      return PROCEED                          # dev / CI kill switch

  # ── 1. Drain outbound ─────────────────────────────────────────────
  outbound_deadline = now + gate.outbound_timeout_ms
  while hub_outbox.has_pending_older_than(outbound_grace_ms):
      try flush_one_outbox_entry()            # normal outbox POST
      if now > outbound_deadline: break

  outbound_synced = hub_outbox.pending_older_than(outbound_grace_ms) == 0

  # ── 2. Drain inbound ──────────────────────────────────────────────
  inbound_deadline = now + gate.inbound_timeout_ms
  try:
      commands = pull_commands_until_empty(deadline=inbound_deadline)
      inbound_synced = true
  catch NetworkError | AuthError:
      inbound_synced = false
      commands = []

  # ── 3. Process any inbound commands FIRST ─────────────────────────
  # Cancel that arrived just now must terminate the run before the
  # next phase starts. This is the whole cost-safety point.
  for cmd in commands:
      handle_command(cmd)                     # may transition run to
                                              # 'cancelled' → PROCEED path
                                              # will not re-enter this run
  if run.state in TERMINAL_STATES:
      return TERMINATED                       # cancel won; done

  # ── 4. Gate ───────────────────────────────────────────────────────
  if outbound_synced and inbound_synced:
      return PROCEED
  return PAUSE(reason = summarise(outbound_synced, inbound_synced))
```

Steps 1 and 2 are already implemented — this design just calls them in a
specific order at a specific point, with a shared deadline and a
combined gate.

### Ordering matters

Outbound first, then inbound, then process, then gate. Why:

- **Outbound first** so Hub has the latest state before we ask it for
  commands. Prevents "Hub sends me a cancel based on stale info because
  I never told it my current state."
- **Process commands before starting phase** — obvious. This is the whole
  point.
- **Terminal state check before gate** — a cancel that just arrived
  terminates the run; there's no next phase to gate. Return `TERMINATED`
  and skip the reachability check entirely. Reachability is irrelevant
  once the run is done.

### Time budgets

- `outbound_timeout_ms`: default **30 s**. How long we spend trying to
  flush the outbox before giving up and calling `outbound_synced = false`.
- `inbound_timeout_ms`: default **30 s**. Same for the pull.
- `outbound_grace_ms`: default **15 s**. Entries younger than this are
  in-flight-normal, not drift.
- `inbound_grace_ms`: default **30 s**. If the last successful pull was
  within this window and returned empty, we consider inbound synced even
  before running the pull again. Prevents pointless phase gates when we
  just pulled 5s ago.

All configurable via `cliqd` config. See Section 8.

---

## 5. Paused state

New run state: **`paused_hub_unreachable`**.

Written by the daemon when the phase gate returns `PAUSE`. Fields set at
the same time:

| Field | Value |
|-------|-------|
| `state` | `paused_hub_unreachable` |
| `paused_at` | current daemon clock, ms |
| `paused_reason` | short summary: `"outbound: 12 pending, oldest 45s"` / `"inbound: pull failed (connect timeout)"` / `"outbound + inbound"` |
| `paused_last_error` | latest transport error (nullable) |
| `lease_expires_at` | extended to `now + paused_lease_ttl_ms` (default 24 h) |

The lease extension matters: without it, the Hub reaper would flip a
paused run to `crashed` after 30 min because its lease expired, which
is exactly wrong. A paused run is intentionally idle; the reaper should
leave it alone. Extended lease + paused state is the signal.

### Hub-side handling

- Runs list / dashboard "Awaiting input" tile: **include** `paused_hub_unreachable`
  in the count. It's structurally the same UX — the run needs
  something before it moves — the operator just isn't the thing it's
  waiting for.
- Run detail banner: distinct label "**Paused — Hub unreachable (N min)**"
  with the reason and last error inline. Same amber `Pending_control_banner`
  visual family used for cancel-pending, but reason text differs.
- No new attention-list entry on the dashboard v1. Rolling into the
  existing awaiting-input insight keeps the surface honest without adding
  another badge people have to learn.
- Reaper: **skip** runs in `paused_hub_unreachable`. They are not zombie
  runs; they are intentional pauses waiting on network. Reaper docstring
  gets an explicit note.

### Persistence

The paused state is stored on both sides:

- **Daemon SQLite** — source of truth. Written before the phase gate returns.
- **Hub Postgres** — mirrored via the daemon's outbox as any other state
  transition. If the outbox is what's broken, this update sits in the
  outbox and lands when sync is restored — the operator sees the pause
  event slightly delayed. That's acceptable; the *daemon* has the truth,
  and the run is paused regardless of when Hub finds out.

---

## 6. Resume

**Auto-resume** is the default. The daemon runs a lightweight watcher:

```text
resume_watcher():
  while paused_runs_exist():
      sleep(check_interval_ms)  # default 15s
      if gate_probe() == BOTH_SYNCED:
          consecutive_ok += 1
          if consecutive_ok * check_interval_ms >= stability_window_ms:
              for run in paused_runs():
                  run.state = 'running'
                  run.paused_at = null
                  run.paused_reason = null
                  emit resume event
              consecutive_ok = 0
      else:
          consecutive_ok = 0
```

- `stability_window_ms`: default **30 s**. Sync must hold for this long
  before we resume. Prevents yo-yo pauses on a flapping connection.
- `gate_probe()` is the same `outbound_synced && inbound_synced` check
  used inside the phase gate, without the drain (cheaper).

On resume the daemon re-runs the full phase gate once (drain both directions,
process commands, gate) before actually dispatching phase N+1. Reason:
between the probe passing and the executor picking the run back up, a
cancel command might have arrived. The final phase gate is the last
enforcement point.

### Manual resume

Available as an escape valve. Operator clicks "Resume" on the run detail
page → Hub enqueues `/v1/runs/resume` into `command_outbox` (same path as
Cancel) → daemon picks it up, clears the paused state, resumes. Same
final-phase gate rule applies.

Manual resume can *fail* the final phase gate and immediately re-pause with
a new `paused_at`. That's honest — clicking Resume doesn't create sync
where there isn't any.

### Idempotency

Both auto and manual resume are idempotent. If the run is not paused,
resume is a no-op. If it's paused but sync isn't restored, resume tries
the phase gate and re-pauses. No state corruption possible.

---

## 7. Cancel interaction

Force-terminate (separate future design) and normal cancel both continue
to work while a run is paused:

- **Normal cancel while paused**: operator clicks Cancel → Hub enqueues
  `/v1/cancel`. It sits in `command_outbox` until sync is restored, then
  the paused daemon's resume-watcher probe finds it during the next
  inbound drain. The command is processed and the run terminates
  *without ever resuming to phase N+1*. This is the ideal outcome — the
  operator changed their mind while the daemon was paused, and no cost
  was spent.
- **Force-terminate while paused**: Hub-side, marks the run cancelled on
  Hub with `force_terminated_at`. When the daemon reconnects, it pulls
  the force-cancel signal, aligns local state to `cancelled`. Because
  the daemon was paused, nothing was executing, so there is nothing
  "still running on the daemon" to be honest about — a pause + force
  is the cleanest possible cancel path.

The pause is the safety net force-terminate wishes it had.

---

## 8. Configuration

All knobs live in `cliqd` config (`~/.config/cliqd/config.yaml` or env).
All optional; defaults chosen so the median cloud user never touches them.

```yaml
phase_gate:
  # Master switch. false = never pause on sync loss (dev/CI).
  pause_on_hub_unreachable: true

  # Grace windows — how much lag is "normal in-flight" vs "drift".
  outbound_grace_ms: 15000
  inbound_grace_ms:  30000

  # Phase gate timeouts — how long each drain step is allowed.
  outbound_timeout_ms: 30000
  inbound_timeout_ms:  30000

  # Resume stability window — sync must hold this long before resuming.
  resume_stability_window_ms: 30000
  resume_check_interval_ms:   15000

  # Extended lease for paused runs. Reaper must not touch them.
  paused_lease_ttl_ms: 86400000  # 24h
```

No team-manifest overrides in v1. Feedback in the field may push us to
add a `policy.pause_on_hub_unreachable: false` override for teams that
must proceed regardless (rare — think local dev harness pretending to be
cloud), but we'll wait to see if the demand is real.

---

## 9. Local mode explicit carveout

The phase gate is skipped entirely when *any* of these hold:

- `run.execution_type == 'local'`
- Daemon has no Hub tokens registered / user not signed in
- `phase_gate.pause_on_hub_unreachable == false`

Local runs have nothing to sync with. There is no Hub in the loop, no
cost oversight to protect, no cancel that could arrive from elsewhere.
The phase gate machinery does not even initialise on such runs — no
resume-watcher thread, no state transitions.

The check is cheap and happens at the top of the phase gate function; it
short-circuits before touching any queue.

---

## 10. Long phases (accepted trade-off)

If a phase runs for hours — a long LLM chain, a big batch job, a
connector agent — the phase gate does *not* interrupt it. Sync loss during
that phase means:

- The phase continues to spend money if it involves paid API calls.
- Any cancel queued during that time waits for the phase to complete.
- The dashboard shows the run in the state it was in when sync broke;
  the operator has no visibility into intra-phase progress until sync
  returns.

This is a deliberate v1 choice. The alternative — intra-phase abort —
requires:

- A background sync-loss watcher inside every agent.
- Agent-specific abort semantics (how do you cleanly abort a partial
  LLM stream? A half-committed DB write? A subprocess mid-write?).
- Leaked resources: partial artifacts, half-flushed logs, dangling
  child processes.

The right time to add intra-phase aborts is *after* we see real cost
damage from long unattended phases in production. The rollup we
already ship (`total_cost_usd` per run) will surface the pattern
quickly if it exists.

Design placeholder for the future: `gate.intra_phase_check_ms` config
knob, off by default. When on, the daemon runs `gate_probe()` every
N seconds inside a long phase; if sync has been lost for >M consecutive
minutes, the phase is signalled to abort at its next safe checkpoint
(each agent defines what "safe checkpoint" means; some may have none,
in which case the abort is best-effort).

---

## 11. Failure modes and edge cases

### 11.1 Phase gate races with heartbeat

The heartbeat loop and the phase gate both talk to Hub. They can race
(phase gate is flushing outbox, heartbeat POST fires concurrently and
succeeds). This is fine. Heartbeat is orthogonal to sync (Section 3);
its success or failure doesn't feed into `outbound_synced` /
`inbound_synced`. Those are computed from queue state, not from
whether the last request over the wire happened to work.

### 11.2 Auth expiry mid-run

Hub returns 401 on both outbox POST and command pull. Phase gate fails
in both directions → pause with `paused_reason = "auth expired"`. When
the operator re-registers cliqd (rotates token), the next phase gate probe
passes and the run auto-resumes. No data lost.

### 11.3 Clock skew between daemon and Hub

`outbound_grace_ms` and `inbound_grace_ms` are evaluated using the
daemon's own clock. Hub clock is irrelevant — the daemon is the one
deciding what's "recent enough." No NTP dependency introduced.

### 11.4 Phase gate stuck in a loop

If flushing one outbox entry keeps failing (e.g. Hub is 500-ing on a
specific payload), the phase gate `while` loop exits when the deadline
hits, regardless of whether progress was made. `outbound_synced` is
false → pause. Poison payloads are then handled by the existing outbox
DLQ / attempts-exhaustion path (`cliq_outbox` deletes after
max_attempts). The phase gate does not need its own retry logic.

### 11.5 Very first phase of a run

The phase gate runs *between* phases, so phase 1 dispatches without a
phase gate check. Rationale: if sync were broken before the run even
started, we would have failed to receive the `execute` command in the
first place. Once the run has started, the phase gate applies from the
end of phase 1 onward.

Alternative considered and rejected: run the phase gate once at
`run.start`, before phase 1. Rejected because we already know sync is
good enough — the `execute` just arrived. Adding an entry-time phase gate
adds latency without adding safety.

### 11.6 Multiple runs on one daemon

The phase gate is per-run, not per-daemon. Runs A and B on the same daemon
each hit their own phase gate at their own phase boundaries. If A pauses,
B can still proceed if its own phase gate passes. This falls out of the
per-run state model; no explicit coordination needed.

The resume-watcher iterates over all paused runs on the daemon and
resumes them together when the probe passes, on the assumption that
sync loss is a daemon-wide condition. If sync is restored, every
paused run on that daemon is eligible.

### 11.7 Long queue drain vs impatient operator

If the daemon has a large outbox backlog (say, 500 entries from a
long disconnect) and Hub is finally reachable, the phase gate will keep
draining until `outbound_timeout_ms`. During that time, the run is
still paused from the operator's view — the drain is happening in the
background of the phase gate call, not a visible activity.

Two mitigations:

- Emit a lightweight `sync.draining` event periodically so the UI can
  show "draining 342 pending updates…" instead of a silent pause.
- Make `outbound_timeout_ms` generous enough (30 s default) that most
  drains finish in one phase gate pass.

The alternative — a stricter timeout that pauses partway through a
drain — would just make the run yo-yo. Better to be patient once than
to loop.

---

## 12. Implementation plan

### Phase 1 — daemon phase gate + paused state
- `HubPhaseGate` module in cliqd. Public API: `phase gate(run) → Proceed | Terminated | Pause(reason)`.
- Wire into the executor between phases (`PhaseScheduler.on_phase_complete`).
- New run state `paused_hub_unreachable` in daemon SQLite + state machine.
- Extended lease on pause.
- Config knobs (Section 8).
- Unit tests: phase gate permutations (outbound only fails, inbound only fails, both fail, both ok, cancel arrives during drain, terminal state during drain).

### Phase 2 — Hub-side surfacing
- Add `paused_hub_unreachable` to the run state enum + all state-classifying helpers (dashboard counts, filters, reaper skip list).
- Extend `Pending_control_banner` (or a sibling `Pause_banner`) on the run detail page to render the paused state with reason + duration + last error.
- Dashboard "Awaiting input" count includes paused runs; runs list filter has a "paused" pill.
- Reaper: explicit skip for `paused_hub_unreachable`, with a comment
  cross-referencing this doc.

### Phase 3 — resume
- `HubResumeWatcher` in cliqd: probes sync, resumes paused runs after stability window.
- `/v1/runs/resume` command endpoint on daemon (same shape as `/v1/cancel`).
- Hub "Resume" button on the run detail page when state is
  `paused_hub_unreachable`, enqueues the resume command via
  `command_outbox`.

### Phase 4 — telemetry + regression pins
- Emit `sync.pause` and `sync.resume` events into the OTEL span stream
  so pauses show up on the run timeline.
- Backend telemetry: count of paused-then-resumed runs per window,
  average pause duration. Surfaces as an "Attention" insight on the
  dashboard if pause frequency spikes (a signal that a daemon has
  chronic sync trouble).
- e2e test: simulate outbound failure mid-run, assert next phase does
  not start; restore, assert auto-resume.

Phases 1+2 are the minimum shippable increment. Phase 3 is what makes
the feature *usable* (without it, every pause requires manual daemon
restart). Phase 4 is polish + observability.

---

## 13. Open questions

1. **Resume-watcher on paused-only daemons.** If a daemon has zero
   active runs but is idle, do we still need the watcher running?
   Currently: no — nothing to resume. But if a daemon reconnects
   after long downtime and finds paused runs in SQLite from a previous
   session, we do need the watcher to kick in on startup. Solution:
   watcher is a lazy singleton, started when the first paused run is
   observed.
2. **Should the phase gate run on `awaiting_input` → `running` transitions?**
   When a HUG review completes and the run resumes into the next phase,
   the phase gate fires as usual. This should be fine — awaiting_input
   → running is functionally a phase boundary. Confirming.
3. **What if the daemon can't reach Hub to *report* the pause?** The
   pause row itself has to make it to Hub. It goes through the same
   outbox, so if outbound is broken, the pause event is queued and
   lands when sync is restored. Meanwhile the daemon has the truth in
   SQLite. Hub sees the run as `running` until the queued pause event
   arrives. Acceptable — the reaper won't touch a lease-extended row
   for 24 h, and by then either the pause event has landed or a bigger
   problem exists.

Answers to be resolved during implementation review.

---

## 14. Rejected alternatives

- **Single `hub_reachable` boolean.** See Section 3 — hides failure
  mode, invites bugs, requires stale background health tick.
- **Pause only before "costly" phases** (LLM / connector). Brittle —
  a shell phase can `curl` a paid API. All-or-nothing is honest.
- **Intra-phase sync check with mid-flight abort.** See Section 10 —
  substantial cross-cutting complexity for a threat model we haven't
  measured yet. Deferred behind a config flag design placeholder.
- **Phase gate as a Hub-side check** (Hub gates phase dispatch on sync).
  Requires the daemon to phone home before every phase, adding latency
  even in the happy path. The phase gate being daemon-local means the
  happy path is a queue-depth peek and a couple of `SELECT` queries
  — near-zero cost per phase.
