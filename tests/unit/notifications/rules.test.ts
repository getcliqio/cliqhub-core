/**
 * Tests for v2 notification rules:
 * - build_matching_selectors (wildcard expansion)
 * - resolve_rules (realm rules replace org rules for that realm)
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
        Org: {},
        NotificationChannel: {},
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
    org_id?: string | null;
    team_slug?: string | null;
    event: string;
    channel_id: string;
    enabled?: boolean;
}>): void {
    const store = (NotificationRule as unknown as { _rows: MockRows })._rows;
    store.length = 0;
    for (const r of rows) {
        store.push({
            id: Math.floor(Math.random() * 10000),
            realm_id: r.realm_id ?? null,
            org_id: r.org_id ?? null,
            team_slug: r.team_slug ?? null,
            enabled: r.enabled ?? true,
            event: r.event,
            channel_id: r.channel_id,
            priority: 0,
            created_at: Date.now(),
            updated_at: Date.now(),
        });
    }
}


describe('resolve_rules — realm, else org', () => {

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

    it('resolves global rules when no realm rules exist', async () => {
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


describe('rules on / off — a rule sends only when it (and its channel) is on', () => {
    beforeEach(() => seed_rules([]));

    it('a realm whose rules for the event are all off sends nothing — the org\'s rule doesn\'t come back', async () => {
        seed_rules([
            { event: 'run.failed', channel_id: 'ch-org' },
            { realm_id: 'realm-1', event: 'run.failed', channel_id: 'ch-org', enabled: false },
        ]);
        expect(await NotificationService.resolve_rules({ event: 'run.failed', realm_id: 'realm-1' })).toEqual([]);
        // Other realms still get the org's rule.
        expect(await NotificationService.resolve_rules({ event: 'run.failed', realm_id: 'realm-2' })).toEqual(['ch-org']);
    });

    it('a replaced event sends only to the realm rules that are on', async () => {
        seed_rules([
            { event: 'run.failed', channel_id: 'ch-org' },
            { realm_id: 'realm-1', event: 'run.failed', channel_id: 'ch-org', enabled: false },
            { realm_id: 'realm-1', event: 'run.failed', channel_id: 'ch-realm' },
        ]);
        expect(await NotificationService.resolve_rules({ event: 'run.failed', realm_id: 'realm-1' })).toEqual(['ch-realm']);
    });

    it('an org rule that is paused sends nothing; its other rules still do', async () => {
        seed_rules([
            { event: 'run.failed', channel_id: 'ch-paused', enabled: false },
            { event: 'run.*', channel_id: 'ch-on' },
        ]);
        expect(await NotificationService.resolve_rules({ event: 'run.failed', realm_id: 'realm-1' })).toEqual(['ch-on']);
    });

    it('org-event rules skip paused ones', async () => {
        seed_rules([
            { org_id: 'org-1', event: 'invite.sent', channel_id: 'ch-paused', enabled: false },
            { org_id: 'org-1', event: 'invite.*', channel_id: 'ch-on' },
        ]);
        const rules = await NotificationService.resolve_org_rules({ event: 'invite.sent', org_id: 'org-1' });
        expect(rules.map((r: { channel_id: string }) => r.channel_id)).toEqual(['ch-on']);
    });
});

describe('list_effective_rules — what applies in a realm matches delivery', () => {
    beforeEach(() => seed_rules([]));

    it('a realm wildcard replaces the org\'s exact rule; a realm exact rule leaves the org\'s wildcard (other events still use it)', async () => {
        seed_rules([
            { org_id: 'org-1', event: 'run.failed', channel_id: 'ch-org-failed' },
            { org_id: 'org-1', event: 'phase.*', channel_id: 'ch-org-phase' },
            { realm_id: 'realm-1', event: 'run.*', channel_id: 'ch-realm-run' },
            { realm_id: 'realm-1', event: 'phase.failed', channel_id: 'ch-realm-phase', enabled: false },
        ]);
        const rows = await NotificationService.list_effective_rules('realm-1', 'org-1');
        expect(rows.map((r: { event: string; tier: string; enabled: boolean }) => [r.event, r.tier, r.enabled])).toEqual([
            ['phase.*', 'global', true],
            ['phase.failed', 'realm', false],
            ['run.*', 'realm', true],
        ]);
    });
});
