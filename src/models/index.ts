import type { Sequelize } from 'sequelize';

// Registry models (hub identity + product)
import { User } from './user.model.js';
import { Org } from './org.model.js';
import { OrgMember } from './org_member.model.js';
import { OrgRole } from './org_role.model.js';
import { AccountAgentSetting } from './account_agent_setting.model.js';
import { AccountInvite } from './account_invite.model.js';
import { RealmInvite } from './realm_invite.model.js';
import { ApiToken } from './api_token.model.js';
import { Scope } from './scope.model.js';
import { ScopeMember } from './scope_member.model.js';
import { Team } from './team.model.js';
import { TeamVersion } from './team_version.model.js';
import { TeamTag } from './team_tag.model.js';
import { Draft } from './draft.model.js';
import { AuditLog } from './audit_log.model.js';
import { DownloadLog } from './download_log.model.js';
import { Setting } from './setting.model.js';
import { OrgAgentSetting } from './org_agent_setting.model.js';
import { UserRealmAgentSetting } from './user_realm_agent_setting.model.js';

// Store models (control-plane: daemons, runs, realms)
import { Agent } from './agent.model.js';
import { AgentCatalog } from './agent_catalog.model.js';
import { AccountMeshSetting } from './account_mesh_setting.model.js';
import { Container } from './container.model.js';
import { CustomEvent } from './custom_event.model.js';
import { Daemon } from './daemon.model.js';
import { DaemonConfig } from './daemon_config.model.js';
import { DaemonTeam } from './daemon_team.model.js';
import { HubEvent } from './hub_event.model.js';
import { ChannelDestination } from './channel_destination.model.js';
import { InAppNotification } from './in_app_notification.model.js';
import { NotificationChannel } from './notification_channel.model.js';
import { NotificationRule } from './notification_rule.model.js';
import { NotificationSubscription } from './notification_subscription.model.js';
import { RealmA2aSetting } from './realm_a2a_setting.model.js';
import { RealmAgentSetting } from './realm_agent_setting.model.js';
import { RealmDispatchKey } from './realm_dispatch_key.model.js';
import { RealmDispatchQueue } from './realm_dispatch_queue.model.js';
import { Realm } from './realm.model.js';
import { RealmMember } from './realm_member.model.js';
import { Review } from './review.model.js';
import { ReviewMessage } from './review_message.model.js';
import { ReviewNotification } from './review_notification.model.js';
import { Run } from './run.model.js';
import { RunArtifact } from './run_artifact.model.js';
import { RunEvent } from './run_event.model.js';
import { RunLog } from './run_log.model.js';
import { RunLogLine } from './run_log_line.model.js';
import { RunPhase } from './run_phase.model.js';
import { RunSpan } from './run_span.model.js';
import { StoredArtifact } from './stored_artifact.model.js';
import { WebhookDelivery } from './webhook_delivery.model.js';
import { Workspace } from './workspace.model.js';
import { WorkspaceSecret } from './workspace_secret.model.js';
import { WorkspaceTeam } from './workspace_team.model.js';

export {
    // Registry
    User, Org, OrgMember, OrgRole,
    AccountAgentSetting, AccountInvite, RealmInvite, ApiToken,
    Scope, ScopeMember, Team, TeamVersion, TeamTag,
    Draft, AuditLog, DownloadLog, Setting,
    OrgAgentSetting, UserRealmAgentSetting,
    // Store
    Agent, AgentCatalog, AccountMeshSetting,
    Container, CustomEvent, Daemon, DaemonConfig, DaemonTeam,
    HubEvent, ChannelDestination, InAppNotification,
    NotificationChannel, NotificationRule, NotificationSubscription,
    RealmA2aSetting, RealmAgentSetting, RealmDispatchKey, RealmDispatchQueue,
    Realm, RealmMember,
    Review, ReviewMessage, ReviewNotification,
    Run, RunArtifact, RunEvent, RunLog, RunLogLine, RunPhase, RunSpan,
    StoredArtifact, WebhookDelivery,
    Workspace, WorkspaceSecret, WorkspaceTeam,
};

/**
 * Register all 54 models on a single Sequelize instance and set up
 * associations. Called once at application boot.
 */
export function init_models(sequelize: Sequelize): void {
    // Registry
    User.register(sequelize);
    Org.register(sequelize);
    OrgMember.register(sequelize);
    OrgRole.register(sequelize);
    AccountAgentSetting.register(sequelize);
    AccountInvite.register(sequelize);
    RealmInvite.register(sequelize);
    ApiToken.register(sequelize);
    Scope.register(sequelize);
    ScopeMember.register(sequelize);
    Team.register(sequelize);
    TeamVersion.register(sequelize);
    TeamTag.register(sequelize);
    Draft.register(sequelize);
    AuditLog.register(sequelize);
    DownloadLog.register(sequelize);
    Setting.register(sequelize);
    OrgAgentSetting.register(sequelize);
    UserRealmAgentSetting.register(sequelize);

    // Store
    Daemon.register(sequelize);
    Workspace.register(sequelize);
    DaemonTeam.register(sequelize);
    WorkspaceTeam.register(sequelize);
    WorkspaceSecret.register(sequelize);
    Agent.register(sequelize);
    Run.register(sequelize);
    RunEvent.register(sequelize);
    RunLog.register(sequelize);
    RunPhase.register(sequelize);
    RunArtifact.register(sequelize);
    Container.register(sequelize);
    DaemonConfig.register(sequelize);
    RealmDispatchKey.register(sequelize);
    NotificationChannel.register(sequelize);
    ChannelDestination.register(sequelize);
    InAppNotification.register(sequelize);
    RunLogLine.register(sequelize);
    RunSpan.register(sequelize);
    Realm.register(sequelize);
    RealmMember.register(sequelize);
    RealmDispatchQueue.register(sequelize);
    HubEvent.register(sequelize);
    Review.register(sequelize);
    ReviewMessage.register(sequelize);
    ReviewNotification.register(sequelize);
    RealmAgentSetting.register(sequelize);
    AgentCatalog.register(sequelize);
    NotificationRule.register(sequelize);
    NotificationSubscription.register(sequelize);
    CustomEvent.register(sequelize);
    RealmA2aSetting.register(sequelize);
    AccountMeshSetting.register(sequelize);
    StoredArtifact.register(sequelize);
    WebhookDelivery.register(sequelize);

    // Registry associations
    User.hasMany(ApiToken, { foreignKey: 'user_id', as: 'tokens' });
    ApiToken.belongsTo(User, { foreignKey: 'user_id' });

    User.hasMany(Scope, { foreignKey: 'owner_id', as: 'owned_scopes' });
    Scope.belongsTo(User, { foreignKey: 'owner_id' });

    Org.hasMany(Scope, { foreignKey: 'org_id' });
    Scope.belongsTo(Org, { foreignKey: 'org_id' });

    Org.hasMany(OrgMember, { foreignKey: 'org_id', as: 'members' });
    OrgMember.belongsTo(Org, { foreignKey: 'org_id' });
    User.hasMany(OrgMember, { foreignKey: 'user_id' });
    OrgMember.belongsTo(User, { foreignKey: 'user_id' });

    Org.hasMany(OrgRole, { foreignKey: 'org_id', as: 'roles' });
    OrgRole.belongsTo(Org, { foreignKey: 'org_id' });
    OrgMember.belongsTo(OrgRole, { foreignKey: 'role_id', as: 'org_role' });
    OrgRole.hasMany(OrgMember, { foreignKey: 'role_id' });

    Org.hasMany(AccountInvite, { foreignKey: 'org_id', as: 'invites' });
    AccountInvite.belongsTo(Org, { foreignKey: 'org_id' });
    User.hasMany(AccountInvite, { foreignKey: 'invited_by', as: 'sent_invites' });
    AccountInvite.belongsTo(User, { foreignKey: 'invited_by', as: 'inviter' });

    Scope.hasMany(ScopeMember, { foreignKey: 'scope_id' });
    ScopeMember.belongsTo(Scope, { foreignKey: 'scope_id' });
    User.hasMany(ScopeMember, { foreignKey: 'user_id' });
    ScopeMember.belongsTo(User, { foreignKey: 'user_id' });

    User.hasMany(Team, { foreignKey: 'author_id' });
    Team.belongsTo(User, { foreignKey: 'author_id', as: 'author' });

    Team.hasMany(TeamVersion, { foreignKey: 'team_id', as: 'versions', onDelete: 'CASCADE' });
    TeamVersion.belongsTo(Team, { foreignKey: 'team_id' });

    Team.hasMany(TeamTag, { foreignKey: 'team_id', as: 'tags', onDelete: 'CASCADE' });
    TeamTag.belongsTo(Team, { foreignKey: 'team_id' });

    User.hasMany(Draft, { foreignKey: 'user_id', onDelete: 'CASCADE' });
    Draft.belongsTo(User, { foreignKey: 'user_id' });

    User.hasMany(AuditLog, { foreignKey: 'admin_id' });
    AuditLog.belongsTo(User, { foreignKey: 'admin_id' });

    Team.hasMany(DownloadLog, { foreignKey: 'team_id', onDelete: 'CASCADE' });
    DownloadLog.belongsTo(Team, { foreignKey: 'team_id' });

    // Store associations
    Daemon.hasMany(Workspace, { foreignKey: 'daemon_id', as: 'workspaces' });
    Workspace.belongsTo(Daemon, { foreignKey: 'daemon_id', as: 'daemon' });

    Daemon.hasMany(DaemonTeam, { foreignKey: 'daemon_id', as: 'daemon_teams' });
    DaemonTeam.belongsTo(Daemon, { foreignKey: 'daemon_id', as: 'daemon' });

    Daemon.hasMany(Agent, { foreignKey: 'daemon_id', as: 'agents' });
    Agent.belongsTo(Daemon, { foreignKey: 'daemon_id', as: 'daemon' });

    Daemon.hasMany(Run, { foreignKey: 'daemon_id', sourceKey: 'id', as: 'runs' });
    Run.belongsTo(Daemon, { foreignKey: 'daemon_id', targetKey: 'id', as: 'daemon' });

    Run.belongsTo(DaemonTeam, { foreignKey: 'team_id', as: 'team' });
    DaemonTeam.hasMany(Run, { foreignKey: 'team_id', as: 'runs' });

    Run.belongsTo(Workspace, { foreignKey: 'workspace_id', as: 'workspace' });
    Workspace.hasMany(Run, { foreignKey: 'workspace_id', as: 'runs' });

    Daemon.hasMany(Container, { foreignKey: 'daemon_id', as: 'daemon_containers' });
    Container.belongsTo(Daemon, { foreignKey: 'daemon_id', as: 'daemon' });

    Workspace.hasMany(WorkspaceTeam, { foreignKey: 'workspace_id', as: 'workspace_teams' });
    WorkspaceTeam.belongsTo(Workspace, { foreignKey: 'workspace_id', as: 'workspace' });

    DaemonTeam.hasMany(WorkspaceTeam, { foreignKey: 'team_id', as: 'workspace_teams' });
    WorkspaceTeam.belongsTo(DaemonTeam, { foreignKey: 'team_id', as: 'team' });

    Run.hasMany(RunEvent, { foreignKey: 'run_id', sourceKey: 'run_id', as: 'events' });
    RunEvent.belongsTo(Run, { foreignKey: 'run_id', targetKey: 'run_id', as: 'run' });

    Run.hasMany(RunLog, { foreignKey: 'run_id', sourceKey: 'run_id', as: 'logs' });
    RunLog.belongsTo(Run, { foreignKey: 'run_id', targetKey: 'run_id', as: 'run' });

    Run.hasMany(RunPhase, { foreignKey: 'run_id', sourceKey: 'run_id', as: 'phases' });
    RunPhase.belongsTo(Run, { foreignKey: 'run_id', targetKey: 'run_id', as: 'run' });

    Run.hasMany(RunArtifact, { foreignKey: 'run_id', sourceKey: 'run_id', as: 'artifacts' });
    RunArtifact.belongsTo(Run, { foreignKey: 'run_id', targetKey: 'run_id', as: 'run' });

    Run.hasMany(Container, { foreignKey: 'run_id', sourceKey: 'run_id', as: 'containers' });
    Container.belongsTo(Run, { foreignKey: 'run_id', targetKey: 'run_id', as: 'run' });

    Realm.hasMany(RealmMember, { foreignKey: 'realm_id', as: 'members' });
    RealmMember.belongsTo(Realm, { foreignKey: 'realm_id', as: 'realm' });

    NotificationChannel.hasMany(ChannelDestination, { foreignKey: 'channel_id', as: 'destinations_rows' });
    ChannelDestination.belongsTo(NotificationChannel, { foreignKey: 'channel_id', as: 'channel' });

    Review.hasMany(ReviewMessage, { foreignKey: 'review_id', as: 'messages' });
    ReviewMessage.belongsTo(Review, { foreignKey: 'review_id', as: 'review' });

    Review.hasMany(ReviewNotification, { foreignKey: 'review_id', as: 'notifications' });
    ReviewNotification.belongsTo(Review, { foreignKey: 'review_id', as: 'review' });
}

let _inited_for: Sequelize | null = null;

/**
 * Guard for the store-side models that `init_control_plane_store` used to
 * initialise on a second Sequelize instance. Now that we have a single
 * connection this is a no-op — every model is already registered by
 * `init_models`. Kept so callers in `control_plane_store.ts` / tests
 * don't need to change until the next cleanup pass.
 */
export function init_core_api_models(sequelize: Sequelize): void {
    if (_inited_for === sequelize) return;
    _inited_for = sequelize;
}

/** Clear init guard (tests / process recycle). */
export function reset_core_api_models(): void {
    _inited_for = null;
}

/**
 * @deprecated Use init_models directly.
 * Kept for callers that previously initialised only the store subset.
 */
export function init_store_models(sequelize: Sequelize): void {
    init_models(sequelize);
}
