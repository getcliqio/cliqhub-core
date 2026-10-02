import type { EnvConfig } from './config/env.js';
import { init_sequelize } from './db/sequelize.js';
import { migrate_hub_schema, move_registry_to_cliq_schema } from './models/migrations/hub_schema_migrations.js';
import { migrate_org_mesh_from_account } from './models/migrations/migrate_org_mesh.js';
import { migrate_org_roles } from './models/migrations/migrate_org_roles.js';
import { repair_namespace_orphans } from './models/migrations/migrate_namespace_orphans.js';
import { init_models } from './models/index.js';
import { get_logger } from './lib/log.js';
import { UserRepository } from './repositories/user_repository.js';
import { TokenRepository } from './repositories/token_repository.js';
import { ScopeRepository } from './repositories/scope_repository.js';
import { OrgMemberRepository } from './repositories/org_member_repository.js';
import { TeamRepository } from './repositories/team_repository.js';
import { TeamVersionRepository } from './repositories/team_version_repository.js';
import { TagRepository } from './repositories/tag_repository.js';
import { DownloadLogRepository } from './repositories/download_log_repository.js';
import { AuthService } from './services/auth_service.js';
import { TeamsService } from './services/teams_service.js';
import { DraftRepository } from './repositories/draft_repository.js';
import { DraftsService } from './services/drafts_service.js';
import { OrgsService } from './services/orgs_service.js';
import { InvitationsService } from './services/invitations_service.js';
import { OrgRepository } from './repositories/org_repository.js';
import { ScopeMemberRepository } from './repositories/scope_member_repository.js';
import { AuthController } from './controllers/auth_controller.js';
import { TeamsController } from './controllers/teams_controller.js';
import { DraftsController } from './controllers/drafts_controller.js';
import { OrgsController } from './controllers/orgs_controller.js';
import { InvitationsController } from './controllers/invitations_controller.js';
import { BuilderService } from './services/builder_service.js';
import { HostedLlmAdapter } from './services/llm/hosted_adapter.js';
import { create_package_storage } from './storage/package_storage.js';
import { AuditRepository } from './repositories/audit_repository.js';
import { SettingsRepository } from './repositories/settings_repository.js';
import { SettingsService } from './services/settings_service.js';
import { UsersService } from './services/users_service.js';
import { UsersController } from './controllers/users_controller.js';
import { ScopesService } from './services/scopes_service.js';
import { ReportsService } from './services/reports_service.js';
import { ReportsController } from './controllers/reports_controller.js';
import { TokensController } from './controllers/tokens_controller.js';
import { ReactivationService } from './services/reactivation.service.js';
import { PasswordLinkService } from './services/password_link.service.js';
import { OrgSeedService } from './services/org_seed.service.js';
import { create_email_sender } from './lib/email/index.js';
import type { EmailSender } from './lib/email/email_sender.js';
import { DELIVERER_BY_PROVIDER } from './notifications/deliverers/index.js';
import type { EmailDeliverer } from './notifications/deliverers/email_deliverer.js';

const boot_log = get_logger('boot');

export interface Container {
    config: EnvConfig;
    auth_controller: AuthController;
    teams_controller: TeamsController;
    drafts_controller: DraftsController;
    orgs_controller: OrgsController;
    invitations_controller: InvitationsController;
    tokens_controller: TokensController;
    users_controller: UsersController;
    reports_controller: ReportsController;
    /** Restores soft-deleted orgs and users (`reactivate: true`). */
    reactivation_service: ReactivationService;
    /** Outgoing email transport (Brevo, or the no-op sender without `BREVO_API_KEY`). */
    email_sender: EmailSender;
    org_repo: OrgRepository;
    scope_member_repo: ScopeMemberRepository;
    user_repo: UserRepository;
    token_repo: TokenRepository;
    scope_repo: ScopeRepository;
    org_member_repo: OrgMemberRepository;
    team_repo: TeamRepository;
    version_repo: TeamVersionRepository;
    tag_repo: TagRepository;
    download_log_repo: DownloadLogRepository;
    draft_repo: DraftRepository;
}

export async function create_container(config: EnvConfig): Promise<Container> {
    const sequelize = init_sequelize(config.database_url);
    init_models(sequelize);
    await move_registry_to_cliq_schema(sequelize);
    await sequelize.sync();
    await migrate_hub_schema(sequelize);

    const org_mesh = await migrate_org_mesh_from_account(sequelize);
    boot_log.info('org_mesh_migrate', org_mesh);

    const org_roles = await migrate_org_roles();
    boot_log.info('org_roles_migrate', org_roles);

    // Default notification channels and rules for orgs created before seeding existed.
    const org_seed = await OrgSeedService.backfill();
    boot_log.info('org_notifications_seed', org_seed);
    // Default rules added in later versions, for orgs seeded before.
    const org_seed_upgrade = await OrgSeedService.upgrade_defaults();
    boot_log.info('org_notifications_upgrade', org_seed_upgrade);

    // Orphaned scopes / scope-less orgs left by partial org creates and user deletes.
    const namespace = await repair_namespace_orphans(sequelize);
    boot_log.info('namespace_repair', { removed: namespace.user_scopes_removed.length + namespace.org_scopes_removed.length, created: namespace.org_scopes_created.length, skipped: namespace.skipped.length });

    const user_repo = new UserRepository();
    const token_repo = new TokenRepository();
    const scope_repo = new ScopeRepository();
    const org_member_repo = new OrgMemberRepository();
    const team_repo = new TeamRepository();
    const version_repo = new TeamVersionRepository();
    const tag_repo = new TagRepository();
    const download_log_repo = new DownloadLogRepository();
    const draft_repo = new DraftRepository();
    const org_repo = new OrgRepository();
    const scope_member_repo = new ScopeMemberRepository();

    const auth_service = new AuthService(
        user_repo, scope_repo, org_member_repo, config, org_repo, token_repo,
    );
    const auth_controller = new AuthController(auth_service);

    const storage = create_package_storage({
        packages_path: config.packages_path,
        storage_backend: config.storage_backend as 'local' | 'r2',
        s3_endpoint: config.s3_endpoint,
        s3_teams_bucket: config.s3_teams_bucket,
        s3_access_key_id: config.s3_access_key_id,
        s3_secret_access_key: config.s3_secret_access_key,
    });

    const audit_repo = new AuditRepository();
    const settings_repo = new SettingsRepository();

    const teams_service = new TeamsService(
        team_repo, version_repo, tag_repo,
        download_log_repo, storage, config.packages_path,
        scope_repo, audit_repo,
    );

    const llm_adapter = new HostedLlmAdapter();
    const builder_service = new BuilderService(llm_adapter);
    const teams_controller = new TeamsController(teams_service, builder_service);

    const drafts_service = new DraftsService(draft_repo);
    const drafts_controller = new DraftsController(drafts_service);

    const reactivation_service = new ReactivationService();

    const invitations_service = new InvitationsService(
        org_repo, scope_repo, user_repo, reactivation_service,
        (user_id) => auth_service.mint_session_pat(user_id),
    );
    const invitations_controller = new InvitationsController(invitations_service);

    const orgs_service = new OrgsService(
        org_repo, org_member_repo, scope_repo, scope_member_repo, user_repo, team_repo, audit_repo,
        invitations_service, reactivation_service,
    );
    const scopes_service = new ScopesService(
        scope_repo, team_repo, audit_repo, org_repo, org_member_repo, scope_member_repo,
    );
    const orgs_controller = new OrgsController(orgs_service, scopes_service);

    const settings_service = new SettingsService(settings_repo);

    const users_service = new UsersService(
        user_repo, scope_repo, token_repo, audit_repo, org_member_repo, config,
        reactivation_service, new PasswordLinkService(),
    );
    const users_controller = new UsersController(users_service);

    const tokens_controller = new TokensController(token_repo, org_member_repo);

    const email_sender = create_email_sender(config);
    (DELIVERER_BY_PROVIDER.email as EmailDeliverer).use_sender(email_sender);
    boot_log.info('email_sender', { provider: email_sender.name, configured: email_sender.configured });

    const reports_service = new ReportsService(audit_repo);
    const reports_controller = new ReportsController(reports_service);

    return {
        config, auth_controller, tokens_controller, teams_controller,
        drafts_controller, orgs_controller, invitations_controller,
        users_controller,
        reports_controller,
        reactivation_service,
        email_sender,
        user_repo, token_repo, scope_repo, org_member_repo, org_repo, scope_member_repo,
        team_repo, version_repo, tag_repo, download_log_repo, draft_repo,
    };
}
