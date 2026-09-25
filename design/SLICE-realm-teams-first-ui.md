# Slice plan — Realm Teams-first UI

Implements the proposed Hub mock IA under `/realms/:slug/*`.

## Target IA

| Tab | Role |
| --- | --- |
| **Teams** | Install / schedule. Team name → Runs with `?team=` auto-filter. **View team** → detail. |
| **Runs** | Canonical list. Filters: team, status, daemon, search. Lead column = `run_name` (slug if omitted). |
| **Security** | Members / tokens (unchanged). |
| **Advanced** | Daemons (renamed from Daemons). |

Removed from primary nav: Overview, Logs, Notifications (routes may redirect).

## Slices

### 5a — Nav shell + redirects ✅
- Primary nav: Teams · Runs · Security · Advanced
- `/realms/:slug` → `/realms/:slug/teams`
- `/realms/:slug/logs` → `/realms/:slug/runs`
- Unit tests for nav labels + redirects

### 5b — Realm Teams page ✅
- List teams for realm + coverage
- Links: team → `runs?team=`, View team → `teams/:scope/:name`
- Schedule run panel: optional `run_name`, inputs, enqueue
- Unit tests

### 5c — Runs filters + run_name ✅
- Team / status / daemon / search filters + URL sync (`?team=` from Teams)
- Lead column = run_name; Logs → run detail
- View team when team filter set
- Unit tests: `runs_filters`, `runs_page_filters`

### 5d — Team detail + run logs ✅ (logs)
- `Run_logs_section` on run detail (`#logs`); Logs CTA scrolls there
- Runs list Logs → `runs/:id#logs`
- Unit tests: `run_logs_section`
- Team manage / fleet install polish still later

### Later
- Fleet install UX polish
- Flat enqueue API field rename (payload → flat) if still needed

## Conventions
- snake_case, early returns / no else
- Vitest + Testing Library for each slice before moving on
