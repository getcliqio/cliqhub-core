import type { Sequelize } from 'sequelize';
import { User, init_user_model } from './user.js';
import { Org, init_org_model } from './org.js';
import { OrgMember, init_org_member_model } from './org_member.js';
import { AccountInvite, init_account_invite_model } from './account_invite.js';
import { RealmInvite, init_realm_invite_model } from './realm_invite.js';
import { ApiToken, init_api_token_model } from './api_token.js';
import { Scope, init_scope_model } from './scope.js';
import { ScopeMember, init_scope_member_model } from './scope_member.js';
import { Team, init_team_model } from './team.js';
import { TeamVersion, init_team_version_model } from './team_version.js';
import { TeamTag, init_team_tag_model } from './team_tag.js';
import { Draft, init_draft_model } from './draft.js';
import { AuditLog, init_audit_log_model } from './audit_log.js';
import { DownloadLog, init_download_log_model } from './download_log.js';
import { Setting, init_setting_model } from './setting.js';
import { init_account_agent_setting_model } from './account_agent_setting.js';
import { RealmAgentSetting, init_realm_agent_setting_model } from './realm_agent_setting.js';
import { OrgRole, init_org_role_model } from './org_role.js';
import { OrgAgentSetting, init_org_agent_setting_model } from './org_agent_setting.js';

export {
    User, Org, OrgMember, OrgRole, AccountInvite, RealmInvite, ApiToken, Scope, ScopeMember,
    Team, TeamVersion, TeamTag,
    Draft, AuditLog, DownloadLog, Setting,
    OrgAgentSetting,
    RealmAgentSetting,
};

export function init_models(sequelize: Sequelize): void {
    init_user_model(sequelize);
    init_org_model(sequelize);
    init_org_member_model(sequelize);
    init_account_invite_model(sequelize);
    init_realm_invite_model(sequelize);
    init_api_token_model(sequelize);
    init_scope_model(sequelize);
    init_scope_member_model(sequelize);
    init_team_model(sequelize);
    init_team_version_model(sequelize);
    init_team_tag_model(sequelize);
    init_draft_model(sequelize);
    init_audit_log_model(sequelize);
    init_download_log_model(sequelize);
    init_setting_model(sequelize);
    init_account_agent_setting_model(sequelize);
    init_realm_agent_setting_model(sequelize);
    init_org_role_model(sequelize);
    init_org_agent_setting_model(sequelize);

    // Associations
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
}
