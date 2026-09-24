import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/models/index.js', () => ({
    Realm: {
        findByPk: vi.fn(),
        findOne: vi.fn(),
    },
}));

vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: {
        require_admin: vi.fn(async () => undefined),
    },
}));

vi.mock('../../../src/services/org_mesh.service.js', () => ({
    OrgMeshService: {
        get_raw: vi.fn(async () => ({
            active_provider_id: 'svantic',
            providers: {
                svantic: {
                    api_url: 'https://api.svantic.com',
                    client_id: 'from-org',
                    client_secret: 'org-secret',
                },
            },
            auto_enable_a2a_on_realm_create: false,
        })),
    },
}));

vi.mock('../../../src/mesh/registry.js', () => {
    const connect = vi.fn(async () => ({ status: 'disconnected', message: 'stub' }));
    const disconnect = vi.fn(async () => ({ status: 'disconnected' }));
    const re_register = vi.fn(async () => ({ status: 'disconnected' }));
    const health = vi.fn(async () => ({ status: 'disconnected' }));
    const adapter = {
        id: 'svantic',
        label: 'Svantic',
        settings_schema: [
            { key: 'client_secret', type: 'secret' },
            { key: 'api_url', type: 'url' },
            { key: 'dispatch_secret', type: 'secret' },
        ],
        connect,
        disconnect,
        re_register,
        health,
    };
    return {
        list_mesh_adapters: vi.fn(() => [{ id: 'svantic', label: 'Svantic', settings_schema: adapter.settings_schema }]),
        get_mesh_adapter: vi.fn((id: string) => {
            if (id !== 'svantic') throw Object.assign(new Error('bad'), { status_code: 400 });
            return adapter;
        }),
        try_get_mesh_adapter: vi.fn((id: string) => (id === 'svantic' ? adapter : null)),
    };
});

vi.mock('../../../src/lib/api_error.js', () => ({
    ApiError: {
        unauthorized: (msg: string) => Object.assign(new Error(msg), { status_code: 401 }),
        forbidden: (msg: string) => Object.assign(new Error(msg), { status_code: 403 }),
        bad_request: (msg: string) => Object.assign(new Error(msg), { status_code: 400 }),
        not_found: (msg: string) => Object.assign(new Error(msg), { status_code: 404 }),
    },
}));

import { RealmA2aService } from '../../../src/services/realm_a2a.service.js';
import { Realm } from '../../../src/models/index.js';
import { RealmService } from '../../../src/services/realm.service.js';
import { OrgMeshService } from '../../../src/services/org_mesh.service.js';
import { get_mesh_adapter } from '../../../src/mesh/registry.js';

function make_realm(overrides: Record<string, unknown> = {}) {
    const realm = {
        id: 'realm-1',
        slug: 'acme',
        owner_user_id: '42',
        org_id: hub_legacy_uuid(7),
        deleted: false,
        a2a_enabled: false,
        a2a_bearer_token_hash: null as string | null,
        a2a_bearer_token_prefix: null as string | null,
        mesh_provider_mode: 'inherit' as const,
        mesh_active_provider_id: null as string | null,
        mesh_providers: {} as Record<string, Record<string, unknown>>,
        mesh_status: null as Record<string, unknown> | null,
        created_at: 1000,
        updated_at: 1000,
        save: vi.fn(async () => realm),
        ...overrides,
    };
    return realm;
}

describe('RealmA2aService (org mesh)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(RealmService.require_admin).mockResolvedValue(undefined);
        process.env.CLIQHUB_PUBLIC_API_URL = 'https://api.cliqhub.io';
    });

    it('get_for_admin returns realm A2A fields and org effective provider', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue(make_realm() as any);
        const dto = await RealmA2aService.get_for_admin('realm-1', '42');
        expect(dto.a2a_enabled).toBe(false);
        expect(dto.org_id).toBe(hub_legacy_uuid(7));
        expect(dto.effective_provider_id).toBe('svantic');
        expect(dto.card_url).toContain('/a2a/r/acme/.well-known/agent-card.json');
    });

    it('update_for_admin persists api_url on realm mesh_providers', async () => {
        const realm = make_realm();
        vi.mocked(Realm.findByPk).mockResolvedValue(realm as any);

        await RealmA2aService.update_for_admin('realm-1', '42', {
            a2a_enabled: true,
            mesh_provider_mode: 'override',
            active_provider_id: 'svantic',
            provider_id: 'svantic',
            provider_settings: {
                api_url: 'https://mesh.svantic.dev',
                client_id: 'cid',
                client_secret: 'sec',
                mode: 'connected',
            },
        });

        expect(realm.a2a_enabled).toBe(true);
        expect(realm.mesh_active_provider_id).toBe('svantic');
        expect(realm.mesh_providers.svantic).toEqual({
            api_url: 'https://mesh.svantic.dev',
            client_id: 'cid',
            client_secret: 'sec',
            mode: 'connected',
        });
    });

    it('rotate_bearer stores hash on realm', async () => {
        const realm = make_realm();
        vi.mocked(Realm.findByPk).mockResolvedValue(realm as any);
        const result = await RealmA2aService.rotate_bearer('realm-1', '42');
        expect(result.bearer).toMatch(/^cliq_a2a_/);
        expect(realm.a2a_bearer_token_hash).toHaveLength(64);
    });

    it('inherit connect merges org api_url into settings', async () => {
        const realm = make_realm({
            mesh_provider_mode: 'inherit',
            mesh_providers: { svantic: { mode: 'hosted' } },
        });
        vi.mocked(Realm.findByPk).mockResolvedValue(realm as any);

        await RealmA2aService.connect_mesh('realm-1', '42');

        expect(OrgMeshService.get_raw).toHaveBeenCalledWith(hub_legacy_uuid(7));
        expect(get_mesh_adapter('svantic').connect).toHaveBeenCalledWith(
            expect.objectContaining({
                settings: expect.objectContaining({
                    api_url: 'https://api.svantic.com',
                    client_id: 'from-org',
                    client_secret: 'org-secret',
                    mode: 'hosted',
                }),
            }),
        );
    });
});
