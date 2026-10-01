import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../../../src/errors/api_error.js';

const require_permission = vi.fn();
vi.mock('../../../src/auth/permissions.js', () => ({ require_permission: (...a: unknown[]) => require_permission(...a) }));
vi.mock('../../../src/models/index.js', () => ({ Realm: {}, AgentCatalog: {}, RealmAgentSetting: {}, OrgAgentSetting: {}, UserRealmAgentSetting: {}, OrgMember: {}, Org: {}, User: {}, OrgRole: {} }));

const { default_permission_check } = await import('../../../src/controllers/agents_controller.js');

describe('default_permission_check', () => {
    it('true when require_permission passes, false on 403, rethrows anything else', async () => {
        require_permission.mockResolvedValueOnce(undefined);
        await expect(default_permission_check('o', 'u', 'agents.view')).resolves.toBe(true);
        expect(require_permission).toHaveBeenCalledWith('o', 'u', 'agents.view');
        require_permission.mockRejectedValueOnce(new ApiError('forbidden', "Permission 'agents.view' is required", 403));
        await expect(default_permission_check('o', 'u', 'agents.view')).resolves.toBe(false);
        require_permission.mockRejectedValueOnce(new Error('db down'));
        await expect(default_permission_check('o', 'u', 'agents.view')).rejects.toThrow('db down');
    });
});
