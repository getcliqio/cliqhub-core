# Realm team delivery — a realm's teams reliably reach its daemons

## Status

**Approved** (2026-11-11) by the plan owner, with §6's recommendations (a run with no eligible daemon fails at once;
failed-install notices are in-app). Branch: `main` (plan owner's choice), one commit per step, git commands shown before each. Check in after
every step.

---

## 1. The problem (seen 2026-11-12 on realm `elan.default`)

The realm lists `@cliq/hello-world` and `@measureone/paystub-parser-builder`. A daemon enrolled in the realm got
paystub but not hello-world, and a run of hello-world started from CliqHub failed:
`Team '330d5757…' is not installed on the claiming daemon — add it to the daemon's realm first`.

What happened, from the daemon's log and Core's code:

1. The daemon connected. Core's `RealmTeamListService.inject_for_daemon` pushed the realm's teams **one at a time**: for
   each, `DispatchService.install_team` → `TeamService.install_slot` (creates the `daemon_teams` row, the daemon's
   *slot*) → `command_outbox_enqueue('/v1/install')`.
2. At the same moment the daemon reported its roster: `daemons/register_teams` with `complete: true` and an empty list
   (a realm reset had just purged its teams; cliqd log `team_reconcile_done registered: 0` at 06:05:39.572).
3. With `complete`, `TeamService.register_from_daemon` (`teams_install_service.ts`) marks every slot the daemon didn't
   report **uninstalled** — including hello-world's slot, created a moment earlier. Paystub's slot was created after
   the roster, so it survived.
4. The daemon ran both installs (06:05:39.684 and .959). Hello-world's `teams/download` found no installed slot →
   404 `not_installable` → cliqd 409 `TEAM_NOT_IN_REALM`. Paystub installed. (`cliq team install @cliq/hello-world`
   afterwards: the same refusal.)
5. A run of hello-world was queued. `DispatchService._daemon_ids_with_team` found no daemon with the team, and the
   offer **fell through to every online daemon** ("backward compat", `dispatch.service.ts` ~985). The daemon claimed
   it; Core failed the run after the claim.

Three gaps:

- **The race:** a `complete` roster undoes a push in flight.
- **Silence:** a push that fails (or never arrives) leaves no trace a person sees — a 409 in the daemon's log.
- **Blind offers:** a run is offered to daemons that don't have its team.

## 2. What exists today (verified 2026-11-11)

- `daemon_teams` rows are never deleted: `uninstalled_at` is set, and the default scope hides those rows
  (`models/daemon_team.model.ts`). `install_slot` reuses the installed row, else the latest uninstalled one, and sets
  `uninstalled_at: null`.
- `teams/download` for a daemon (`teams_service.ts` `_download_for_daemon`) requires an installed slot for
  `(daemon_id, team_id)`; otherwise 404 `not_installable`.
- The daemon acks every outbox command: `POST /v1/daemons/ack_command` with `status: 'ok' | 'error'` and `error`;
  Core stores `ack_status` / `ack_error` on the `command_outbox` row, whose `endpoint` and `payload` (`team_id`,
  `version_id`) identify the install. Nothing links an ack back to the slot.
- `inject_for_daemon` already collects install failures into an in-app notification (`InAppNotificationService`).

## 3. The fix

A slot created by a push is **pending** until the daemon confirms the install. A roster never undoes a pending slot.
The install's ack confirms it — or, on error, uninstalls it and tells the realm owner. A push that's never delivered
is cleared. Runs go only to daemons whose slot for the team is confirmed.

## 4. Steps

Each step: GitNexus impact before editing a symbol; the touched tests on `cliqhub_test` + `npx tsc --noEmit -p .`;
`detect_changes` before committing; a check-in.

### Step 0 — confirm (read-only)

1. Find where the command outbox gives up on a command (attempts / `deliver_until` exhausted) and what it records —
   step 4 hooks there.
2. Write the failing test first: inject creates slot A, a `complete` empty roster arrives, inject creates slot B →
   today A is uninstalled and B kept (the 2026-11-12 log). It must pass at the end of step 2.
3. Check that every cliqd version in use acks `/v1/install` (step 3 relies on it).

### Step 1 — a pending state on `daemon_teams` (migration)

1. Column `confirmed_at BIGINT NULL`, added by the versioned data migrations Core uses for schema changes.
2. Backfill: every installed row (`uninstalled_at IS NULL`) gets `confirmed_at = updated_at` — today's slots stay as
   they are. Uninstalled rows are left alone.
3. `install_slot` sets `confirmed_at = null` whenever it (re)creates or moves a slot for a push: pending.
4. A row the daemon reports in `register_teams` (it has the team) gets `confirmed_at = now`.

### Step 2 — a `complete` roster leaves pending slots alone

`TeamService.register_from_daemon`: when marking unreported rows uninstalled, skip rows with `confirmed_at IS NULL`.
Confirmed rows the daemon no longer reports are still uninstalled (a real local uninstall still syncs). **Fixes the
race.**

### Step 3 — the install's ack settles the slot

`CommandAckController.ack_command`, for a command whose `endpoint` is `/v1/install` (slot found from the payload's
`team_id` and the command's `daemon_id`):

- `ok` → `confirmed_at = now`;
- `error` → `TeamService._mark_uninstalled(row)`, the daemon's error kept on the row, and an in-app notification to the
  realm owner: "`@cliq/hello-world` couldn't be installed on daemon `<name>`: `<error>`".

Acks of other commands: unchanged. The request shape doesn't change.

### Step 4 — a push that never arrives is cleared

Where the outbox gives up on an undelivered `/v1/install` (step 0), its still-pending slot is marked uninstalled
("install never delivered") and the realm owner notified as in step 3. No pending slot outlives its command.

### Step 5 — runs go only to daemons that have the team

`DispatchService._daemon_ids_with_team` counts a daemon only with a **confirmed**, installed slot for the team. The
"offer all (backward compat)" fallback goes. With no eligible online daemon the run fails at once, before any claim,
with what to do:

- `no daemon in realm <r> has @cliq/hello-world installed yet — install pending on <daemon>`;
- `… — install failed on <daemon>: <error>`;
- `@cliq/hello-world is on realm <r>'s list but installed on no daemon`.

### Step 6 — tests (`cliqhub_test`)

- The race (step 0's test): pending slot A survives the `complete` roster; the daemon's download of A succeeds.
- Ack `ok` confirms; ack `error` uninstalls, keeps the error, creates the notification.
- Outbox give-up on an install clears the pending slot.
- A `complete` roster still uninstalls a confirmed, unreported slot.
- Run offer: only confirmed daemons; with none, each of the three messages; no fall-through.
- Migration: installed rows backfilled as confirmed; uninstalled rows untouched.

### Step 7 — rollout

1. Read-only counts on production first (run by the plan owner): installed `daemon_teams` rows (to be backfilled);
   runs in the last 30 days that went through the "offer all" fallback (step 5's change in behaviour).
2. Core deploys from `main` (Railway); the migration runs on boot. No cliqd release: daemons already ack installs.
3. Realm `elan.default`: re-sync `@cliq/hello-world` (or reconnect the daemon) — a fresh pending slot survives the
   roster and the ack confirms it.

## 5. Risks

- **Step 5 changes behaviour:** a realm whose daemons have a team without a hub slot (old local installs) gets runs
  through the fallback today and an "installed on no daemon" error after. Step 7's counts say how many before deploy.
- **Acks:** if some cliqd in use doesn't ack installs, its slots stay pending until step 4 clears them — step 0 checks.
- **The migration** touches every `daemon_teams` row once (an UPDATE on installed rows); it is idempotent.

## 6. Decisions for the plan owner

| Choice | Recommendation | Alternative |
|---|---|---|
| A run with no eligible daemon | Fail at once with the reason (step 5) | Wait in the queue while an install is pending |
| Where the failed-install notice goes | The realm owner's in-app notifications (as `inject_for_daemon`) | Also email |

## 7. Progress log

| Date | Step | Note |
|---|---|---|
| 2026-11-11 | — | Plan written from the 2026-11-12 `elan.default` failure (daemon log, Core code) for approval |
| 2026-11-11 | — | **Approved**, on `main`; §6 as recommended. cliqd needs no change: `/v1/install` is mounted with `wrap_command`, so a failed install already acks `error` with its message |
| 2026-11-12 | 0 | The race test reproduced production (slot A uninstalled by the empty `complete` roster). Outbox give-up points: `_deliver_entry`'s permanent failure and `_note_failure`'s last try — where `fail_refused_execute` already runs |
| 2026-11-12 | 1–6 | **Done (not committed).** `daemon_teams.confirmed_at` / `install_error` (model; `migrate_realm_team_delivery`: columns every boot, a keyed one-time backfill in one transaction). `install_slot` → pending; `register_from_daemon` confirms what the daemon reports and its `complete` pass skips pending rows. `TeamService.settle_install` (ok → confirmed; error → uninstalled with the reason + `realm.team_list.install_failed` in-app), reached through `settle_install_command` from `ack_command` and both give-up points. `_daemon_ids_with_team` counts confirmed rows only; no fall-through: `_why_no_daemon_has_team` fails the run (pending / failed: reason / on no daemon). Tests: 9 new (race, roster, re-push, ack ok/error + notification, never delivered, stale ack / late error, run eligibility and the three reasons, migration once); the slot fixture `make_daemon_team_row` is confirmed by default; one slot test confirms before uninstalling; the ack unit test's mock gains `settle_install_command`. 31 test files, 569 tests; tsc, eslint clean. GitNexus `detect_changes`: high, complete |
