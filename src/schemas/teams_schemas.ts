/**
 * @deprecated Import from `schemas/teams/inputs.ts` instead.
 *
 * This file re-exports the PascalCase schemas under their original snake_case
 * names for backwards compatibility with any remaining consumers.
 * New code must import directly from `schemas/teams/inputs.ts`.
 */

export {
    TeamsGetInput       as teams_get_schema,
    TeamsGetByIdInput   as teams_get_by_id_schema,
    TeamsGetVersionsInput as teams_get_versions_schema,
    TeamsGetPhasesInput as teams_get_phases_schema,
    TeamsCreateInput    as teams_create_schema,
    TeamsUpdateInput    as teams_update_schema,
    TeamsPublishInput   as publish_schema,
    TeamsUnpublishInput as unpublish_schema,
    TeamsDownloadInput  as download_schema,
    TeamsDeleteTeamInput  as delete_team_schema,
    TeamsDeleteVersionInput as delete_version_schema,
    TeamsRenameInput    as rename_schema,
} from './teams/inputs.js';
