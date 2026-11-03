/**
 * A `daemon_teams` row for tests that need a run's team (labels, lists, lifecycles). In the product, rows are
 * written only by the hub's install of a realm team (`TeamService.install_slot`, PLAN-team-bundle S4.2); these
 * fixtures just need a row to point runs at.
 */
import { randomUUID } from 'node:crypto';
import { DaemonTeam } from '../../../src/models/index.js';

export async function make_daemon_team_row(
    scope_id: string,
    slug: string,
    version: string | null,
    description: string | null,
    manifest: string,
    deps: { daemon_id?: string | null; dockerfile?: string | null; dependencies?: string | null } = {},
): Promise<DaemonTeam> {
    const now = Date.now();
    return DaemonTeam.create({
        id: randomUUID(), daemon_id: deps.daemon_id ?? null, scope_id, slug, version, description, manifest,
        dockerfile: deps.dockerfile ?? null, dependencies: deps.dependencies ?? null, created_at: now, updated_at: now,
    } as never);
}
