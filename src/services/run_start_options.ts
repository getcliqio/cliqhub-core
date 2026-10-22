/**
 * Checks on a run started from CliqHub, beyond inputs:
 *
 * - `notify_channels` — notification channels (by name, ones the run's realm can use) that
 *   receive this run's lifecycle events instead of the realm's rules.
 * - The channels the run will ask people through (PLAN-notifications-v2 B4.2): every `type: channel`
 *   input's value and every channel a Hug gate (`review.reviewers`) or a phase's `hug` block names, fixed
 *   or `{{inputs.x}}`, must be a channel the realm can use.
 *
 * Validation runs at enqueue (notify channels) and at dispatch (the manifest that actually runs).
 */

import yaml from 'js-yaml';

import { ApiError } from '../errors/api_error.js';

/** Run lifecycle events that go to a run's own notification channels when it has them. */
export const RUN_NOTIFY_OVERRIDE_EVENTS: ReadonlySet<string> = new Set([
    'run.completed',
    'run.failed',
    'run.crashed',
    'run.cancelled',
    'phase.escalated',
]);

/**
 * Checks a run's notify channels.
 *
 * @param opts.realm_id - The run's realm; channel names are looked up there (skipped when unknown).
 * @throws ApiError 422 `invalid_params` with `details: { field: 'notify_channels', unknown }`.
 */
export async function validate_run_start_options(opts: {
    realm_id?: string | null;
    notify_channels?: string[];
}): Promise<void> {
    const realm_id = opts.realm_id?.trim();
    if (opts.notify_channels && realm_id) {
        const { NotificationService } = await import('./notification.service.js');
        const unknown: string[] = [];
        for (const name of opts.notify_channels) {
            if ((await NotificationService.find_realm_usable_channels(name, realm_id)).length === 0) unknown.push(name);
        }
        if (unknown.length > 0) {
            throw new ApiError('invalid_params', `Unknown notification channels: ${unknown.join(', ')}`, 422, { field: 'notify_channels', unknown });
        }
    }
}

/** A whole-value input reference: `{{inputs.x}}` or `$(inputs.x)`. */
const INPUT_REF = /^\s*(?:\{\{\s*inputs\.([^}\s]+)\s*\}\}|\$\(\s*inputs\.([^)\s]+)\s*\))\s*$/;

/** A channel name the run will use, and where it comes from (for the message). */
export interface RunChannelName {
    name: string;
    from: string;
}

/** An input's value as channel names (a list, or a comma-separated string). */
function channel_values(value: unknown): string[] {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return list.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

/**
 * The channel names a run will ask people through: `type: channel` inputs' values, and each Hug gate's
 * reviewers and each phase's `hug.channels` — a fixed name as written, an input reference as that input's
 * value. Names that still hold a template (part of a longer string) can't be checked and are left out.
 */
export function run_channel_names(manifest_yaml: string | null | undefined, inputs: Record<string, unknown>): RunChannelName[] {
    if (!manifest_yaml) return [];
    let doc: { inputs?: unknown; phases?: unknown; support?: unknown } | null;
    try {
        doc = yaml.load(manifest_yaml) as typeof doc;
    } catch {
        return [];
    }
    if (!doc || typeof doc !== 'object') return [];
    const out: RunChannelName[] = [];
    const add = (name: string, from: string) => {
        if (name.includes('{{') || name.includes('$(')) return;
        if (!out.some((c) => c.name === name)) out.push({ name, from });
    };
    for (const decl of Array.isArray(doc.inputs) ? doc.inputs : []) {
        const d = decl as { name?: unknown; type?: unknown } | null;
        if (d?.type !== 'channel' || typeof d.name !== 'string') continue;
        for (const v of channel_values(inputs[d.name])) add(v, `input '${d.name}'`);
    }
    const phases = [...(Array.isArray(doc.phases) ? doc.phases : []), ...(Array.isArray(doc.support) ? doc.support : [])];
    for (const raw of phases) {
        const phase = raw as { name?: unknown; agent?: unknown; review?: { reviewers?: unknown }; hug?: { channels?: unknown } } | null;
        if (!phase || typeof phase !== 'object') continue;
        const from = `phase '${typeof phase.name === 'string' ? phase.name : '?'}'`;
        const written: unknown[] = [];
        if (phase.agent === 'hug' && Array.isArray(phase.review?.reviewers)) {
            for (const g of phase.review.reviewers) {
                const channels = (g as { channels?: unknown } | null)?.channels;
                if (Array.isArray(channels)) written.push(...channels);
            }
        }
        if (Array.isArray(phase.hug?.channels)) written.push(...phase.hug.channels);
        for (const w of written) {
            if (typeof w !== 'string' || !w.trim()) continue;
            const ref = INPUT_REF.exec(w);
            if (ref) {
                for (const v of channel_values(inputs[ref[1] ?? ref[2]])) add(v, from);
            } else {
                add(w.trim(), from);
            }
        }
    }
    return out;
}

/**
 * Refuses a run whose channels (see {@link run_channel_names}) aren't all channels its realm can use.
 *
 * @throws ApiError 422 `invalid_params` with `details: { field: 'channels', unknown }` naming each one.
 */
export async function assert_run_channels(opts: {
    realm_id?: string | null;
    manifest_yaml?: string | null;
    inputs: Record<string, unknown>;
}): Promise<void> {
    const realm_id = opts.realm_id?.trim();
    if (!realm_id) return;
    const names = run_channel_names(opts.manifest_yaml, opts.inputs);
    if (names.length === 0) return;
    const { NotificationService } = await import('./notification.service.js');
    const unknown: RunChannelName[] = [];
    for (const c of names) {
        if ((await NotificationService.find_realm_usable_channels(c.name, realm_id)).length === 0) unknown.push(c);
    }
    if (unknown.length > 0) {
        throw new ApiError(
            'invalid_params',
            `Unknown channel${unknown.length > 1 ? 's' : ''}: ${unknown.map((c) => `'${c.name}' (${c.from})`).join(', ')} — not a channel this realm can use`,
            422,
            { field: 'channels', unknown: unknown.map((c) => c.name) },
        );
    }
}
