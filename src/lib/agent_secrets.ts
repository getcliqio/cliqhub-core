/**
 * Secret agent settings (API keys, tokens, passwords).
 *
 * A setting is secret when its manifest definition says `secret: true`, or —
 * for manifests that predate the flag — when the last segment of its key is a
 * credential word (`api_key`, `github.token`, `client_secret`, `password`, …).
 *
 * Secret values are masked in `agents/get_settings` for callers without
 * `agents.reveal`. Runs are unaffected: daemons receive settings through
 * dispatch / team-list config, not this route.
 */

const SECRET_SEGMENTS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pat', 'credentials']);

export function is_secret_key(key: string, def?: { secret?: boolean } | null): boolean {
    if (key.startsWith('mcp.secrets.')) return true; // MCP placeholder secrets, whatever their name
    if (def?.secret === true) return true;
    if (def?.secret === false) return false;
    const last = key.toLowerCase().split(/[._-]/).filter(Boolean).pop() ?? '';
    return SECRET_SEGMENTS.has(last);
}

/** `••••` plus the last 4 characters (only when the value is long enough not to leak it). */
export function mask_secret(value: string): string {
    if (!value) return value;
    return value.length >= 12 ? `••••${value.slice(-4)}` : '••••';
}

/** Returns a copy of a SettingsData with secret values masked. */
export function mask_settings<T extends {
    settings: { required: Array<{ key: string; secret?: boolean }>; optional: Array<{ key: string; secret?: boolean }> };
    values: Record<string, string>;
}>(data: T): T {
    const defs = new Map([...data.settings.required, ...data.settings.optional].map((d) => [d.key, d]));
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.values ?? {})) {
        values[k] = is_secret_key(k, defs.get(k)) ? mask_secret(v) : v;
    }
    return { ...data, values };
}
