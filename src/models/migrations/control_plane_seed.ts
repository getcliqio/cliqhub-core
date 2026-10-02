/**
 * Idempotent control-plane seed for schema `cliq`.
 *
 * Seeds org-wide defaults on `daemon_config` with daemon_id `__global__`.
 * The platform scope ('cliq') is seeded in the schema
 * migration via SQL INSERT … ON CONFLICT DO UPDATE.
 *
 * Does not touch Hub `public.*` registry tables. Safe to re-run on every boot.
 */

import { DaemonConfig } from '../../models/index.js';
import { get_logger } from '../../lib/log.js';

const log = get_logger('control-plane-seed');

/**
 * Org defaults previously seeded by Core BFF.
 * `hub.registry_url` here is the public web/registry host (SPA), not the API
 * base — API clients use `cliq.api_url` / `https://api.cliqhub.io` (Slice E).
 */
const GLOBAL_SETTING_DEFAULTS: ReadonlyArray<readonly [string, unknown]> = [
    ['hub.registry_url', 'https://cliqhub.io'],
    ['logging.level', 'info'],
    ['logging.format', 'text'],
    ['notifications.idle_threshold_minutes', 10],
    ['notifications.on_complete.enabled', true],
    ['notifications.on_error.enabled', true],
    ['docker.base_image', 'ghcr.io/sapshah/cliq-runtime:latest'],
];

const GLOBAL_DAEMON_ID = '__global__';

export interface ControlPlaneSeedResult {
    readonly scopes_inserted: number;
    readonly settings_inserted: number;
}

/**
 * Insert missing `__global__` settings. Platform scopes are seeded via SQL
 * migration — this function only handles daemon_config defaults.
 */
export async function seed_control_plane(): Promise<ControlPlaneSeedResult> {
    const settings_inserted = await seed_global_settings();
    log.debug('control_plane_seed_complete', {
        scopes_inserted: 0,
        settings_inserted,
    });
    return { scopes_inserted: 0, settings_inserted };
}

async function seed_global_settings(): Promise<number> {
    const now = Date.now();
    let inserted = 0;
    for (const [key, value] of GLOBAL_SETTING_DEFAULTS) {
        const existing = await DaemonConfig.findOne({
            where: { daemon_id: GLOBAL_DAEMON_ID, key },
        });
        if (existing) continue;
        await DaemonConfig.create({
            daemon_id: GLOBAL_DAEMON_ID,
            key,
            value: JSON.stringify(value),
            updated_at: now,
        });
        inserted += 1;
    }
    return inserted;
}
