/**
 * Options a person sets when starting a run, beyond inputs:
 *
 * - `reviewers` — who reviews each human phase of this run (`{ phase: [username] }`),
 *   replacing the team's defaults for those phases.
 * - `notify_channels` — notification channels (by name in the run's realm) that
 *   receive this run's lifecycle events instead of the realm's rules.
 *
 * Validation runs at enqueue (people and channels) and at dispatch (phase names
 * against the manifest that actually runs).
 */

import yaml from 'js-yaml';
import { Op } from 'sequelize';

import { ApiError } from '../errors/api_error.js';

/** Reviewers per human phase: `{ phase: [username] }`. */
export type RunReviewers = Record<string, string[]>;

/** Run lifecycle events that go to a run's own notification channels when it has them. */
export const RUN_NOTIFY_OVERRIDE_EVENTS: ReadonlySet<string> = new Set([
    'run.completed',
    'run.failed',
    'run.crashed',
    'run.cancelled',
    'phase.input_required',
    'phase.escalated',
]);

/**
 * Checks the people and channels of a run's start options.
 *
 * @param opts.realm_id - The run's realm; channel names are looked up there (skipped when unknown).
 * @throws ApiError 422 `invalid_params` with `details.field` (`reviewers` or `notify_channels`)
 *   and the names that were not found.
 */
export async function validate_run_start_options(opts: {
    realm_id?: string | null;
    reviewers?: RunReviewers;
    notify_channels?: string[];
}): Promise<void> {
    if (opts.reviewers) {
        const names = [...new Set(Object.values(opts.reviewers).flat())];
        const { User } = await import('../models/index.js');
        const rows = await User.findAll({
            where: { username: { [Op.in]: names }, status: 'active', deleted_at: null },
            attributes: ['username'],
            raw: true,
        }) as unknown as Array<{ username: string }>;
        const found = new Set(rows.map((r) => r.username));
        const unknown = names.filter((n) => !found.has(n));
        if (unknown.length > 0) {
            throw new ApiError('invalid_params', `Unknown reviewers: ${unknown.join(', ')}`, 422, { field: 'reviewers', unknown });
        }
    }
    const realm_id = opts.realm_id?.trim();
    if (opts.notify_channels && realm_id) {
        const { NotificationService } = await import('./notification.service.js');
        const unknown: string[] = [];
        for (const name of opts.notify_channels) {
            if (!(await NotificationService.find_channel_by_name(name, realm_id))) unknown.push(name);
        }
        if (unknown.length > 0) {
            throw new ApiError('invalid_params', `Unknown notification channels: ${unknown.join(', ')}`, 422, { field: 'notify_channels', unknown });
        }
    }
}

/**
 * Checks that every phase named in `reviewers` exists in the manifest that runs.
 *
 * @throws ApiError 422 `invalid_params` with `details: { field: 'reviewers', unknown_phases }`.
 */
export function assert_reviewer_phases(manifest_yaml: string | null | undefined, reviewers: RunReviewers | undefined): void {
    if (!reviewers || !manifest_yaml) return;
    let names: string[] = [];
    try {
        const doc = yaml.load(manifest_yaml) as { phases?: Array<{ name?: unknown }> } | null;
        names = (doc?.phases ?? []).map((p) => (typeof p?.name === 'string' ? p.name : '')).filter(Boolean);
    } catch {
        return;
    }
    const unknown_phases = Object.keys(reviewers).filter((p) => !names.includes(p));
    if (unknown_phases.length > 0) {
        throw new ApiError('invalid_params', `Reviewers set for phases the team does not have: ${unknown_phases.join(', ')}`, 422, { field: 'reviewers', unknown_phases });
    }
}
