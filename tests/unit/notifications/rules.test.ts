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


describe('resolve_rules — the org\'s rules and the realm\'s both apply (PLAN-notifications-v2 B1)', () => {
    const ORG = 'org-1';
    const resolve = (event: string, realm_id?: string) => NotificationService.resolve_rules({ event, ...(realm_id ? { realm_id } : {}), org_id: ORG });

    beforeEach(() => {
        seed_rules([]);
    });

    it('returns empty when no rules exist', async () => {
        expect(await resolve('run.failed', 'realm-1')).toEqual([]);
    });

    it('the org\'s rules apply in every realm', async () => {
        seed_rules([{ org_id: ORG, event: 'run.*', channel_id: 'ch-org' }]);
        expect(await resolve('run.failed', 'realm-1')).toEqual(['ch-org']);
        expect(await resolve('run.failed')).toEqual(['ch-org']);
    });

    it('a realm\'s rule is sent as well as the org\'s — never instead', async () => {
        seed_rules([
            { org_id: ORG, event: 'run.*', channel_id: 'ch-org' },
            { realm_id: 'realm-1', event: 'run.*', channel_id: 'ch-realm' },
        ]);
        expect((await resolve('run.failed', 'realm-1')).sort()).toEqual(['ch-org', 'ch-realm']);
        // Another realm has only the org's.
        expect(await resolve('run.failed', 'realm-2')).toEqual(['ch-org']);
    });

    it('another org\'s rules never apply', async () => {
        seed_rules([{ org_id: 'org-2', event: 'run.*', channel_id: 'ch-other-org' }]);
        expect(await resolve('run.failed', 'realm-1')).toEqual([]);
    });

    it('matches exact, family wildcard and *', async () => {
        seed_rules([
            { org_id: ORG, event: 'phase.escalated', channel_id: 'ch-exact' },
            { org_id: ORG, event: 'phase.*', channel_id: 'ch-wildcard' },
            { org_id: ORG, event: '*', channel_id: 'ch-all' },
        ]);
        expect((await resolve('phase.escalated')).sort()).toEqual(['ch-all', 'ch-exact', 'ch-wildcard']);
        expect(await resolve('custom.anything')).toEqual(['ch-all']);
    });

    it('a channel matched by several rules (or both tiers) is sent once', async () => {
        seed_rules([
            { org_id: ORG, event: 'run.*', channel_id: 'ch-a' },
            { org_id: ORG, event: 'run.failed', channel_id: 'ch-a' },
            { realm_id: 'realm-1', event: 'run.failed', channel_id: 'ch-a' },
        ]);
        expect(await resolve('run.failed', 'realm-1')).toEqual(['ch-a']);
    });
});


describe('rules on / off — a rule sends only when it (and its channel) is on', () => {
    const ORG = 'org-1';
    beforeEach(() => seed_rules([]));

    it('a realm switching its own rule off stops only that rule — the org\'s still sends', async () => {
        seed_rules([
            { org_id: ORG, event: 'run.failed', channel_id: 'ch-org' },
            { realm_id: 'realm-1', event: 'run.failed', channel_id: 'ch-realm', enabled: false },
        ]);
        expect(await NotificationService.resolve_rules({ event: 'run.failed', realm_id: 'realm-1', org_id: ORG })).toEqual(['ch-org']);
    });

    it('an org rule that is paused sends nothing; its other rules still do', async () => {
        seed_rules([
            { org_id: ORG, event: 'run.failed', channel_id: 'ch-paused', enabled: false },
            { org_id: ORG, event: 'run.*', channel_id: 'ch-on' },
        ]);
        expect(await NotificationService.resolve_rules({ event: 'run.failed', realm_id: 'realm-1', org_id: ORG })).toEqual(['ch-on']);
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

    it('lists every org rule and every realm rule — nothing is hidden as "replaced"', async () => {
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
            ['run.failed', 'global', true],
        ]);
    });
});
