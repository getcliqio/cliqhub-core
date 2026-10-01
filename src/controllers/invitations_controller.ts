import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { InvitationsService } from '../services/invitations_service.js';
import { get_logger } from '../lib/log.js';
import {
    invitations_create_schema,
    invitations_get_schema,
    invitations_get_by_id_schema,
    invitations_revoke_schema,
    invitations_get_by_token_schema,
    invitations_accept_schema,
} from '../schemas/invitation_types.js';

const log = get_logger('ctrl.invitations');

export class InvitationsController extends BaseController {
    constructor(private _invitations_service: InvitationsService) {
        super();
    }

    async create(req: Request, res: Response): Promise<void> {
        log.debug('create', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_create_schema, req);
        const result = await this._invitations_service.create(req.auth, body);
        log.info('invitation_created', { target_type: body.target_type, org_id: body.org_id, realm_id: body.realm_id, role: body.role, status: (result as { status?: string }).status });
        this.ok(res, result);
    }

    async get(req: Request, res: Response): Promise<void> {
        log.debug('get', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_get_schema, req);
        const result = await this._invitations_service.get(req.auth, body);
        this.ok(res, result);
    }

    async get_by_id(req: Request, res: Response): Promise<void> {
        log.debug('get_by_id', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_get_by_id_schema, req);
        const result = await this._invitations_service.get_by_id(req.auth, body);
        this.ok(res, result);
    }

    async revoke(req: Request, res: Response): Promise<void> {
        log.debug('revoke', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_revoke_schema, req);
        const result = await this._invitations_service.revoke(req.auth, body);
        log.info('invitation_revoked', { target_type: body.target_type, invite_id: body.invite_id });
        this.ok(res, result);
    }

    async get_by_token(req: Request, res: Response): Promise<void> {
        log.debug('get_by_token', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_get_by_token_schema, req);
        const result = await this._invitations_service.get_by_token(req.auth, body);
        this.ok(res, result);
    }

    async accept(req: Request, res: Response): Promise<void> {
        log.debug('accept', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_accept_schema, req);
        const result = await this._invitations_service.accept(req.auth, body);
        log.info('invitation_accepted', { target_type: (result as { target_type?: string }).target_type, new_account: Boolean((result as { token?: string }).token) });
        this.ok(res, result);
    }
}
