import { describe, it, expect, vi } from 'vitest';

vi.mock('sequelize', () => {
    class Sequelize {
        close = vi.fn();
        authenticate = vi.fn();
        constructor(_url?: string, _opts?: unknown) {}
    }
    return {
        Sequelize,
        DataTypes: { INTEGER: 'INTEGER', TEXT: 'TEXT', DATE: 'DATE', NOW: 'NOW' },
        Model: class {},
        Op: {},
    };
});

describe('sequelize module', () => {
    it('init_sequelize creates a Sequelize instance', async () => {
        const { init_sequelize } = await import('../../../src/db/sequelize.js');
        const seq = init_sequelize('postgres://test:test@localhost/test');
        expect(seq).toBeDefined();
    });

    it('get_sequelize returns initialized instance', async () => {
        const { init_sequelize, get_sequelize } = await import('../../../src/db/sequelize.js');
        init_sequelize('postgres://test:test@localhost/test');
        const seq = get_sequelize();
        expect(seq).toBeDefined();
    });

    it('close_sequelize closes the connection', async () => {
        const { init_sequelize, close_sequelize } = await import('../../../src/db/sequelize.js');
        const seq = init_sequelize('postgres://test:test@localhost/test');
        await close_sequelize();
        expect(seq.close).toHaveBeenCalled();
    });
});
