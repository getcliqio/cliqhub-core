/**
 * Unit tests for agent catalog usage helpers + deregister team guard.
 *
 * Uses mocked AgentCatalog model — no database required.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { extract_agents_from_workflow } from '../../../src/lib/agent_catalog_usage.js';
import { ApiError } from '../../../src/lib/api_error.js';

vi.mock('../../../src/lib/agent_catalog_usage.js', async (import_original) => {
    const actual = await import_original<typeof import('../../../src/lib/agent_catalog_usage.js')>();
    return {
        ...actual,
        find_teams_using_agent: vi.fn(),
    };
});

vi.mock('../../../src/models/index.js', () => ({
    AgentCatalog: {
        findOne: vi.fn(),
        findAll: vi.fn(),
        create: vi.fn(),
    },
}));

import { find_teams_using_agent } from '../../../src/lib/agent_catalog_usage.js';
import { AgentCatalog } from '../../../src/models/index.js';
import { AgentService } from '../../../src/services/agent.service.js';

const ORG_ID = '00000000-0000-4000-a000-000000000001';

describe('extract_agents_from_workflow', () => {
    it('collects agents from phases and support, skipping team phases', () => {
        const agents = extract_agents_from_workflow(JSON.stringify({
            phases: [
                { agent: 'curl' },
                { type: 'team', agent: 'ignored' },
                { agent: '  lint  ' },
            ],
            support: [{ agent: 'notify' }],
        }));
        expect([...agents].sort()).toEqual(['curl', 'lint', 'notify']);
    });

    it('returns empty set for null/invalid', () => {
        expect(extract_agents_from_workflow(null).size).toBe(0);
        expect(extract_agents_from_workflow('not-json').size).toBe(0);
    });
});

describe('AgentService.deregister team guard', () => {
    let service: AgentService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new AgentService();
    });

    it('throws 409 agent/in_use when teams reference the agent', async () => {
        const update = vi.fn();
        vi.mocked(AgentCatalog.findAll).mockResolvedValue([{
            id: '1',
            name: 'curl',
            org_id: ORG_ID,
            is_system: false,
            deleted: false,
            update,
        } as never]);
        vi.mocked(find_teams_using_agent).mockResolvedValue([
            { scope: 'acme', name: 'ship', version: '1.0.0' },
        ]);

        try {
            await service.deregister(ORG_ID, { name: 'curl' });
            expect.fail('expected conflict');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiError);
            expect((err as ApiError).status_code).toBe(409);
            expect((err as ApiError).code).toBe('agent/in_use');
            expect((err as Error).message).toMatch(/@acme\/ship/);
        }
        expect(update).not.toHaveBeenCalled();
        expect(find_teams_using_agent).toHaveBeenCalledWith('curl');
    });

    it('soft-deletes when no teams reference the agent', async () => {
        const update = vi.fn().mockResolvedValue(undefined);
        vi.mocked(AgentCatalog.findAll).mockResolvedValue([{
            id: '1',
            name: 'curl',
            org_id: ORG_ID,
            is_system: false,
            deleted: false,
            update,
        } as never]);
        vi.mocked(find_teams_using_agent).mockResolvedValue([]);

        const result = await service.deregister(ORG_ID, { name: 'curl' });
        expect(result).toBe(true);
        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            deleted: true,
            deleted_at: expect.any(Number),
        }));
    });

    it('blocks deregistration of system agents (403)', async () => {
        vi.mocked(AgentCatalog.findAll).mockResolvedValue([{
            id: '1',
            name: 'exec',
            org_id: null,
            is_system: true,
            deleted: false,
        } as never]);

        try {
            await service.deregister(ORG_ID, { name: 'exec' });
            expect.fail('expected forbidden');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiError);
            expect((err as ApiError).status_code).toBe(403);
            expect((err as Error).message).toMatch(/system agent/);
        }
    });
});
