/**
 * Unit coverage for control-plane store lifecycle (mocked store package).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const close = vi.fn().mockResolvedValue(undefined);
const sequelize = { sync: vi.fn() };
const connection = { sequelize, close };

const connect_store = vi.fn(async () => connection);
const migrate_store = vi.fn(async () => undefined);
const seed_control_plane = vi.fn(async () => ({
    scopes_inserted: 0,
    settings_inserted: 0,
}));

vi.mock('../../../src/store/connect.js', () => ({
    connect_store: (...args: unknown[]) => connect_store(...args),
}));

vi.mock('../../../src/store/migrate.js', () => ({
    migrate_store: (...args: unknown[]) => migrate_store(...args),
}));

vi.mock('../../../src/models/migrations/control_plane_seed.js', () => ({
    seed_control_plane: (...args: unknown[]) => seed_control_plane(...args),
}));

const seed_model_pricing = vi.fn(async () => 0);
vi.mock('../../../src/services/model_pricing_seed.js', () => ({
    seed_model_pricing: (...args: unknown[]) => seed_model_pricing(...args),
}));

vi.mock('../../../src/models/index.js', () => ({
    init_core_api_models: vi.fn(),
    reset_core_api_models: vi.fn(),
}));

const move_registry_to_cliq_schema = vi.fn(async () => undefined);

vi.mock('../../../src/models/migrations/hub_schema_migrations.js', () => ({
    move_registry_to_cliq_schema: (...args: unknown[]) => move_registry_to_cliq_schema(...args),
}));

vi.mock('../../../src/models/migrations/control_plane_schema_migrations.js', () => ({
    run_core_api_schema_migrations: vi.fn(async () => undefined),
}));

describe('control_plane_store', () => {
    beforeEach(() => {
        vi.resetModules();
        connect_store.mockClear();
        migrate_store.mockClear();
        move_registry_to_cliq_schema.mockClear();
        seed_control_plane.mockClear();
        close.mockClear();
        connect_store.mockImplementation(async () => connection);
        seed_control_plane.mockResolvedValue({
            scopes_inserted: 0,
            settings_inserted: 0,
        });
    });

    afterEach(async () => {
        const { close_control_plane_store } = await import(
            '../../../src/db/control_plane_store.js'
        );
        await close_control_plane_store();
    });

    it('init_control_plane_store connects via package and migrates', async () => {
        const { init_control_plane_store, get_control_plane_store } = await import(
            '../../../src/db/control_plane_store.js'
        );

        const conn = await init_control_plane_store(
            'postgres://cliqhub:cliqhub@localhost:5432/cliqhub',
        );

        expect(connect_store).toHaveBeenCalledWith({
            dialect: 'postgres',
            db_url: 'postgres://cliqhub:cliqhub@localhost:5432/cliqhub',
            ssl: false,
        });
        expect(migrate_store).toHaveBeenCalledWith(sequelize);
        expect(move_registry_to_cliq_schema).toHaveBeenCalledWith(sequelize);
        expect(move_registry_to_cliq_schema.mock.invocationCallOrder[0])
            .toBeLessThan(migrate_store.mock.invocationCallOrder[0]);
        expect(seed_control_plane).toHaveBeenCalledOnce();
        // The model price list is upserted at boot, after the schema migrations.
        expect(seed_model_pricing).toHaveBeenCalled();
        expect(get_control_plane_store()).toBe(conn);
    });

    it('passes ssl:true for non-local database URLs', async () => {
        const { init_control_plane_store } = await import(
            '../../../src/db/control_plane_store.js'
        );

        await init_control_plane_store(
            'postgres://u:p@db.example.com:5432/cliqhub',
        );

        expect(connect_store).toHaveBeenCalledWith({
            dialect: 'postgres',
            db_url: 'postgres://u:p@db.example.com:5432/cliqhub',
            ssl: true,
        });
    });

    it('init_control_plane_store is idempotent within a process', async () => {
        const { init_control_plane_store } = await import(
            '../../../src/db/control_plane_store.js'
        );

        const first = await init_control_plane_store(
            'postgres://cliqhub:cliqhub@localhost:5432/cliqhub',
        );
        const second = await init_control_plane_store(
            'postgres://cliqhub:cliqhub@localhost:5432/cliqhub',
        );

        expect(second).toBe(first);
        expect(connect_store).toHaveBeenCalledOnce();
        expect(migrate_store).toHaveBeenCalledOnce();
    });

    it('get_control_plane_store throws before init', async () => {
        const { get_control_plane_store } = await import(
            '../../../src/db/control_plane_store.js'
        );
        expect(() => get_control_plane_store()).toThrow(/not initialized/);
    });

    it('close_control_plane_store clears the singleton', async () => {
        const mod = await import('../../../src/db/control_plane_store.js');
        await mod.init_control_plane_store(
            'postgres://cliqhub:cliqhub@localhost:5432/cliqhub',
        );
        await mod.close_control_plane_store();
        expect(close).toHaveBeenCalledOnce();
        expect(() => mod.get_control_plane_store()).toThrow(/not initialized/);
    });
});
