import type { Router } from 'express';
import { SystemController } from '../../controllers/system_controller.js';
import { JiraIntegrationController } from '../../controllers/jira_integration_controller.js';

/** Unauthenticated `/v1` routes (health + Jira Forge). */
export function register_public_v1_routes(pub: Router): void {
    pub.get('/health', SystemController.health);

    pub.post(
        '/integrations/jira/register',
        JiraIntegrationController.gate,
        JiraIntegrationController.register,
    );
    pub.post(
        '/integrations/jira/rotate_secret',
        JiraIntegrationController.gate,
        JiraIntegrationController.rotate_secret,
    );
    pub.post(
        '/integrations/jira/list_realms',
        JiraIntegrationController.gate,
        JiraIntegrationController.list_realms,
    );
    pub.post(
        '/integrations/jira/list',
        JiraIntegrationController.gate,
        JiraIntegrationController.list,
    );
    pub.post(
        '/integrations/jira/disconnect',
        JiraIntegrationController.gate,
        JiraIntegrationController.disconnect,
    );
}
