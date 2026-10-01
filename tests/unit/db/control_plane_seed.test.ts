/**
 * Unit coverage for control-plane seed (mocked store models).
 *
 * Platform scopes are now seeded via SQL migration (not by seed_control_plane).
 * This file only covers the daemon_config global settings seeding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const config_find_one = vi.fn();
const config_create = vi.fn();

vi.mock('../../../src/models/index.js', () => ({
    DaemonConfig: {
        findOne: (...args: unknown[]) => config_find_one(...args),
        create: (...args: unknown[]) => config_create(...args),
    },
}));

describe('seed_control_plane', () => {
    beforeEach(() => {
        vi.resetModules();
        config_find_one.mockReset();
        config_create.mockReset();
    });

    it('inserts missing global settings and returns scopes_inserted=0', async () => {
        config_find_one.mockResolvedValue(null);
        config_create.mockResolvedValue({});

        const { seed_control_plane } = await import(
            '../../../src/models/migrations/control_plane_seed.js'
        );
        const result = await seed_control_plane();

        expect(result.scopes_inserted).toBe(0);
        expect(result.settings_inserted).toBe(7);
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
        config_find_one.mockResolvedValue({ key: 'x' });

        const { seed_control_plane } = await import(
            '../../../src/models/migrations/control_plane_seed.js'
        );
        const result = await seed_control_plane();

        expect(result.scopes_inserted).toBe(0);
        expect(result.settings_inserted).toBe(0);
        expect(config_create).not.toHaveBeenCalled();
    });
});
