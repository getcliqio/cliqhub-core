/**
 * @deprecated Import directly from schemas/orgs/inputs.ts (PascalCase names).
 * This file re-exports the canonical schemas under legacy snake_case aliases
 * so existing imports continue to work while controllers migrate.
 */
export {
    OrgsGetInput as orgs_get_schema,
    OrgIdInput as orgs_get_by_id_schema,
    OrgInput as orgs_new_schema,
    OrgInput as orgs_update_schema,
    OrgIdInput as orgs_delete_schema,
    OrgsAddMemberInput as orgs_add_member_schema,
    OrgsRemoveMemberInput as orgs_remove_member_schema,
    OrgRoleIdInput as orgs_list_roles_schema,
    OrgRoleIdInput as orgs_get_role_schema,
    OrgRoleInput as orgs_create_role_schema,
    OrgRoleInput as orgs_update_role_schema,
    OrgRoleIdInput as orgs_delete_role_schema,
    OrgIdInput as orgs_leave_schema,
    OrgScopeInput as orgs_new_scope_schema,
    OrgScopeInput as orgs_delete_scope_schema,
    OrgScopeInput as orgs_update_scope_schema,
    OrgScopeMemberInput as orgs_assign_scope_member_schema,
    OrgScopeMemberInput as orgs_unassign_scope_member_schema,
    OrgsGetScopesInput as orgs_get_scopes_schema,
    OrgsGetReviewableTargetsInput as orgs_get_reviewable_targets_schema,
} from './orgs/inputs.js';
