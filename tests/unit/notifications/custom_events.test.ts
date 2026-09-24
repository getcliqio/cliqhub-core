/**
 * Phase 4 tests: custom event discovery.
 *
 * Tests cover:
 * - is_event_type accepts custom.* strings
 * - submit_schema validates custom.* event types
 * - custom.* handler creation
 * - CustomEventService: register_declared, register_observed, list, remove
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

// ── event type catalog ──────────────────────────────────────────────

import { is_event_type } from '../../../src/events/types.js';

describe('is_event_type — custom.* support', () => {

    it('accepts cataloged types', () => {
        expect(is_event_type('run.started')).toBe(true);
        expect(is_event_type('phase.escalated')).toBe(true);
        expect(is_event_type('notification.test')).toBe(true);
    });

    it('accepts any custom.* string', () => {
        expect(is_event_type('custom.enrichment_stale')).toBe(true);
        expect(is_event_type('custom.data_quality_alert')).toBe(true);
        expect(is_event_type('custom.x')).toBe(true);
    });

    it('rejects bare "custom." (no suffix)', () => {
        expect(is_event_type('custom.')).toBe(false);
    });

    it('rejects non-custom unknown types', () => {
        expect(is_event_type('bogus.thing')).toBe(false);
        expect(is_event_type('ops-channel')).toBe(false);
    });
});

// ── submit schema ───────────────────────────────────────────────────

import { event_submit_schema, required_fields_for } from '../../../src/events/submit_schema.js';

describe('event_submit_schema — custom.* events', () => {

    it('accepts a valid custom.* event with realm_id', () => {
        const result = event_submit_schema.safeParse({
            type: 'custom.enrichment_stale',
            realm_id: 'realm-1',
            message: 'Data is stale',
        });
        expect(result.success).toBe(true);
    });

    it('rejects custom.* event without realm_id', () => {
        const result = event_submit_schema.safeParse({
            type: 'custom.enrichment_stale',
        });
        expect(result.success).toBe(false);
    });

    it('still rejects completely unknown types', () => {
        const result = event_submit_schema.safeParse({
            type: 'bogus.thing',
        });
        expect(result.success).toBe(false);
    });
});

describe('required_fields_for — custom.* family', () => {

    it('requires realm_id for custom.* events', () => {
        const fields = required_fields_for('custom.my_event' as any);
        expect(fields).toContain('realm_id');
    });
});

// ── family handler creation ─────────────────────────────────────────

import { create_handler_for_type, CustomEventHandler } from '../../../src/notifications/handlers/family_handlers.js';
import { get_notification_handler } from '../../../src/notifications/handlers/catalog_handlers.js';

describe('custom.* notification handler', () => {

    it('create_handler_for_type returns CustomEventHandler for custom.*', () => {
        const handler = create_handler_for_type('custom.enrichment_stale');
        expect(handler).toBeInstanceOf(CustomEventHandler);
    });

    it('get_notification_handler resolves custom.* dynamically', () => {
        const handler = get_notification_handler('custom.enrichment_stale');
        expect(handler).toBeInstanceOf(CustomEventHandler);
    });

    it('get_notification_handler still works for cataloged types', () => {
        const handler = get_notification_handler('run.started');
        expect(handler).toBeDefined();
    });
});

// ── CustomEventService (mocked model) ───────────────────────────────

vi.mock('../../../src/models/index.js', async () => {
    const store: Array<Record<string, unknown>> = [];
    let next_id = 1;

    return {
        CustomEvent: {
            findOne: vi.fn(async (opts: { where: Record<string, unknown> }) => {
                return store.find((row) =>
                    Object.entries(opts.where).every(([k, v]) => row[k] === v),
                ) ?? null;
            }),
            findAll: vi.fn(async (opts?: { where?: Record<string, unknown>; order?: unknown }) => {
                let result = [...store];
                if (opts?.where) {
                    result = result.filter((row) =>
                        Object.entries(opts.where!).every(([k, v]) => {
                            if (v && typeof v === 'object' && Symbol.for('sequelize.op.in') in (v as object)) {
                                const arr = (v as Record<symbol, unknown>)[Symbol.for('sequelize.op.in')] as string[];
                                return arr.includes(row[k] as string);
                            }
                            return row[k] === v;
                        }),
                    );
                }
                result.sort((a, b) => String(a.event_type).localeCompare(String(b.event_type)));
                return result;
            }),
            create: vi.fn(async (data: Record<string, unknown>) => {
                const existing = store.find(
                    (r) => r.event_type === data.event_type && r.realm_id === data.realm_id && r.team_slug === data.team_slug,
                );
                if (existing) {
                    const err = new Error('unique violation') as Error & { name: string };
                    err.name = 'SequelizeUniqueConstraintError';
                    throw err;
                }
                const row = { ...data, id: next_id++ };
                store.push(row);
                return row;
            }),
            destroy: vi.fn(async (opts: { where: Record<string, unknown> }) => {
                const before = store.length;
                const remaining = store.filter((row) =>
                    !Object.entries(opts.where).every(([k, v]) => row[k] === v),
                );
                store.length = 0;
                store.push(...remaining);
                return before - remaining.length;
            }),
            _store: store,
            _reset: () => { store.length = 0; next_id = 1; },
        },
        NotificationChannel: {},
        NotificationRule: {},
        Realm: {},
    };
});

const { CustomEventService } = await import(
    '../../../src/services/custom_event.service.js'
);
const { CustomEvent } = await import(
    '../../../src/models/index.js'
) as { CustomEvent: { _store: Array<Record<string, unknown>>; _reset: () => void } };

describe('CustomEventService', () => {

    beforeEach(() => {
        CustomEvent._reset();
    });

    describe('register_declared', () => {

        it('inserts new declared events', async () => {
            await CustomEventService.register_declared({
                event_types: ['custom.alert', 'custom.done'],
                realm_id: 'realm-1',
                team_slug: 'enrichment',
            });
            expect(CustomEvent._store).toHaveLength(2);
            expect(CustomEvent._store[0].source).toBe('declared');
            expect(CustomEvent._store[0].event_type).toBe('custom.alert');
        });

        it('is idempotent (no duplicates on re-insert)', async () => {
            await CustomEventService.register_declared({
                event_types: ['custom.alert'],
                realm_id: 'realm-1',
                team_slug: 'enrichment',
            });
            await CustomEventService.register_declared({
                event_types: ['custom.alert'],
                realm_id: 'realm-1',
                team_slug: 'enrichment',
            });
            expect(CustomEvent._store).toHaveLength(1);
        });

        it('upgrades observed to declared on re-register', async () => {
            CustomEvent._store.push({
                id: hub_legacy_uuid(99),
                event_type: 'custom.alert',
                source: 'observed',
                realm_id: 'realm-1',
                team_slug: 'enrichment',
                label: null,
                created_at: 1000,
                update: vi.fn(async (data: Record<string, unknown>) => {
                    CustomEvent._store[0].source = data.source as string;
                }),
            });
            await CustomEventService.register_declared({
                event_types: ['custom.alert'],
                realm_id: 'realm-1',
                team_slug: 'enrichment',
            });
            expect(CustomEvent._store[0].source).toBe('declared');
        });

        it('ignores non-custom.* events', async () => {
            await CustomEventService.register_declared({
                event_types: ['run.started', 'custom.alert'],
                realm_id: 'realm-1',
                team_slug: 'enrichment',
            });
            expect(CustomEvent._store).toHaveLength(1);
            expect(CustomEvent._store[0].event_type).toBe('custom.alert');
        });
    });

    describe('register_observed', () => {

        it('inserts a new observed event', async () => {
            await CustomEventService.register_observed({
                event_type: 'custom.runtime_thing',
                realm_id: 'realm-1',
            });
            expect(CustomEvent._store).toHaveLength(1);
            expect(CustomEvent._store[0].source).toBe('observed');
        });

        it('no-op when event already exists', async () => {
            await CustomEventService.register_observed({
                event_type: 'custom.runtime_thing',
                realm_id: 'realm-1',
            });
            await CustomEventService.register_observed({
                event_type: 'custom.runtime_thing',
                realm_id: 'realm-1',
            });
            expect(CustomEvent._store).toHaveLength(1);
        });

        it('ignores non-custom.* types', async () => {
            await CustomEventService.register_observed({ event_type: 'run.started' });
            expect(CustomEvent._store).toHaveLength(0);
        });
    });

    describe('list', () => {

        it('returns all events sorted by type', async () => {
            await CustomEventService.register_declared({
                event_types: ['custom.z_last', 'custom.a_first'],
                realm_id: 'realm-1',
                team_slug: 'team-a',
            });
            const result = await CustomEventService.list();
            expect(result).toHaveLength(2);
            expect(result[0].event_type).toBe('custom.a_first');
            expect(result[1].event_type).toBe('custom.z_last');
        });

        it('returns empty when no events registered', async () => {
            const result = await CustomEventService.list();
            expect(result).toHaveLength(0);
        });
    });

    describe('remove_declared_for_team', () => {

        it('removes declared entries for a specific team', async () => {
            await CustomEventService.register_declared({
                event_types: ['custom.alert'],
                realm_id: 'realm-1',
                team_slug: 'team-a',
            });
            await CustomEventService.register_observed({
                event_type: 'custom.alert',
                realm_id: 'realm-1',
                team_slug: 'team-b',
            });
            await CustomEventService.remove_declared_for_team({
                realm_id: 'realm-1',
                team_slug: 'team-a',
            });
            expect(CustomEvent._store).toHaveLength(1);
            expect(CustomEvent._store[0].team_slug).toBe('team-b');
        });
    });
});
