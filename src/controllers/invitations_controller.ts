import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { InvitationsService } from '../services/invitations_service.js';
import {
    invitations_create_schema,
    invitations_get_schema,
    invitations_get_by_id_schema,
    invitations_revoke_schema,
    invitations_get_by_token_schema,
    invitations_accept_schema,
} from '../schemas/invitations_schemas.js';

export class InvitationsController extends BaseController {
    constructor(private _invitations_service: InvitationsService) {
        super();
    }

    async create(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(invitations_create_schema, req);
        const result = await this._invitations_service.create(req.auth, body);
        this.ok(res, result);
    }

    async get(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(invitations_get_schema, req);
        const result = await this._invitations_service.get(req.auth, body);
        this.ok(res, result);
    }

    async get_by_id(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(invitations_get_by_id_schema, req);
        const result = await this._invitations_service.get_by_id(req.auth, body);
        this.ok(res, result);
    }

    async revoke(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(invitations_revoke_schema, req);
        const result = await this._invitations_service.revoke(req.auth, body);
        this.ok(res, result);
    }

    async get_by_token(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(invitations_get_by_token_schema, req);
        const result = await this._invitations_service.get_by_token(req.auth, body);
        this.ok(res, result);
    }

    async accept(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(invitations_accept_schema, req);
        const result = await this._invitations_service.accept(req.auth, body);
        this.ok(res, result);
    }
}
