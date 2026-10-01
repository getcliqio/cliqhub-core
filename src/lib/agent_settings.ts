/**
 * Agent settings schema helpers — normalise manifest `settings` blocks.
 *
 * `resolve_agent_settings` turns raw manifest entries (bare key strings or
 * partial SettingDef objects) into a fully-typed list, adding `secret: true`
 * to keys that are credentials by name or by explicit flag.
 *
 * `setting_applies` / `applicable_settings` evaluate the optional `when` guard
 * so callers only render/resolve settings whose conditions are met.
 */

import type { SettingDef } from '../schemas/settings_types.js';
import { is_secret_key } from './agent_secrets.js';

export const SCALAR_INPUT_TYPES = new Set(['string', 'number', 'boolean']);

export const SKIP_PROMOTE_INPUTS = new Set([
    'role', 'task', 'commands', 'action', 'review', 'team', 'notify',
    'sources', 'target_entries', 'team_inputs',
]);

function _as_setting(entry: string | SettingDef): SettingDef {
    if (typeof entry === 'string') {
        const result: SettingDef = { key: entry };
        if (is_secret_key(entry)) result.secret = true;
        return result;
    }
    const result: SettingDef = {
        key: entry.key,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.default !== undefined ? { default: entry.default } : {}),
        ...(entry.when && typeof entry.when === 'object' ? { when: entry.when } : {}),
    };
    if (entry.secret === true || is_secret_key(entry.key, entry)) {
        result.secret = true;
    }
    return result;
}

/**
 * Return `true` when a setting's `when` condition is satisfied by `values`.
 *
 * A setting with no `when` guard (or an empty one) always applies.
 * The special key `provider` defaults to `"github"` when absent.
 *
 * @param setting - Raw string key or {@link SettingDef} with optional `when`.
 * @param values - Current resolved setting values map.
 */
export function setting_applies(
    setting: SettingDef | string,
    values: Record<string, string | undefined | null>,
): boolean {
    if (typeof setting === 'string') return true;
    const when = setting.when;
    if (!when || Object.keys(when).length === 0) return true;
    for (const [key, expected] of Object.entries(when)) {
        let actual = values[key];
        if ((actual == null || actual === '') && key === 'provider') {
            actual = 'github';
        }
        if (String(actual ?? '') !== expected) return false;
    }
    return true;
}

/** Filter `settings` to those whose `when` condition is met by `values`. */
export function applicable_settings(
    settings: SettingDef[],
    values: Record<string, string | undefined | null>,
): SettingDef[] {
    return settings.filter((s) => setting_applies(s, values));
}

/**
 * Normalise a manifest's `settings` block into typed required/optional arrays.
 *
 * Bare string entries (e.g. `"api_token"`) are promoted to `{ key, secret: true }`
 * when `is_secret_key` matches. Scalar inputs from `manifest.inputs` that are not
 * already declared in `settings` are promoted into `optional`.
 *
 * @param manifest - Raw parsed manifest object. Only `settings` and `inputs` are read.
 * @returns `{ required, optional }` arrays of normalised {@link SettingDef} objects.
 */
export function resolve_agent_settings(manifest: Record<string, unknown>): {
    required: SettingDef[];
    optional: SettingDef[];
} {
    const raw_settings = (manifest.settings ?? {}) as {
        required?: Array<string | SettingDef>;
        optional?: Array<string | SettingDef>;
    };
    const required = (raw_settings.required ?? []).map(_as_setting);
    const optional = (raw_settings.optional ?? []).map(_as_setting);
    const known = new Set([...required, ...optional].map((s) => s.key));

    const raw_inputs = manifest.inputs;
    if (!raw_inputs || typeof raw_inputs !== 'object') {
        return { required, optional };
    }

    if (!Array.isArray(raw_inputs)) {
        for (const [name, meta] of Object.entries(raw_inputs as Record<string, unknown>)) {
            if (!name.trim() || known.has(name) || SKIP_PROMOTE_INPUTS.has(name)) continue;
            const m = (meta && typeof meta === 'object' && !Array.isArray(meta))
                ? meta as Record<string, unknown>
                : {};
            if (m['required'] === true) continue;
            if (m['source'] === 'runtime') continue;
            const type = typeof m['type'] === 'string' ? m['type'] : 'string';
            if (!SCALAR_INPUT_TYPES.has(type)) continue;
            optional.push({
                key: name,
                ...(typeof m['description'] === 'string'
                    ? { description: m['description'] as string }
                    : {}),
                ...(m['default'] !== undefined ? { default: m['default'] } : {}),
            });
            known.add(name);
        }
        return { required, optional };
    }

    for (const entry of raw_inputs as Array<Record<string, unknown>>) {
        if (!entry || typeof entry !== 'object') continue;
        const name = typeof entry['name'] === 'string' ? entry['name'] : '';
        if (!name.trim() || known.has(name) || SKIP_PROMOTE_INPUTS.has(name)) continue;
        if (entry['required'] === true) continue;
        if (entry['source'] === 'runtime') continue;
        const type = typeof entry['type'] === 'string' ? entry['type'] : 'string';
        if (!SCALAR_INPUT_TYPES.has(type)) continue;
        optional.push({
            key: name,
            ...(typeof entry['description'] === 'string'
                ? { description: entry['description'] as string }
                : {}),
            ...(entry['default'] !== undefined ? { default: entry['default'] } : {}),
        });
        known.add(name);
    }
    return { required, optional };
}
