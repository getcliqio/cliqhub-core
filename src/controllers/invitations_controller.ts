/**
 * Invitations controller — org (member, admin, owner) and realm invites.
 *
 * POST /v1/invitations/create
 * POST /v1/invitations/get
 * POST /v1/invitations/get_by_id
 * POST /v1/invitations/revoke
 * POST /v1/invitations/get_by_token   (public)
 * POST /v1/invitations/accept         (public; accept or decline)
 */

import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { InvitationsService } from '../services/invitations_service.js';
import { get_logger } from '../lib/log.js';
import {
    invitations_create_schema,
    invitations_get_schema,
    invitations_id_schema,
    invitations_get_by_token_schema,
    invitations_accept_schema,
} from '../schemas/invitation_types.js';

const log = get_logger('ctrl.invitations');

/** HTTP handlers for `invitations/*`; the service enforces the rules. */
export class InvitationsController extends BaseController {
    constructor(private _invitations_service: InvitationsService) {
        super();
    }

    /** POST /v1/invitations/create — invite, or send a pending invite again. */
    async create(req: Request, res: Response): Promise<void> {
        log.debug('create', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_create_schema, req);
        const result = await this._invitations_service.create(req.auth, body);
        this.ok(res, result);
    }

    /** POST /v1/invitations/get — one org's or realm's invites. */
    async get(req: Request, res: Response): Promise<void> {
        log.debug('get', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_get_schema, req);
        const result = await this._invitations_service.get(req.auth, body);
        this.ok(res, result);
    }

    /** POST /v1/invitations/get_by_id — one invite. */
    async get_by_id(req: Request, res: Response): Promise<void> {
        log.debug('get_by_id', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_id_schema, req);
        const result = await this._invitations_service.get_by_id(req.auth, body);
        this.ok(res, result);
    }

    /** POST /v1/invitations/revoke — cancel a pending invite. */
    async revoke(req: Request, res: Response): Promise<void> {
        log.debug('revoke', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_id_schema, req);
        const result = await this._invitations_service.revoke(req.auth, body);
        this.ok(res, result);
    }

    /** POST /v1/invitations/get_by_token — the invite page preview (public). */
    async get_by_token(req: Request, res: Response): Promise<void> {
        log.debug('get_by_token', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_get_by_token_schema, req);
        const result = await this._invitations_service.get_by_token(req.auth, body);
        this.ok(res, result);
    }

    /** POST /v1/invitations/accept — accept or decline (public). */
    async accept(req: Request, res: Response): Promise<void> {
        log.debug('accept', { user_id: req.auth?.user?.id });
        const body = this.parse_body(invitations_accept_schema, req);
        const result = await this._invitations_service.accept(req.auth, body);
        this.ok(res, result);
    }
}
