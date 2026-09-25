import type { Router, RequestHandler } from 'express';
import { DaemonController } from '../../controllers/daemons_controller.js';
import { CommandAckController } from '../../controllers/command_ack_controller.js';
import { DaemonAclController } from '../../controllers/daemon_acl_controller.js';

export function register_daemons_routes(router: Router, auth: RequestHandler): void {
    const daemons = new DaemonController();

    router.post('/daemons/register', auth, daemons.wrap(daemons.register));
    router.post('/daemons/heartbeat', auth, daemons.wrap(daemons.heartbeat));
    router.post('/daemons/deregister', auth, daemons.wrap(daemons.deregister));
    router.post('/daemons/get', auth, daemons.wrap(daemons.get));
    router.post('/daemons/get_by_id', auth, daemons.wrap(daemons.get_by_id));
    router.post('/daemons/remove', auth, daemons.wrap(daemons.remove));
    router.post('/daemons/ack_command', auth, CommandAckController.ack_command);
    router.post('/auth/acl', auth, DaemonAclController.get_acl);
}
