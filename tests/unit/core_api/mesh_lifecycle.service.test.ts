import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/models/index.js', () => ({
    Realm: { findByPk: vi.fn() },
}));

vi.mock('../../../src/services/org_mesh.service.js', () => ({
    OrgMeshService: {
        get_raw: vi.fn(),
    },
}));

vi.mock('../../../src/services/realm_a2a.service.js', () => ({
    RealmA2aService: {
        connect_mesh: vi.fn(async () => ({ a2a_enabled: true })),
        refresh_mesh: vi.fn(async () => ({ a2a_enabled: true })),
        disconnect_mesh: vi.fn(async () => ({ a2a_enabled: false })),
    },
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { MeshLifecycleService } from '../../../src/services/mesh_lifecycle.service.js';
import { Realm } from '../../../src/models/index.js';
import { OrgMeshService } from '../../../src/services/org_mesh.service.js';
import { RealmA2aService } from '../../../src/services/realm_a2a.service.js';

describe('MeshLifecycleService (org mesh)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('skips auto-enable when org flag is off', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue({
            id: 'r1',
            org_id: hub_legacy_uuid(7),
            deleted: false,
            owner_user_id: '42',
        } as any);
        vi.mocked(OrgMeshService.get_raw).mockResolvedValue({
            active_provider_id: 'svantic',
            providers: {},
            auto_enable_a2a_on_realm_create: false,
        });

        const result = await MeshLifecycleService.on_realm_created('r1', '42');
        expect(result).toBe('skipped');
        expect(RealmA2aService.connect_mesh).not.toHaveBeenCalled();
    });

    it('enables and connects when org auto-enable is on', async () => {
        const realm = {
            id: 'r1',
            org_id: hub_legacy_uuid(7),
            deleted: false,
            owner_user_id: '42',
            a2a_enabled: false,
            mesh_providers: {},
            save: vi.fn(async () => undefined),
        };
        vi.mocked(Realm.findByPk).mockResolvedValue(realm as any);
        vi.mocked(OrgMeshService.get_raw).mockResolvedValue({
            active_provider_id: 'svantic',
            providers: { svantic: { api_url: 'https://api.svantic.com' } },
            auto_enable_a2a_on_realm_create: true,
        });

        const result = await MeshLifecycleService.on_realm_created('r1', '42');
        expect(result).toBe('connected');
        expect(realm.a2a_enabled).toBe(true);
        expect(RealmA2aService.connect_mesh).toHaveBeenCalledWith('r1', '42');
    });

    it('re_registers when mesh connected', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue({
            id: 'r1',
            deleted: false,
            owner_user_id: '42',
            a2a_enabled: true,
            mesh_provider_mode: 'inherit',
            mesh_status: { status: 'connected' },
        } as any);

        const result = await MeshLifecycleService.on_skills_changed('r1');
        expect(result).toBe('refreshed');
        expect(RealmA2aService.refresh_mesh).toHaveBeenCalledWith('r1', '42');
    });
});
