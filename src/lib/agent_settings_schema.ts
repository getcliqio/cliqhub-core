/**
 * Helpers for agent setting schemas derived from manifests.
 *
 * Optional scalar phase inputs (model, temperature, …) are promoted into
 * settings.optional so account/realm UIs can store defaults.
 */

import type { SettingDef } from '../schemas/settings_schemas.js';

/** @deprecated Use SettingDef from schemas/settings_schemas. */
export type Setting_def = SettingDef;

const SCALAR_INPUT_TYPES = new Set(['string', 'number', 'boolean']);

const SKIP_PROMOTE_INPUTS = new Set([
    'role', 'task', 'commands', 'action', 'review', 'team', 'notify',
    'sources', 'target_entries', 'team_inputs',
]);

function _as_setting(entry: string | SettingDef): SettingDef {
    if (typeof entry === 'string') return { key: entry };
    return {
        key: entry.key,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.default !== undefined ? { default: entry.default } : {}),
        ...(entry.when && typeof entry.when === 'object' ? { when: entry.when } : {}),
    };
}

/** Whether a setting applies given current values (missing provider → github). */
export function setting_applies(setting: SettingDef | string, values: Record<string, string | undefined | null>): boolean {
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

export function applicable_settings(settings: SettingDef[], values: Record<string, string | undefined | null>): SettingDef[] {
    return settings.filter((s) => setting_applies(s, values));
}

/**
 * Merge manifest.settings with optional scalar inputs promoted into
 * settings.optional (idempotent if already present).
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

    // Object form: { model: { type, required, default, description, source } }
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

    // Array form (registry): [{ name, type, required, default, description }]
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
