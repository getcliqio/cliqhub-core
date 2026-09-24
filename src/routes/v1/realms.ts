import type { Router, RequestHandler } from 'express';
import { RealmController } from '../../controllers/realms_controller.js';
import { RealmA2aController } from '../../controllers/realm_a2a_controller.js';
import { AccountMeshController } from '../../controllers/account_mesh_controller.js';
import { OrgMeshController } from '../../controllers/org_mesh_controller.js';
import { NotificationController } from '../../controllers/notifications_controller.js';

export function register_realms_routes(router: Router, auth: RequestHandler): void {
    // Realm hard-cut: no get_by_slug / grant / revoke / search_users / team-list / members/* twins.
    router.post('/realms/create', auth, RealmController.create);
    router.post('/realms/get', auth, RealmController.get);
    router.post('/realms/get_by_id', auth, RealmController.get_by_id);
    router.post('/realms/update', auth, RealmController.update);
    router.post('/realms/delete', auth, RealmController.delete);
    router.post('/realms/get_members', auth, RealmController.get_members);
    router.post('/realms/add_member', auth, RealmController.add_member);
    router.post('/realms/remove_member', auth, RealmController.remove_member);
    router.post('/realms/add_team', auth, RealmController.add_team);
    router.post('/realms/remove_team', auth, RealmController.remove_team);
    router.post('/realms/get_notification_rules', auth, NotificationController.rules_list);
    router.post('/realms/set_notification_rule', auth, NotificationController.rules_set);
    router.post('/realms/remove_notification_rule', auth, NotificationController.rules_remove);
    router.post('/realms/a2a', auth, RealmA2aController.handle);
    router.post('/mesh/adapters/list', auth, RealmA2aController.list_adapters);
    router.post('/account/mesh/get', auth, AccountMeshController.get);
    router.post('/account/mesh/update', auth, AccountMeshController.update);
    router.post('/orgs/mesh/get', auth, OrgMeshController.get);
    router.post('/orgs/mesh/update', auth, OrgMeshController.update);
}
