import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { AuthService } from '../services/auth_service.js';
import {
    signup_schema,
    authenticate_user_schema,
    issue_session_token_schema,
    revoke_session_token_schema,
} from '../schemas/auth_schemas.js';
import { to_user_dto } from '../types/mappers.js';

export class AuthController extends BaseController {
    constructor(
        private _auth_service: AuthService,
    ) {
        super();
    }

    signup = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(signup_schema, req);
        const result = await this._auth_service.signup(
            body.username,
            body.email,
            body.password,
        );
        this.ok(res, {
            user: to_user_dto(result.user),
            token: result.token,
            account_id: result.account_id,
            account_slug: result.account_slug,
            default_realm_id: result.default_realm_id,
            default_realm_slug: result.default_realm_slug,
            default_realm_qualified: result.default_realm_qualified,
            enroll_token: result.enroll_token,
        });
    });

    authenticate_user = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(authenticate_user_schema, req);
        const result = await this._auth_service.authenticate_user(body.username, body.password);
        this.ok(res, {
            user: to_user_dto(result.user),
            token: result.token,
            scopes: result.scopes,
            org_slugs: result.org_slugs,
            default_realm_id: result.default_realm_id,
            default_realm_slug: result.default_realm_slug,
            default_realm_qualified: result.default_realm_qualified,
            enroll_token: result.enroll_token,
            orgs: result.orgs,
        });
    });

    issue_session_token = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(issue_session_token_schema, req);
        const result = await this._auth_service.issue_session_token(req.auth, body.user_id);
        this.ok(res, result);
    });

    revoke_session_token = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(revoke_session_token_schema, req);
        const result = await this._auth_service.revoke_session_token(body.token);
        this.ok(res, result);
    });
}
