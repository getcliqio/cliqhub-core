/**
 * Daemon routes — lifecycle (register/heartbeat/deregister), lookup, removal, command ack, and ACL.
 *
 * POST   /v1/daemons/register
 * POST   /v1/daemons/heartbeat
 * POST   /v1/daemons/deregister
 * POST   /v1/daemons/get
 * POST   /v1/daemons/get_by_id
 * POST   /v1/daemons/remove
 * POST   /v1/daemons/ack_command
 * POST   /v1/auth/acl
 */
import type { Router } from 'express';
import { DaemonController } from '../../controllers/daemons_controller.js';
import { CommandAckController } from '../../controllers/command_ack_controller.js';
import { DaemonAclController } from '../../controllers/daemon_acl_controller.js';

export function register_daemons_routes(router: Router): void {
    const daemons = new DaemonController();

    router.post('/daemons/register', daemons.wrap(daemons.register));
    router.post('/daemons/heartbeat', daemons.wrap(daemons.heartbeat));
    router.post('/daemons/deregister', daemons.wrap(daemons.deregister));
    router.post('/daemons/get', daemons.wrap(daemons.get));
    router.post('/daemons/get_by_id', daemons.wrap(daemons.get_by_id));
    router.post('/daemons/remove', daemons.wrap(daemons.remove));
    router.post('/daemons/ack_command', CommandAckController.ack_command);
    router.post('/auth/acl', DaemonAclController.get_acl);
}
