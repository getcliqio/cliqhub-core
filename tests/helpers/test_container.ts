import express from 'express';
import { vi } from 'vitest';
import { AuthController } from '../../src/controllers/auth_controller.js';
import { TeamsController } from '../../src/controllers/teams_controller.js';
import { AuthService } from '../../src/services/auth_service.js';
import { TeamsService } from '../../src/services/teams_service.js';
import { TokensController } from '../../src/controllers/tokens_controller.js';
import { ScopesService } from '../../src/services/scopes_service.js';
import { ScopesController } from '../../src/controllers/scopes_controller.js';
import { register_control_plane_routes } from '../../src/routes/index.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { deny_daemon_token_outside_allowlist } from '../../src/middleware/daemon_token_gate.js';
import { require_internal, require_internal_network } from '../../src/middleware/internal_only.js';
import type { EnvConfig } from '../../src/config/env.js';

export function test_config(): EnvConfig {
    return {
        port: 4000,
        database_url: 'postgres://test:test@localhost/test',
        jwt_secret: 'test-secret',
        jwt_expires_in: '12h',
        packages_path: '/tmp/test-packages',
        storage_backend: 'local',
        s3_endpoint: '', s3_bucket: '', s3_access_key_id: '', s3_secret_access_key: '',
        allowed_origins: [],
        node_env: 'test',
        rate_limit_public_rpm: 100, rate_limit_auth_rpm: 200, rate_limit_window_ms: 60000,
    };
}

export function make_mock_repos() {
    return {
        user_repo: {
            find_by_id: vi.fn().mockResolvedValue(null),
            find_by_username: vi.fn().mockResolvedValue(null),
            find_by_username_or_email: vi.fn().mockResolvedValue(null),
            find_by_email: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(1),
            find_by_id_with_transaction: vi.fn().mockResolvedValue(null),
            find_password_hash: vi.fn().mockResolvedValue(null),
            update_profile: vi.fn(),
            update_password: vi.fn(),
        },
        token_repo: {
            find_by_prefix: vi.fn().mockResolvedValue(null),
            update_last_used: vi.fn().mockResolvedValue(undefined),
            create: vi.fn().mockResolvedValue({ id: 'tok-1' }),
            soft_revoke: vi.fn().mockResolvedValue(1),
            soft_revoke_by_id: vi.fn().mockResolvedValue(1),
            delete_by_id_and_user: vi.fn().mockResolvedValue(0),
            list_by_user_id: vi.fn().mockResolvedValue([]),
        },
        scope_repo: {
            find_owned_by_user: vi.fn().mockResolvedValue([]),
            find_by_org_ids: vi.fn().mockResolvedValue([]),
            find_member_scopes: vi.fn().mockResolvedValue([]),
            find_by_slug: vi.fn().mockResolvedValue(null),
            find_by_slug_with_transaction: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(1),
            delete_by_id: vi.fn(),
        },
        org_member_repo: {
            find_orgs_by_user: vi.fn().mockResolvedValue([]),
        },
        org_repo: {
            find_by_slug: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(1),
        },
        team_repo: {
            find_by_id: vi.fn().mockResolvedValue(null),
            find_by_name_and_scope: vi.fn().mockResolvedValue(null),
            list_filtered: vi.fn().mockResolvedValue([]),
            count_filtered: vi.fn().mockResolvedValue(0),
            find_author_username: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(1),
            update: vi.fn(), update_name: vi.fn(), update_listed: vi.fn(),
            update_description: vi.fn(),
            update_visibility_and_listed: vi.fn(),
            update_install_count: vi.fn(), delete_by_id: vi.fn(),
            list_by_scope: vi.fn().mockResolvedValue([]),
            list_by_scope_list: vi.fn().mockResolvedValue([]),
        },
        version_repo: {
            find_by_team_and_version: vi.fn().mockResolvedValue(null),
            find_latest_version: vi.fn().mockResolvedValue(null),
            find_detail_by_team_and_version: vi.fn().mockResolvedValue(null),
            list_by_team_id: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue(1),
            delete_by_id: vi.fn(), find_id_and_package: vi.fn(),
            list_packages_by_team: vi.fn().mockResolvedValue([]),
            list_all_by_team: vi.fn().mockResolvedValue([]),
            find_latest_package: vi.fn(), find_package_by_version: vi.fn(),
            update_package_path: vi.fn(),
        },
        tag_repo: {
            find_by_team_ids: vi.fn().mockResolvedValue([]),
            find_by_team_id: vi.fn().mockResolvedValue([]),
            delete_by_team_id: vi.fn(), create: vi.fn(),
        },
        download_log_repo: {
            find_by_team_key_date: vi.fn().mockResolvedValue(null),
            create: vi.fn(),
        },
        draft_repo: {
            list_by_user_id: vi.fn().mockResolvedValue([]),
            find_by_id_and_user: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(1),
            update: vi.fn(),
            delete_by_id: vi.fn(),
            count_by_user_id: vi.fn().mockResolvedValue(0),
            count_total: vi.fn().mockResolvedValue(0),
        },
        audit_repo: {
            create: vi.fn().mockResolvedValue(undefined),
            list: vi.fn().mockResolvedValue([]),
            count: vi.fn().mockResolvedValue(0),
        },
    };
}

export function create_test_app() {
    const app = express();
    app.use(express.json());

    const config = test_config();
    const repos = make_mock_repos();

    app.use(create_auth_middleware({
        user_repo: repos.user_repo as any,
        token_repo: repos.token_repo as any,
        scope_repo: repos.scope_repo as any,
        org_member_repo: repos.org_member_repo as any,
    }));
    app.use(deny_daemon_token_outside_allowlist);

    const auth_service = new AuthService(
        repos.user_repo as any,
        repos.scope_repo as any,
        repos.org_member_repo as any,
        config,
        repos.org_repo as any,
        repos.token_repo as any,
    );
    const auth_controller = new AuthController(auth_service);

    app.post('/internal/auth/signup', require_internal_network, auth_controller.signup);
    app.post('/internal/auth/authenticate_user', require_internal_network, auth_controller.authenticate_user);
    app.post('/internal/auth/issue_session_token', require_internal, auth_controller.issue_session_token);
    app.post('/internal/auth/revoke_session_token', require_internal_network, auth_controller.revoke_session_token);

    const teams_service = new TeamsService(
        repos.team_repo as any, repos.version_repo as any,
        repos.tag_repo as any,
    );
    const teams_controller = new TeamsController(teams_service);

    app.post('/v1/teams/get', teams_controller.get);
    app.post('/v1/teams/get_by_id', teams_controller.get_by_id);
    app.post('/v1/teams/get_versions', teams_controller.get_versions);
    app.post('/v1/teams/create', teams_controller.create);
    app.post('/v1/teams/update', teams_controller.update);
    app.post('/v1/teams/publish', teams_controller.publish);
    app.post('/v1/teams/unpublish', teams_controller.unpublish);
    app.post('/v1/teams/download', teams_controller.download);
    app.post('/v1/teams/delete', teams_controller.delete_team);
    app.post('/v1/teams/delete_version', teams_controller.delete_version);
    app.post('/v1/teams/rename', teams_controller.rename);

    const tokens_controller = new TokensController(
        repos.token_repo as any,
        repos.org_member_repo as any,
    );
    app.post('/v1/auth/generate_token', tokens_controller.generate_token);
    app.post('/v1/auth/get_tokens', tokens_controller.get_tokens);
    app.post('/v1/auth/validate_token', tokens_controller.validate_token);
    app.post('/v1/auth/revoke_token', tokens_controller.revoke_token);
    app.post('/v1/auth/rotate_token', tokens_controller.rotate_token);

    const scopes_service = new ScopesService(
        repos.scope_repo as any,
        repos.team_repo as any,
        repos.audit_repo as any,
        repos.org_repo as any,
        repos.org_member_repo as any,
        {
            create: vi.fn(),
            create_on_conflict_ignore: vi.fn(),
            find_by_scope_and_user: vi.fn().mockResolvedValue(null),
            delete_by_scope_and_user: vi.fn().mockResolvedValue(0),
            delete_by_scope_id: vi.fn(),
        } as any,
    );
    const scopes_controller = new ScopesController(scopes_service);
    app.post('/v1/scopes/get', scopes_controller.get);
    app.post('/v1/scopes/new', scopes_controller.new_scope);
    app.post('/v1/scopes/update', scopes_controller.update);
    app.post('/v1/scopes/delete', scopes_controller.delete_scope);

    register_control_plane_routes(app);

    app.use(error_handler);

    return { app, config, repos };
}
