/**
 * Unit coverage for control-plane seed (mocked store models).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const scope_find_by_pk = vi.fn();
const scope_find_one = vi.fn();
const scope_create = vi.fn();
const config_find_one = vi.fn();
const config_create = vi.fn();

vi.mock('@getcliqio/cliq-store', () => ({
    Scope: {
        findByPk: (...args: unknown[]) => scope_find_by_pk(...args),
        findOne: (...args: unknown[]) => scope_find_one(...args),
        create: (...args: unknown[]) => scope_create(...args),
    },
    DaemonConfig: {
        findOne: (...args: unknown[]) => config_find_one(...args),
        create: (...args: unknown[]) => config_create(...args),
    },
}));

describe('seed_control_plane', () => {
    beforeEach(() => {
        vi.resetModules();
        scope_find_by_pk.mockReset();
        scope_find_one.mockReset();
        scope_create.mockReset();
        config_find_one.mockReset();
        config_create.mockReset();
    });

    it('inserts missing scopes and global settings', async () => {
        scope_find_by_pk.mockResolvedValue(null);
        scope_find_one.mockResolvedValue(null);
        scope_create.mockResolvedValue({});
        config_find_one.mockResolvedValue(null);
        config_create.mockResolvedValue({});

        const { seed_control_plane } = await import(
            '../../../src/db/control_plane_seed.js'
        );
        const result = await seed_control_plane();

        expect(result.scopes_inserted).toBe(2);
        expect(result.settings_inserted).toBe(7);
        expect(scope_create).toHaveBeenCalledTimes(2);
        expect(config_create).toHaveBeenCalledTimes(7);
        expect(config_create).toHaveBeenCalledWith(
            expect.objectContaining({
                daemon_id: '__global__',
                key: 'logging.level',
                value: JSON.stringify('info'),
            }),
        );
    });

    it('skips rows that already exist', async () => {
        scope_find_by_pk.mockResolvedValue({ id: 'x' });
        config_find_one.mockResolvedValue({ key: 'x' });

        const { seed_control_plane } = await import(
            '../../../src/db/control_plane_seed.js'
        );
        const result = await seed_control_plane();

        expect(result.scopes_inserted).toBe(0);
        expect(result.settings_inserted).toBe(0);
        expect(scope_create).not.toHaveBeenCalled();
        expect(config_create).not.toHaveBeenCalled();
    });
});
