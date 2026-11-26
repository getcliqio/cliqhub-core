import { readFileSync } from 'node:fs';

/**
 * Core's HTTP API contract version, reported by `GET /v1/health`.
 *
 * Bump it whenever a client (the BFF, CLI, daemon) starts depending on
 * something new here — a new route, a new request field, or a changed
 * response shape. Clients declare the minimum they need and warn when the
 * running Core is older, instead of failing with a vague error.
 *
 *   1 — first versioned contract (runs/get `team_id` filter, JSON route 404s).
 *   2 — agents: `include_usage` / `used_by` on agents/get, role checks on agent
 *       routes, secret values masked in get_settings without agents.reveal.
 *   3 — admin: `all: true` (site admins) on daemons/get, realms/get, runs/get;
 *       users/get `role` / `suspended`; admin orgs/get `owner_count`;
 *       reports/audit `since_ms` / `until_ms` / `target_id`; agents.update_settings audited.
 *   4 — workspaces/get, get_by_id, remove enforce realm membership (site admins see
 *       all; daemon tokens their realm; users the daemons in their realms).
 *   5 — teams/get realm mode sends each row's `scope` and, for published teams, the
 *       catalog `id`; teams/install accepts a catalog team UUID; site-admin
 *       `listed` / `scope` listing returns rows with `version_count` / `author_id`.
 *   6 — list sorting: `sort_by` / `sort_dir` on orgs/get (site-admin list), users/get
 *       (hub list), daemons/get, teams/get catalog + site-admin modes (keys from the
 *       wrong mode are 400), orgs/get_scopes, workspaces/get, reports/audit; every
 *       sorted list (realms/get and runs/get included) breaks ties by id ascending.
 *       Older Cores drop these fields silently, so clients gate on this version.
 *   7 — runs/get_by_id `with_history: true` returns `history` (the run's lifecycle: started,
 *       resume requested by whom, resumed, failed …) and `route_backs` (each time a gate sent a
 *       phase back: phase, gate, reason verbatim, iteration of max). Both absent on older Cores.
 *   8 — people on lists: runs/get and runs/get_by_id rows carry `started_by` ({ id, username,
 *       display_name } or null); teams/get_versions carries `published_by` per version and, with
 *       `latest_only`, the latest version's `published_by` / `published_at` (null for versions
 *       published before Core recorded it).
 */
export const CORE_API_VERSION = 8;

/** package.json version (src/lib and dist/lib both sit two levels below the repo root). */
function read_package_version(): string | null {
    try {
        const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
        const v = (JSON.parse(raw) as { version?: unknown }).version;
        return typeof v === 'string' ? v : null;
    } catch {
        return null;
    }
}

export const CORE_VERSION: string | null = process.env.npm_package_version ?? read_package_version();

/** When this process started (ms) — tells a stale process from a fresh one. */
export const CORE_STARTED_AT = Date.now();
