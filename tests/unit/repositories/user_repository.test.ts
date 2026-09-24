import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { User, Scope } from '../../../src/db/models/index.js';
import { UserRepository } from '../../../src/repositories/user_repository.js';

describe('UserRepository', () => {
    let repo: UserRepository;

    beforeEach(() => {
        vi.clearAllMocks();
        repo = new UserRepository();
    });

    it('find_by_id returns user when found', async () => {
        const row = {
            id: hub_legacy_uuid(1), username: 'alice', display_name: 'Alice',
            email: 'alice@example.com', role: 'user',
            suspended_at: null, suspended_reason: null,
            created_at: '2026-01-01T00:00:00.000Z',
        };
        vi.mocked(User.findByPk).mockResolvedValueOnce(row as any);
        const result = await repo.find_by_id(hub_legacy_uuid(1));
        expect(result).toEqual({
            id: hub_legacy_uuid(1), username: 'alice', display_name: 'Alice',
            email: 'alice@example.com', role: 'user',
            suspended_at: null, suspended_reason: null,
            preferences: {},
            created_at: '2026-01-01T00:00:00.000Z',
        });
    });

    it('find_by_id returns null when not found', async () => {
        vi.mocked(User.findByPk).mockResolvedValueOnce(null);
        const result = await repo.find_by_id(hub_legacy_uuid(999));
        expect(result).toBeNull();
    });

    it('find_by_username returns login row', async () => {
        const row = { id: hub_legacy_uuid(1), username: 'alice', password_hash: 'hash', suspended_at: null };
        vi.mocked(User.findOne).mockResolvedValueOnce(row as any);
        const result = await repo.find_by_username('alice');
        expect(result).toEqual(row);
    });

    it('find_by_username returns null for missing user', async () => {
        vi.mocked(User.findOne).mockResolvedValueOnce(null);
        const result = await repo.find_by_username('ghost');
        expect(result).toBeNull();
    });

    it('find_by_username_or_email finds by username', async () => {
        vi.mocked(User.findOne).mockResolvedValueOnce({ id: hub_legacy_uuid(1) } as any);
        const result = await repo.find_by_username_or_email('alice', 'other@test.com');
        expect(result).toEqual({ id: hub_legacy_uuid(1) });
    });

    it('find_by_email finds by email', async () => {
        vi.mocked(User.findOne).mockResolvedValueOnce({ id: hub_legacy_uuid(2) } as any);
        const result = await repo.find_by_email('alice@test.com');
        expect(result).toEqual({ id: hub_legacy_uuid(2) });
    });

    it('create inserts and returns id', async () => {
        vi.mocked(User.create).mockResolvedValueOnce({ id: hub_legacy_uuid(5) } as any);
        const result = await repo.create('alice', 'alice@test.com', 'hash', 'alice');
        expect(result).toBe(hub_legacy_uuid(5));
        expect(User.create).toHaveBeenCalledWith(
            expect.objectContaining({ username: 'alice', email: 'alice@test.com' }),
            expect.anything(),
        );
    });

    it('find_by_email with exclude_id uses Op.ne', async () => {
        vi.mocked(User.findOne).mockResolvedValueOnce(null);
        const result = await repo.find_by_email('alice@test.com', hub_legacy_uuid(1));
        expect(result).toBeNull();
        expect(User.findOne).toHaveBeenCalled();
    });
});
