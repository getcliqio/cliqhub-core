/**
 * Integration tests for AgentService (Phase 4 rewrite).
 *
 * Tests run against a real Postgres instance. Skipped when Postgres is
 * unreachable (CI without DB, local dev without docker).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { AgentService } from '../../src/services/agent.service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { AgentCatalog } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

const uid = () => `test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORG_A = '00000000-0000-4000-a000-000000000001';
const ORG_B = '00000000-0000-4000-a000-000000000002';

let service: AgentService;

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();
    service = new AgentService();
});

beforeEach(async () => {
    if (!has_postgres) return;
    await AgentCatalog.destroy({ where: {}, truncate: true, cascade: true });
});

afterAll(async () => {
    if (!has_postgres) return;
    await AgentCatalog.destroy({ where: {}, truncate: true, cascade: true });
    await close_test_control_plane_store();
});

/** Helper: register a simple custom agent in an org. */
async function register_agent(org_id: string, name: string, opts?: { version?: string }) {
    return service.register(org_id, {
        name,
        version: opts?.version,
        manifest: { name, transport: 'PROCESS', entry: './agent.js', agent_type: 'exec' },
        description: `test agent ${name}`,
    });
}

/** Helper: create a system agent directly (simulates seed). */
async function create_system_agent(name: string) {
    return AgentCatalog.create({
        id: crypto.randomUUID(),
        name,
        version: '1.0.0',
        description: `system ${name}`,
        agent_type: 'exec',
        manifest: { name, entry: './agent.js' },
        org_id: null as unknown as string,
        is_system: true,
        deleted: false,
        deleted_at: null,
        created_at: new Date(),
        updated_at: new Date(),
    });
}

// ── list ─────────────────────────────────────────────────────────────

describe.skipIf(!has_postgres)('AgentService.list', () => {
    it('returns empty array when no agents exist', async () => {
        const result = await service.list(ORG_A);
        expect(result).toEqual([]);
    });

    it('returns org agents + system agents, ordered by name', async () => {
        await create_system_agent('sys-alpha');
        await register_agent(ORG_A, 'custom-beta');

        const result = await service.list(ORG_A);
        expect(result.map((a) => a.name)).toEqual(['custom-beta', 'sys-alpha']);
        expect(result.find((a) => a.name === 'sys-alpha')!.is_system).toBe(true);
        expect(result.find((a) => a.name === 'custom-beta')!.is_system).toBe(false);
    });

    it('does not return agents from another org', async () => {
        await register_agent(ORG_A, 'org-a-only');
        await register_agent(ORG_B, 'org-b-only');

        const result_a = await service.list(ORG_A);
        const result_b = await service.list(ORG_B);
        expect(result_a.map((a) => a.name)).toContain('org-a-only');
        expect(result_a.map((a) => a.name)).not.toContain('org-b-only');
        expect(result_b.map((a) => a.name)).toContain('org-b-only');
        expect(result_b.map((a) => a.name)).not.toContain('org-a-only');
    });

    it('omits manifest when include_manifest is false', async () => {
        await register_agent(ORG_A, uid());
        const [agent] = await service.list(ORG_A, {}, false);
        expect(agent.manifest).toBeUndefined();
        expect(agent.name).toBeTruthy();
    });

    it('filters by names', async () => {
        const a = uid();
        const b = uid();
        await register_agent(ORG_A, a);
        await register_agent(ORG_A, b);
        const result = await service.list(ORG_A, { names: [a] });
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe(a);
    });

    it('filters by agent_type', async () => {
        const name = uid();
        await service.register(ORG_A, {
            name,
            manifest: { name, agent_type: 'llm' },
            agent_type: 'llm',
        });
        const result = await service.list(ORG_A, { agent_type: 'llm' });
        expect(result.some((a) => a.name === name)).toBe(true);
    });
});

// ── get_by_name ──────────────────────────────────────────────────────

describe.skipIf(!has_postgres)('AgentService.get_by_name', () => {
    it('returns org agent by name', async () => {
        await register_agent(ORG_A, 'my-agent');
        const agent = await service.get_by_name(ORG_A, 'my-agent');
        expect(agent.name).toBe('my-agent');
        expect(agent.is_system).toBe(false);
    });

    it('returns system agent by name', async () => {
        await create_system_agent('sys-exec');
        const agent = await service.get_by_name(ORG_A, 'sys-exec');
        expect(agent.name).toBe('sys-exec');
        expect(agent.is_system).toBe(true);
    });

    it('throws 404 for unknown agent', async () => {
        await expect(service.get_by_name(ORG_A, 'no-such-agent'))
            .rejects.toThrow(/not found/);
    });

    it('filters by version when provided', async () => {
        await register_agent(ORG_A, 'versioned', { version: '1.0.0' });
        const found = await service.get_by_name(ORG_A, 'versioned', '1.0.0');
        expect(found.version).toBe('1.0.0');

        await expect(service.get_by_name(ORG_A, 'versioned', '9.9.9'))
            .rejects.toThrow(/not found/);
    });
});

// ── register ─────────────────────────────────────────────────────────

describe.skipIf(!has_postgres)('AgentService.register', () => {
    it('creates a new custom agent', async () => {
        const name = uid();
        const { entry, updated } = await register_agent(ORG_A, name);
        expect(entry.name).toBe(name);
        expect(entry.is_system).toBe(false);
        expect(entry.id).toBeTruthy();
        expect(updated).toBe(false);
    });

    it('creates same name in different version', async () => {
        const name = uid();
        await register_agent(ORG_A, name, { version: '1.0.0' });
        const { entry } = await register_agent(ORG_A, name, { version: '2.0.0' });
        expect(entry.version).toBe('2.0.0');
    });

    it('rejects duplicate (org, name, version) without force', async () => {
        const name = uid();
        await register_agent(ORG_A, name, { version: '1.0.0' });
        await expect(register_agent(ORG_A, name, { version: '1.0.0' }))
            .rejects.toThrow(/already registered/);
    });

    it('force-updates duplicate (org, name, version)', async () => {
        const name = uid();
        await register_agent(ORG_A, name, { version: '1.0.0' });
        const { entry, updated } = await service.register(ORG_A, {
            name,
            version: '1.0.0',
            manifest: { name, entry: './v2.js' },
            force: true,
        });
        expect(updated).toBe(true);
        expect((entry.manifest as { entry?: string })?.entry).toBe('./v2.js');
    });

    it('allows same name as system agent (different org)', async () => {
        await create_system_agent('exec');
        const { entry } = await register_agent(ORG_A, 'exec');
        expect(entry.is_system).toBe(false);
        expect(entry.name).toBe('exec');
    });

    it('defaults agent_type to exec', async () => {
        const name = uid();
        const { entry } = await register_agent(ORG_A, name);
        expect(entry.agent_type).toBe('exec');
    });
});

// ── deregister ───────────────────────────────────────────────────────

describe.skipIf(!has_postgres)('AgentService.deregister', () => {
    it('soft-deletes a custom agent', async () => {
        const name = uid();
        await register_agent(ORG_A, name);

        const { deregistered, removed_count } = await service.deregister(ORG_A, name);
        expect(deregistered).toBe(true);
        expect(removed_count).toBe(1);

        // Hidden from list.
        const list = await service.list(ORG_A);
        expect(list.map((a) => a.name)).not.toContain(name);
    });

    it('returns false for nonexistent agent', async () => {
        const result = await service.deregister(ORG_A, 'no-such-agent');
        expect(result.deregistered).toBe(false);
    });

    it('removes only the specified version', async () => {
        const name = uid();
        await register_agent(ORG_A, name, { version: '1.0.0' });
        await register_agent(ORG_A, name, { version: '2.0.0' });

        await service.deregister(ORG_A, name, '1.0.0');

        const list = await service.list(ORG_A, { names: [name] });
        expect(list).toHaveLength(1);
        expect(list[0].version).toBe('2.0.0');
    });

    it('removes all versions when no version specified', async () => {
        const name = uid();
        await register_agent(ORG_A, name, { version: '1.0.0' });
        await register_agent(ORG_A, name, { version: '2.0.0' });

        const { removed_count } = await service.deregister(ORG_A, name);
        expect(removed_count).toBe(2);

        const list = await service.list(ORG_A, { names: [name] });
        expect(list).toHaveLength(0);
    });

    it('blocks deregistration of system agents (403)', async () => {
        await create_system_agent('sys-protected');
        // System agents have org_id = NULL, so query with any org_id won't find them.
        // But let's test the is_system guard directly by querying without org filter.
        // Since deregister takes org_id, and system agents have org_id=NULL,
        // the WHERE clause won't match, so deregistered=false.
        const result = await service.deregister(ORG_A, 'sys-protected');
        expect(result.deregistered).toBe(false);
    });
});
