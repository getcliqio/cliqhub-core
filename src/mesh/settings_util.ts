import type { Mesh_settings_field } from './types.js';
import { get_mesh_adapter, try_get_mesh_adapter } from './registry.js';

const SECRET_MASK = '••••••••';

export function mask_provider_settings(
    provider_id: string,
    settings: Record<string, unknown>,
): Record<string, unknown> {
    const adapter = try_get_mesh_adapter(provider_id);
    if (!adapter) return { ...settings };

    const secret_keys = new Set(
        adapter.settings_schema.filter((field) => field.type === 'secret').map((f) => f.key),
    );
    const out: Record<string, unknown> = { ...settings };
    for (const key of secret_keys) {
        if (out[key] != null && String(out[key]).length > 0) {
            out[key] = SECRET_MASK;
            out[`${key}_set`] = true;
        }
    }
    return out;
}

export function merge_provider_settings_patch(
    provider_id: string,
    existing: Record<string, unknown>,
    patch: Record<string, unknown>,
): Record<string, unknown> {
    get_mesh_adapter(provider_id); // validates known provider
    const adapter = get_mesh_adapter(provider_id);
    const secret_keys = new Set(
        adapter.settings_schema.filter((field) => field.type === 'secret').map((f) => f.key),
    );

    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
        if (key.endsWith('_set')) continue;
        if (secret_keys.has(key) && (value === SECRET_MASK || value === '' || value == null)) {
            continue;
        }
        merged[key] = value;
    }
    return merged;
}

export function public_a2a_base_url(): string {
    const from_env =
        process.env.CLIQHUB_PUBLIC_API_URL
        || process.env.CLIQHUB_PUBLIC_URL
        || 'https://api.cliqhub.io';
    return from_env.replace(/\/$/, '');
}

/** @deprecated Use realm_public_a2a_url_org for org-scoped URLs. */
export function realm_public_a2a_url(slug: string): string {
    return `${public_a2a_base_url()}/a2a/r/${slug}`;
}

/** Build the org-scoped public A2A URL for a realm. */
export function realm_public_a2a_url_org(org_slug: string, realm_slug: string): string {
    return `${public_a2a_base_url()}/a2a/o/${org_slug}/r/${realm_slug}`;
}

export function schema_defaults(schema: Mesh_settings_field[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema) {
        if (field.default !== undefined) out[field.key] = field.default;
    }
    return out;
}
