/**
 * Tests for validate_agents_for_dispatch and parse_agent_ref
 * in agent_catalog_usage.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock AgentCatalog before import ──
const { mock_find_one, mock_find_all } = vi.hoisted(() => ({
    mock_find_one: vi.fn(),
    mock_find_all: vi.fn(),
}));

vi.mock('../../../src/models/agent_catalog.model.js', () => ({
    AgentCatalog: {
        findOne: mock_find_one,
        findAll: mock_find_all,
    },
}));

vi.mock('../../../src/db/sequelize.js', () => ({
    get_sequelize: vi.fn(),
}));

import {
    parse_agent_ref,
    validate_agents_for_dispatch,
    extract_agents_from_workflow,
} from '../../../src/lib/agent_catalog_usage.js';


// ---------------------------------------------------------------------------
// parse_agent_ref
// ---------------------------------------------------------------------------

describe('parse_agent_ref', () => {
    it('parses bare name', () => {
        expect(parse_agent_ref('exec')).toEqual({ name: 'exec', version: null });
    });

    it('parses name@version', () => {
        expect(parse_agent_ref('my-linter@0.3.0')).toEqual({ name: 'my-linter', version: '0.3.0' });
    });

    it('handles @ at start', () => {
        expect(parse_agent_ref('@scoped')).toEqual({ name: '@scoped', version: null });
    });

    it('handles trailing @', () => {
        expect(parse_agent_ref('agent@')).toEqual({ name: 'agent@', version: null });
    });
});


// ---------------------------------------------------------------------------
// extract_agents_from_workflow (existing, but ensure version refs work)
// ---------------------------------------------------------------------------

describe('extract_agents_from_workflow', () => {
    it('extracts versioned agent refs as-is', () => {
        const wf = JSON.stringify({
            phases: [
                { name: 'lint', agent: 'my-linter@0.3.0' },
                { name: 'run', agent: 'exec' },
            ],
        });
        const agents = extract_agents_from_workflow(wf);
        expect(agents).toEqual(new Set(['my-linter@0.3.0', 'exec']));
    });
});


// ---------------------------------------------------------------------------
// validate_agents_for_dispatch
// ---------------------------------------------------------------------------

const ORG_ID = 'org-001';

describe('validate_agents_for_dispatch', () => {

    beforeEach(() => {
        mock_find_one.mockReset();
        mock_find_all.mockReset();
    });

    it('returns ok when all agents are system agents', async () => {
        /** System agent lookup returns a match for both. */
        mock_find_one.mockResolvedValue({ name: 'exec', is_system: true });

        const manifest = JSON.stringify({
            phases: [{ name: 'run', agent: 'exec' }],
        });
        const result = await validate_agents_for_dispatch(ORG_ID, manifest);
        expect(result).toEqual({ ok: true });
    });

    it('returns ok when custom agent is registered', async () => {
        /** Not a system agent. */
        mock_find_one.mockResolvedValue(null);
        /** Custom agent found. */
        mock_find_all.mockResolvedValue([{ name: 'my-linter', version: null }]);

        const manifest = JSON.stringify({
            phases: [{ name: 'lint', agent: 'my-linter' }],
        });
        const result = await validate_agents_for_dispatch(ORG_ID, manifest);
        expect(result).toEqual({ ok: true });
    });

    it('returns missing when custom agent is not registered', async () => {
        mock_find_one.mockResolvedValue(null);
        mock_find_all.mockResolvedValue([]);

        const manifest = JSON.stringify({
            phases: [{ name: 'lint', agent: 'my-linter' }],
        });
        const result = await validate_agents_for_dispatch(ORG_ID, manifest);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.missing).toHaveLength(1);
            expect(result.missing[0]).toEqual({
                name: 'my-linter',
                required_version: null,
                reason: 'not_registered',
            });
        }
    });

    it('returns version_mismatch when pinned version not found', async () => {
        mock_find_one.mockResolvedValue(null);
        /** Custom agent registered but wrong version. */
        mock_find_all.mockResolvedValue([{ name: 'my-linter', version: '0.2.0' }]);

        const manifest = JSON.stringify({
            phases: [{ name: 'lint', agent: 'my-linter@0.3.0' }],
        });
        const result = await validate_agents_for_dispatch(ORG_ID, manifest);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.missing).toHaveLength(1);
            expect(result.missing[0].reason).toBe('version_mismatch');
            expect(result.missing[0].required_version).toBe('0.3.0');
        }
    });

    it('returns ok when pinned version matches', async () => {
        mock_find_one.mockResolvedValue(null);
        mock_find_all.mockResolvedValue([
            { name: 'my-linter', version: '0.2.0' },
            { name: 'my-linter', version: '0.3.0' },
        ]);

        const manifest = JSON.stringify({
            phases: [{ name: 'lint', agent: 'my-linter@0.3.0' }],
        });
        const result = await validate_agents_for_dispatch(ORG_ID, manifest);
        expect(result).toEqual({ ok: true });
    });

    it('returns ok for empty manifest (no agents)', async () => {
        const manifest = JSON.stringify({ phases: [] });
        const result = await validate_agents_for_dispatch(ORG_ID, manifest);
        expect(result).toEqual({ ok: true });
    });

    it('handles mix of system and missing custom agents', async () => {
        /** exec is system, my-linter is not. */
        mock_find_one.mockImplementation(async (_opts: { where: { name: string; is_system?: boolean } }) => {
            const where = _opts.where;
            if (where.name === 'exec' && where.is_system === true) {
                return { name: 'exec', is_system: true };
            }
            return null;
        });
        mock_find_all.mockResolvedValue([]);

        const manifest = JSON.stringify({
            phases: [
                { name: 'run', agent: 'exec' },
                { name: 'lint', agent: 'my-linter' },
            ],
        });
        const result = await validate_agents_for_dispatch(ORG_ID, manifest);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.missing).toHaveLength(1);
            expect(result.missing[0].name).toBe('my-linter');
        }
    });

    it('skips type:team phases', async () => {
        const manifest = JSON.stringify({
            phases: [
                { name: 'sub', type: 'team', team: '@acme/other' },
            ],
        });
        const result = await validate_agents_for_dispatch(ORG_ID, manifest);
        expect(result).toEqual({ ok: true });
    });
});
