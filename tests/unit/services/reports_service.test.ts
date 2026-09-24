import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { ReportsService } from '../../../src/services/reports_service.js';
import { SITE_ADMIN, ALICE, UNAUTHED } from '../../helpers/fixtures.js';

function make_audit_repo() {
    return {
        list_paginated: vi.fn().mockResolvedValue([]),
        count_filtered: vi.fn().mockResolvedValue(0),
    };
}

describe('ReportsService', () => {
    let service: ReportsService;
    let audit_repo: ReturnType<typeof make_audit_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        audit_repo = make_audit_repo();
        service = new ReportsService(audit_repo as any);
    });

    describe('audit', () => {
        it('returns paginated audit entries for admin', async () => {
            const fake_entries = [
                { id: hub_legacy_uuid(1), action: 'user.create', admin_id: hub_legacy_uuid(99) },
                { id: hub_legacy_uuid(2), action: 'user.suspend', admin_id: hub_legacy_uuid(99) },
            ];
            audit_repo.list_paginated.mockResolvedValueOnce(fake_entries);
            audit_repo.count_filtered.mockResolvedValueOnce(2);

            const result = await service.audit(SITE_ADMIN, {});

            expect(result.entries).toEqual(fake_entries);
            expect(result.total).toBe(2);
            expect(result.limit).toBe(50);
            expect(result.offset).toBe(0);
        });

        it('passes filters to repository', async () => {
            audit_repo.list_paginated.mockResolvedValueOnce([]);
            audit_repo.count_filtered.mockResolvedValueOnce(0);

            await service.audit(SITE_ADMIN, {
                action: 'user.suspend',
                target_type: 'user',
                admin_id: hub_legacy_uuid(99),
            });

            const expected_filters = { action: 'user.suspend', target_type: 'user', admin_id: hub_legacy_uuid(99) };
            expect(audit_repo.list_paginated).toHaveBeenCalledWith(expected_filters, 50, 0);
            expect(audit_repo.count_filtered).toHaveBeenCalledWith(expected_filters);
        });

        it('respects custom limit and offset', async () => {
            audit_repo.list_paginated.mockResolvedValueOnce([]);
            audit_repo.count_filtered.mockResolvedValueOnce(0);

            const result = await service.audit(SITE_ADMIN, { limit: 25, offset: 10 });

            expect(audit_repo.list_paginated).toHaveBeenCalledWith(
                { action: undefined, target_type: undefined, admin_id: undefined },
                25,
                10,
            );
            expect(result.limit).toBe(25);
            expect(result.offset).toBe(10);
        });

        it('caps limit at 100', async () => {
            audit_repo.list_paginated.mockResolvedValueOnce([]);
            audit_repo.count_filtered.mockResolvedValueOnce(0);

            const result = await service.audit(SITE_ADMIN, { limit: 500 });

            expect(audit_repo.list_paginated).toHaveBeenCalledWith(
                expect.anything(),
                100,
                0,
            );
            expect(result.limit).toBe(100);
        });

        it('defaults limit to 50 when not provided', async () => {
            audit_repo.list_paginated.mockResolvedValueOnce([]);
            audit_repo.count_filtered.mockResolvedValueOnce(0);

            const result = await service.audit(SITE_ADMIN, {});

            expect(result.limit).toBe(50);
        });

        it('rejects non-admin with 403', async () => {
            await expect(service.audit(ALICE, {}))
                .rejects.toThrow('Admin access required');
        });

        it('rejects unauthenticated with 401', async () => {
            await expect(service.audit(UNAUTHED, {}))
                .rejects.toThrow('Authentication required');
        });
    });
});
