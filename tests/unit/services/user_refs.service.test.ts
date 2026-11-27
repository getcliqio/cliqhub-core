/** user_refs.service — people for list rows, in one read. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ User: { findAll: vi.fn() } }));
vi.mock('../../../src/models/index.js', () => ({ User: m.User }));

import { UserRefs } from '../../../src/services/user_refs.service.js';

beforeEach(() => vi.clearAllMocks());

describe('UserRefs', () => {
    it('reads each id once and keys the users by id', async () => {
        m.User.findAll.mockResolvedValue([{ id: 'u1', username: 'sapan', display_name: 'Sapan Shah' }]);
        const refs = await UserRefs.by_ids(['u1', 'u1', null, '', undefined, 'gone']);
        expect(m.User.findAll).toHaveBeenCalledTimes(1);
        expect((m.User.findAll.mock.calls[0][0] as { where: { id: Record<symbol, string[]> } }).where.id).toEqual(expect.objectContaining({}));
        expect(UserRefs.pick(refs, 'u1')).toEqual({ id: 'u1', username: 'sapan', display_name: 'Sapan Shah' });
        expect(UserRefs.pick(refs, 'gone')).toBeNull();
        expect(UserRefs.pick(refs, null)).toBeNull();
    });

    it('no ids → no read', async () => {
        const refs = await UserRefs.by_ids([null, '', undefined]);
        expect(refs.size).toBe(0);
        expect(m.User.findAll).not.toHaveBeenCalled();
    });
});
