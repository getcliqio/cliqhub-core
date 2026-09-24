import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();
import { AuditLog } from '../../../src/db/models/index.js';
import { AuditRepository } from '../../../src/repositories/audit_repository.js';

describe('AuditRepository', () => {
    let repo: AuditRepository;
    beforeEach(() => { vi.clearAllMocks(); repo = new AuditRepository(); });

    it('create inserts audit log entry', async () => {
        await repo.create(hub_legacy_uuid(1), 'user.suspend', 'user', 5, { reason: 'test' });
        expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ admin_id: hub_legacy_uuid(1), action: 'user.suspend' }));
    });

    it('list_paginated returns entries ordered by created_at desc', async () => {
        const rows = [{ id: hub_legacy_uuid(1), admin_id: hub_legacy_uuid(1), action: 'user.suspend', User: { username: 'admin' }, target_type: 'user', target_id: '5', details: '{}', created_at: '2025-01-01' }];
        vi.mocked(AuditLog.findAll).mockResolvedValueOnce(rows as any);
        const result = await repo.list_paginated({}, 50, 0);
        expect(result).toHaveLength(1);
    });

    it('count_filtered returns total count', async () => {
        vi.mocked(AuditLog.count).mockResolvedValueOnce(42);
        const result = await repo.count_filtered({});
        expect(result).toBe(42);
    });

    it('count_filtered applies action and admin_id filters', async () => {
        vi.mocked(AuditLog.count).mockResolvedValueOnce(5);
        const result = await repo.count_filtered({ action: 'user.suspend', admin_id: hub_legacy_uuid(1) });
        expect(result).toBe(5);
    });
});
