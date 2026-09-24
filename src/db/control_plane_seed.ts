/**
 * Idempotent control-plane seed for schema `cliq`.
 *
 * Mirrors the former Core API (`cliq-platform/bff`) bootstrap for:
 *   - runtime scopes (`cliq.scopes`) used by control-plane tenancy
 *   - org-wide defaults on `daemon_config` with daemon_id `__global__`
 *
 * Does not touch Hub `public.*` registry tables. Safe to re-run on every boot.
 */

import { DaemonConfig, Scope } from '@getcliqio/cliq-store';
import { get_logger } from '../lib/log.js';

const log = get_logger('control-plane-seed');

/** Fixed UUIDs keep seed rows stable across environments. */
const CONTROL_PLANE_SCOPES = [
    {
        id: '00000000-0000-0000-0000-000000000000',
        slug: 'cliq',
        name: 'Cliq',
        is_default: 1 as const,
        created_at: 0,
    },
    {
        id: '00000000-0000-0000-0000-000000000001',
        slug: 'measureone',
        name: 'MeasureOne',
        is_default: 0 as const,
        created_at: 0,
    },
] as const;

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
 * Insert missing control-plane scopes and `__global__` settings.
 * Existing rows are left unchanged (ignoreDuplicates / skip-if-present).
 */
export async function seed_control_plane(): Promise<ControlPlaneSeedResult> {
    const scopes_inserted = await seed_control_plane_scopes();
    const settings_inserted = await seed_global_settings();
    log.debug('control_plane_seed_complete', {
        scopes_inserted,
        settings_inserted,
    });
    return { scopes_inserted, settings_inserted };
}

async function seed_control_plane_scopes(): Promise<number> {
    let inserted = 0;
    for (const row of CONTROL_PLANE_SCOPES) {
        const existing = await Scope.findByPk(row.id);
        if (existing) continue;
        const by_slug = await Scope.findOne({ where: { slug: row.slug } });
        if (by_slug) continue;
        await Scope.create({
            id: row.id,
            slug: row.slug,
            name: row.name,
            org_id: null,
            scope_type: null,
            is_default: row.is_default,
            created_at: row.created_at,
        });
        inserted += 1;
    }
    return inserted;
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
