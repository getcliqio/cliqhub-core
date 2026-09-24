/**
 * Tests for v2 notification rules:
 * - build_matching_selectors (wildcard expansion)
 * - resolve_rules (three-tier lookup with replace semantics)
 * - list_rules, list_effective_rules
 * - set_rule, remove_rule
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the service methods by mocking the model layer.
vi.mock('../../../src/models/index.js', () => {
    const mock_rule_rows: Array<Record<string, unknown>> = [];

    return {
        NotificationChannel: {},
        NotificationRule: {
            findAll: vi.fn(async (opts: { where: Record<string, unknown> }) => {
                return mock_rule_rows.filter((r) => {
                    for (const [key, val] of Object.entries(opts.where)) {
                        if (val && typeof val === 'object' && Symbol.for('sequelize.op.is') in (val as object)) {
                            if (r[key] !== null) return false;
                            continue;
                        }
                        if (val && typeof val === 'object' && Symbol.for('sequelize.op.in') in (val as object)) {
                            const arr = (val as Record<symbol, unknown>)[Symbol.for('sequelize.op.in')] as string[];
                            if (!arr.includes(r[key] as string)) return false;
                            continue;
                        }
                        if (r[key] !== val) return false;
                    }
                    return true;
                });
            }),
            findOne: vi.fn(async () => null),
            create: vi.fn(async (data: Record<string, unknown>) => ({
                ...data,
                id: Math.floor(Math.random() * 10000),
            })),
            destroy: vi.fn(async () => 1),
            _rows: mock_rule_rows,
        },
        Realm: { findByPk: vi.fn(async () => ({ id: 'realm-1' })) },
    };
});

// We need to also mock Sequelize Op symbols
vi.mock('sequelize', async () => {
    const actual = await vi.importActual('sequelize');
    return {
        ...(actual as object),
        Op: {
            ...(actual as { Op: Record<string, symbol> }).Op,
            is: Symbol.for('sequelize.op.is'),
            in: Symbol.for('sequelize.op.in'),
        },
    };
});

// Import after mocks
const { NotificationService } = await import(
    '../../../src/services/notification.service.js'
);
const { NotificationRule } = await import(
    '../../../src/models/index.js'
);

type MockRows = Array<Record<string, unknown>>;

function seed_rules(rows: Array<{
    realm_id?: string | null;
    team_slug?: string | null;
    event: string;
    channel_id: string;
}>): void {
    const store = (NotificationRule as unknown as { _rows: MockRows })._rows;
    store.length = 0;
    for (const r of rows) {
        store.push({
            id: Math.floor(Math.random() * 10000),
            realm_id: r.realm_id ?? null,
            team_slug: r.team_slug ?? null,
            event: r.event,
            channel_id: r.channel_id,
            priority: 0,
            created_at: Date.now(),
            updated_at: Date.now(),
        });
    }
}


describe('resolve_rules — three-tier lookup', () => {

    beforeEach(() => {
        seed_rules([]);
    });

    it('returns empty when no rules exist', async () => {
        const result = await NotificationService.resolve_rules({
            event: 'run.failed',
            realm_id: 'realm-1',
        });
        expect(result).toEqual([]);
    });

    it('resolves global rules when no realm/team rules exist', async () => {
        seed_rules([
            { event: 'run.*', channel_id: 'ch-global' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'run.failed',
        });
        expect(result).toEqual(['ch-global']);
    });

    it('realm rules replace global rules for same event', async () => {
        seed_rules([
            { event: 'run.*', channel_id: 'ch-global' },
            { realm_id: 'realm-1', event: 'run.*', channel_id: 'ch-realm' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'run.failed',
            realm_id: 'realm-1',
        });
        expect(result).toEqual(['ch-realm']);
    });

    it('team-in-realm rules replace realm rules', async () => {
        seed_rules([
            { realm_id: 'realm-1', event: 'run.*', channel_id: 'ch-realm' },
            { realm_id: 'realm-1', team_slug: 'enrichment', event: 'run.*', channel_id: 'ch-team' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'run.failed',
            realm_id: 'realm-1',
            team_slug: 'enrichment',
        });
        expect(result).toEqual(['ch-team']);
    });

    it('falls back to realm when team has no matching rule', async () => {
        seed_rules([
            { realm_id: 'realm-1', event: 'run.*', channel_id: 'ch-realm' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'run.failed',
            realm_id: 'realm-1',
            team_slug: 'enrichment',
        });
        expect(result).toEqual(['ch-realm']);
    });

    it('falls back to global when realm has no matching rule', async () => {
        seed_rules([
            { event: 'run.*', channel_id: 'ch-global' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'run.failed',
            realm_id: 'realm-1',
        });
        expect(result).toEqual(['ch-global']);
    });

    it('matches exact event type', async () => {
        seed_rules([
            { event: 'phase.escalated', channel_id: 'ch-exact' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'phase.escalated',
        });
        expect(result).toEqual(['ch-exact']);
    });

    it('matches wildcard selector for event family', async () => {
        seed_rules([
            { event: 'phase.*', channel_id: 'ch-wildcard' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'phase.escalated',
        });
        expect(result).toEqual(['ch-wildcard']);
    });

    it('matches global wildcard *', async () => {
        seed_rules([
            { event: '*', channel_id: 'ch-all' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'custom.anything',
        });
        expect(result).toEqual(['ch-all']);
    });

    it('deduplicates channel IDs from multiple matching rules', async () => {
        seed_rules([
            { event: 'run.*', channel_id: 'ch-a' },
            { event: 'run.failed', channel_id: 'ch-a' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'run.failed',
        });
        expect(result).toEqual(['ch-a']);
    });

    it('returns multiple channels from different rules at same tier', async () => {
        seed_rules([
            { event: 'run.*', channel_id: 'ch-slack' },
            { event: 'run.*', channel_id: 'ch-email' },
        ]);
        const result = await NotificationService.resolve_rules({
            event: 'run.failed',
        });
        expect(result).toContain('ch-slack');
        expect(result).toContain('ch-email');
        expect(result).toHaveLength(2);
    });
});
