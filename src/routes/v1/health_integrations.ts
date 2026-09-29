import type { Router } from 'express';
import { SystemController } from '../../controllers/system_controller.js';
import {
    JiraIntegrationController,
    require_jira_enabled,
} from '../../controllers/jira_integration_controller.js';

/** Unauthenticated `/v1` routes (health + Jira Forge). */
export function register_public_v1_routes(pub: Router): void {
    pub.get('/health', SystemController.health);

    const jira = new JiraIntegrationController();
    pub.post('/integrations/jira/register_workspace',  require_jira_enabled, jira.wrap(jira.register_workspace));
    pub.post('/integrations/jira/rotate_secret',       require_jira_enabled, jira.wrap(jira.rotate_secret));
    pub.post('/integrations/jira/get_workspaces',      require_jira_enabled, jira.wrap(jira.get_workspaces));
    pub.post('/integrations/jira/disconnect_workspace', require_jira_enabled, jira.wrap(jira.disconnect_workspace));
}
