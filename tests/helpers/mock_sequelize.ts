import { vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

export function setup_sequelize_mocks() {
    vi.mock('../../src/services/realm.service.js', () => ({
        RealmService: {
            upsert_user_member: vi.fn().mockResolvedValue(undefined),
            remove_member_silent: vi.fn().mockResolvedValue(undefined),
            upsert_daemon_member: vi.fn().mockResolvedValue(undefined),
            bind_daemon_to_realm: vi.fn().mockResolvedValue([]),
            assert_member: vi.fn().mockResolvedValue(undefined),
            resolve_token: vi.fn(),
            list_for_user: vi.fn().mockResolvedValue({ realms: [], total: 0 }),
            create: vi.fn(),
            create_token: vi.fn(),
            ensure_personal_realm: vi.fn().mockResolvedValue({
                realm: {
                    id: 'realm-personal',
                    slug: 'r-alice',
                    name: 'Default',
                    owner_user_id: '1',
                    created_by: '1',
                    created_at: 0,
                    updated_at: 0,
                },
                default_realm_id: 'realm-personal',
                default_realm_slug: 'r-alice',
                enroll_token: null,
            }),
            ensure_account_default_realm: vi.fn().mockResolvedValue({
                realm: {
                    id: 'realm-account',
                    slug: 'alice.default',
                    name: 'alice',
                    owner_user_id: '1',
                    created_by: '1',
                    created_at: 0,
                    updated_at: 0,
                },
                default_realm_id: 'realm-account',
                default_realm_slug: 'alice.default',
                enroll_token: null,
            }),
            ensure_org_default_realm: vi.fn().mockResolvedValue({
                id: 'realm-org',
                slug: 'acme.default',
                name: 'acme',
                owner_user_id: '1',
                created_by: '1',
                created_at: 0,
                updated_at: 0,
            }),
        },
    }));

    vi.mock('../../src/services/realm_dispatch_key.service.js', () => ({
        RealmDispatchKeyService: {
            get_or_create_public_key: vi.fn().mockResolvedValue({
                realm_id: 'realm-default',
                public_key_pem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
                created_at: 0,
                rotated_at: 0,
            }),
            regenerate: vi.fn(),
            resolve_realm_id: vi.fn(),
            backfill: vi.fn().mockResolvedValue([]),
        },
    }));

    vi.mock('../../src/services/per_user_channel.service.js', () => ({
        ensure_per_user_channel: vi.fn().mockResolvedValue(undefined),
    }));

    vi.mock('../../src/lib/log.js', () => ({
        get_logger: vi.fn().mockReturnValue({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    }));

    vi.mock('../../src/db/control_plane_store.js', () => ({
        connect_control_plane: vi.fn(),
        close_control_plane: vi.fn(),
    }));

    vi.mock('../../src/models/index.js', () => {
        const make_model = () => ({
            findOne: vi.fn().mockResolvedValue(null),
            findAll: vi.fn().mockResolvedValue([]),
            findByPk: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'mock-id' }),
            update: vi.fn().mockResolvedValue([1]),
            destroy: vi.fn().mockResolvedValue(1),
            count: vi.fn().mockResolvedValue(0),
        });
        return {
            Realm: make_model(),
            RealmMember: make_model(),
            RealmDispatchKey: make_model(),
            Daemon: make_model(),
            DaemonConfig: make_model(),
            Scope: make_model(),
            Agent: make_model(),
            Container: make_model(),
            Workspace: make_model(),
            WorkspaceTeam: make_model(),
            Run: make_model(),
            RunEvent: make_model(),
            RunLog: make_model(),
            RunLogChunk: make_model(),
            RunPhase: make_model(),
            RunArtifact: make_model(),
            Setting: make_model(),
            Team: make_model(),
            NotificationChannel: make_model(),
            InAppNotification: make_model(),
            Secret: make_model(),
            DispatchMailbox: make_model(),
            HubEvent: make_model(),
            Event: make_model(),
            EventType: make_model(),
            init_control_plane_models: vi.fn(),
            init_core_api_models: vi.fn(),
            reset_core_api_models: vi.fn(),
        };
    });

    vi.mock('../../src/db/sequelize.js', () => ({
        init_sequelize: vi.fn().mockReturnValue({
            transaction: vi.fn().mockImplementation(async (fn?: any) => {
                if (typeof fn === 'function') return fn({});
                return { commit: vi.fn(), rollback: vi.fn() };
            }),
            query: vi.fn().mockResolvedValue([[], {}]),
            close: vi.fn(),
        }),
        get_sequelize: vi.fn().mockReturnValue({
            transaction: vi.fn().mockImplementation(async (fn?: any) => {
                if (typeof fn === 'function') return fn({});
                return { commit: vi.fn(), rollback: vi.fn() };
            }),
            query: vi.fn().mockResolvedValue([[], {}]),
            close: vi.fn(),
        }),
        close_sequelize: vi.fn(),
    }));

    vi.mock('../../src/db/models/index.js', () => {
        const make_model = () => ({
            findOne: vi.fn().mockResolvedValue(null),
            findAll: vi.fn().mockResolvedValue([]),
            findByPk: vi.fn().mockResolvedValue(null),
            findAndCountAll: vi.fn().mockResolvedValue({ count: 0, rows: [] }),
            create: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1) }),
            update: vi.fn().mockResolvedValue([1]),
            destroy: vi.fn().mockResolvedValue(1),
            increment: vi.fn().mockResolvedValue([{}, 1]),
            count: vi.fn().mockResolvedValue(0),
            sum: vi.fn().mockResolvedValue(0),
            findOrCreate: vi.fn().mockResolvedValue([{}, true]),
            init: vi.fn(),
            removeAttribute: vi.fn(),
            hasMany: vi.fn(), belongsTo: vi.fn(),
            sequelize: {
                transaction: vi.fn().mockImplementation(async (fn?: any) => {
                    if (typeof fn === 'function') return fn({});
                    return { commit: vi.fn(), rollback: vi.fn() };
                }),
                escape: vi.fn().mockImplementation((v: unknown) => `'${String(v)}'`),
            },
        });

        return {
            User: make_model(),
            Org: make_model(),
            OrgMember: make_model(),
            OrgRole: make_model(),
            OrgAgentSetting: make_model(),
            ApiToken: make_model(),
            Scope: make_model(),
            ScopeMember: make_model(),
            Team: make_model(),
            TeamVersion: make_model(),
            TeamTag: make_model(),
            Draft: make_model(),
            AuditLog: make_model(),
            DownloadLog: make_model(),
            Setting: make_model(),
            init_models: vi.fn(),
        };
    });
}
