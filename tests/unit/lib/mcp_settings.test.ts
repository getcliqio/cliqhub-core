/**
 * MCP settings rules (src/lib/mcp_settings.ts): which keys an agent accepts,
 * server list validation against the manifest, placeholders → required secrets.
 */
import { describe, expect, it } from 'vitest';

import { is_mcp_key, mcp_placeholders, mcp_setting_defs, parse_mcp_servers, type McpManifestBlock } from '../../../src/lib/mcp_settings.js';
import { is_secret_key } from '../../../src/lib/agent_secrets.js';

const MCP: McpManifestBlock = {
    transports: ['http', 'stdio'],
    allow_custom: true,
    presets: [{ name: 'linear', secrets: [{ key: 'LINEAR_API_KEY', description: 'Linear personal API key' }] }],
};
const manifest = { name: 'claude-api', mcp: MCP };

const servers = JSON.stringify({
    linear: { url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' } },
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } },
});

describe('is_mcp_key', () => {
    it('accepts mcp.servers and mcp.secrets.UPPER_SNAKE only when the manifest has mcp', () => {
        expect(is_mcp_key(manifest, 'mcp.servers')).toBe(true);
        expect(is_mcp_key(manifest, 'mcp.secrets.GITHUB_TOKEN')).toBe(true);
        expect(is_mcp_key(manifest, 'mcp.secrets.lower')).toBe(false);
        expect(is_mcp_key(manifest, 'mcp.other')).toBe(false);
        expect(is_mcp_key({ name: 'exec' }, 'mcp.servers')).toBe(false);
    });

    it('mcp secrets are always secret, whatever the name', () => {
        expect(is_secret_key('mcp.secrets.SENTRY_DSN')).toBe(true);
    });
});

describe('parse_mcp_servers', () => {
    it('accepts http and stdio servers, and the pasted { mcpServers } wrapper', () => {
        expect('servers' in parse_mcp_servers(servers, MCP)).toBe(true);
        const wrapped = parse_mcp_servers(JSON.stringify({ mcpServers: JSON.parse(servers) }), MCP);
        expect('servers' in wrapped && Object.keys(wrapped.servers)).toEqual(['linear', 'github']);
        expect(parse_mcp_servers('', MCP)).toEqual({ servers: {} });
    });

    it('rejects bad JSON, transports the agent cannot run, custom servers when not allowed, bad URLs', () => {
        expect(parse_mcp_servers('{', MCP)).toEqual({ errors: ['mcp.servers is not valid JSON'] });
        const http_only = { ...MCP, transports: ['http' as const] };
        expect(parse_mcp_servers(servers, http_only)).toEqual({ errors: ["server 'github': transport 'stdio' is not supported by this agent"] });
        const presets_only = { ...MCP, allow_custom: false };
        expect(parse_mcp_servers(servers, presets_only)).toEqual({ errors: ["server 'github': not a preset, and this agent does not allow custom servers"] });
        expect(parse_mcp_servers(JSON.stringify({ x: { url: 'ftp://a' } }), MCP)).toEqual({ errors: ["server 'x': url must be an http(s) URL"] });
        expect(parse_mcp_servers(JSON.stringify({ x: {} }), MCP)).toEqual({ errors: ["server 'x': needs a url (http) or a command (stdio)"] });
    });
});

describe('mcp_setting_defs', () => {
    it('lists mcp.servers plus one required secret per placeholder, described from the preset', () => {
        expect(mcp_placeholders(servers, MCP)).toEqual(['GITHUB_TOKEN', 'LINEAR_API_KEY']);
        const defs = mcp_setting_defs(manifest, servers);
        expect(defs.optional).toEqual([{ key: 'mcp.servers', description: 'MCP servers this agent can use', type: 'mcp_servers' }]);
        expect(defs.required.map((d) => [d.key, d.description, d.secret])).toEqual([
            ['mcp.secrets.GITHUB_TOKEN', 'Secret for ${GITHUB_TOKEN} in the MCP servers', true],
            ['mcp.secrets.LINEAR_API_KEY', 'Linear personal API key', true],
        ]);
    });

    it('nothing for an agent without mcp; no secrets for an empty list', () => {
        expect(mcp_setting_defs({ name: 'exec' }, servers)).toEqual({ required: [], optional: [] });
        expect(mcp_setting_defs(manifest, undefined).required).toEqual([]);
    });
});
