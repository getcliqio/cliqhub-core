import type { Router, RequestHandler } from 'express';
import { DaemonController } from '../../controllers/daemons_controller.js';
import { CommandAckController } from '../../controllers/command_ack_controller.js';
import { DaemonAclController } from '../../controllers/daemon_acl_controller.js';

export function register_daemons_routes(router: Router, auth: RequestHandler): void {
    router.post('/daemons/register', auth, DaemonController.register);
    router.post('/daemons/heartbeat', auth, DaemonController.heartbeat);
    router.post('/daemons/deregister', auth, DaemonController.deregister);
    router.post('/daemons/get', auth, DaemonController.get);
    router.post('/daemons/get_by_id', auth, DaemonController.get_by_id);
    router.post('/daemons/remove', auth, DaemonController.remove);
    router.post('/daemons/ack_command', auth, CommandAckController.ack_command);
    router.post('/auth/acl', auth, DaemonAclController.get_acl);
}
