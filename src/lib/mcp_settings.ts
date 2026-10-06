/**
 * MCP server settings for agents whose manifest has an `mcp` block.
 *
 *   mcp.servers          JSON in the standard `mcpServers` shape:
 *                        { "<name>": { url, headers } | { command, args, env } }
 *   mcp.secrets.<NAME>   one secret per `${NAME}` placeholder used in mcp.servers
 *
 * The same rules as cliq-sdk `src/mcp.ts` (the daemon and agents use that
 * copy); keep the two in step. Core uses them to accept and validate the
 * keys, and to list the secrets a server list needs (they count as required).
 */

import type { SettingDef } from '../schemas/settings_types.js';

/** Settings key holding the server list. */
export const MCP_SERVERS_KEY = 'mcp.servers';
/** Settings key prefix for placeholder secrets. */
export const MCP_SECRET_PREFIX = 'mcp.secrets.';

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_KEY_RE = /^mcp\.secrets\.[A-Z][A-Z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\$\{([A-Z][A-Z0-9_]{0,63})\}/g;

/** A manifest's `mcp` block (only what Core reads). */
export interface McpManifestBlock {
    transports: Array<'http' | 'stdio'>;
    allow_custom?: boolean;
    presets?: Array<{ name: string; secrets?: Array<{ key: string; description?: string }> }>;
}

/** One server entry. */
interface McpServer {
    url?: unknown; headers?: unknown; command?: unknown; args?: unknown; env?: unknown;
}

/**
 * The manifest's `mcp` block when it is usable, else null.
 *
 * @param manifest - Agent manifest.
 */
export function mcp_block(manifest: Record<string, unknown> | null | undefined): McpManifestBlock | null {
    const mcp = manifest?.['mcp'] as McpManifestBlock | undefined;
    if (!mcp || typeof mcp !== 'object' || !Array.isArray(mcp.transports) || mcp.transports.length === 0) return null;
    return mcp;
}

/**
 * True when `key` is an MCP key this agent accepts.
 *
 * @param manifest - Agent manifest.
 * @param key - Setting key.
 */
export function is_mcp_key(manifest: Record<string, unknown> | null | undefined, key: string): boolean {
    if (!mcp_block(manifest)) return false;
    return key === MCP_SERVERS_KEY || SECRET_KEY_RE.test(key);
}

/** True for a plain object of string values. */
function is_string_map(v: unknown): boolean {
    return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

/**
 * Parse an `mcp.servers` value; accepts the bare map or `{ mcpServers: {…} }`.
 * Returns the server map, or the problems found.
 *
 * @param value - The setting value (JSON text).
 * @param mcp - The agent's `mcp` block.
 */
export function parse_mcp_servers(value: string, mcp: McpManifestBlock): { servers: Record<string, McpServer> } | { errors: string[] } {
    if (!value.trim()) return { servers: {} };
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return { errors: ['mcp.servers is not valid JSON'] };
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'mcpServers' in raw) raw = (raw as { mcpServers: unknown }).mcpServers;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['mcp.servers must be an object of { "<name>": { … } }'] };

    const presets = new Set((mcp.presets ?? []).map((p) => p.name));
    const errors: string[] = [];
    for (const [name, s] of Object.entries(raw as Record<string, unknown>)) {
        const where = `server '${name}'`;
        if (!NAME_RE.test(name)) { errors.push(`${where}: name must be 1-64 letters, digits, '-' or '_'`); continue; }
        if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push(`${where}: must be an object`); continue; }
        if (!presets.has(name) && !mcp.allow_custom) errors.push(`${where}: not a preset, and this agent does not allow custom servers`);
        const server = s as McpServer;
        const transport = typeof server.url === 'string' && server.url ? 'http' : typeof server.command === 'string' && server.command ? 'stdio' : null;
        if (!transport) { errors.push(`${where}: needs a url (http) or a command (stdio)`); continue; }
        if (server.url && server.command) errors.push(`${where}: has both url and command`);
        if (!mcp.transports.includes(transport)) errors.push(`${where}: transport '${transport}' is not supported by this agent`);
        if (transport === 'http') {
            let ok = false;
            try { ok = ['http:', 'https:'].includes(new URL(String(server.url)).protocol); } catch { ok = false; }
            if (!ok) errors.push(`${where}: url must be an http(s) URL`);
            if (server.headers !== undefined && !is_string_map(server.headers)) errors.push(`${where}: headers must map names to strings`);
        } else {
            if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every((a) => typeof a === 'string'))) errors.push(`${where}: args must be an array of strings`);
            if (server.env !== undefined && !is_string_map(server.env)) errors.push(`${where}: env must map names to strings`);
        }
    }
    return errors.length > 0 ? { errors } : { servers: raw as Record<string, McpServer> };
}

/**
 * `${NAME}` placeholders used by a server list, sorted and unique
 * (empty for an empty or invalid value).
 *
 * @param value - The `mcp.servers` value.
 * @param mcp - The agent's `mcp` block.
 */
export function mcp_placeholders(value: string | undefined, mcp: McpManifestBlock): string[] {
    if (!value) return [];
    const parsed = parse_mcp_servers(value, mcp);
    if ('errors' in parsed) return [];
    const names = new Set<string>();
    for (const s of Object.values(parsed.servers)) {
        const strings = [s.url, s.command, ...(Array.isArray(s.args) ? s.args : []),
            ...Object.values((s.headers ?? {}) as Record<string, unknown>), ...Object.values((s.env ?? {}) as Record<string, unknown>)];
        for (const str of strings) if (typeof str === 'string') for (const m of str.matchAll(PLACEHOLDER_RE)) names.add(m[1]!);
    }
    return [...names].sort();
}

/**
 * Setting definitions for an agent's MCP keys, given the effective server
 * list: `mcp.servers` (optional, type `mcp_servers`) plus one required
 * secret per placeholder it uses (described from the preset when known).
 *
 * @param manifest - Agent manifest.
 * @param servers_value - The effective `mcp.servers` value (realm, else org).
 */
export function mcp_setting_defs(
    manifest: Record<string, unknown> | null | undefined,
    servers_value: string | undefined,
): { required: SettingDef[]; optional: SettingDef[] } {
    const mcp = mcp_block(manifest);
    if (!mcp) return { required: [], optional: [] };
    const described = new Map<string, string>();
    for (const p of mcp.presets ?? []) for (const s of p.secrets ?? []) if (s.description) described.set(s.key, s.description);
    return {
        optional: [{ key: MCP_SERVERS_KEY, description: 'MCP servers this agent can use', type: 'mcp_servers' }],
        required: mcp_placeholders(servers_value, mcp).map((name) => ({
            key: `${MCP_SECRET_PREFIX}${name}`,
            description: described.get(name) ?? `Secret for \${${name}} in the MCP servers`,
            secret: true,
            type: 'secret',
        })),
    };
}
