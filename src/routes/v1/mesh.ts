/**
 * Mesh adapters + account/org mesh settings.
 *
 * Split from realms.ts — not the Realms product resource.
 */

import type { Router, RequestHandler } from 'express';
import { RealmA2aController } from '../../controllers/realm_a2a_controller.js';
import { AccountMeshController } from '../../controllers/account_mesh_controller.js';
import { OrgMeshController } from '../../controllers/org_mesh_controller.js';

export function register_mesh_routes(router: Router, auth: RequestHandler): void {
    router.post('/mesh/adapters/list', auth, RealmA2aController.list_adapters);
    router.post('/account/mesh/get', auth, AccountMeshController.get);
    router.post('/account/mesh/update', auth, AccountMeshController.update);
    router.post('/orgs/mesh/get', auth, OrgMeshController.get);
    router.post('/orgs/mesh/update', auth, OrgMeshController.update);
}
