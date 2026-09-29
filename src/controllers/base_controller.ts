import type { Request, Response, NextFunction } from 'express';
import type { z, ZodTypeAny } from 'zod';
import { ApiError as LegacyApiError } from '../errors/api_error.js';
import { ApiError } from '../lib/api_error.js';
import { Realm } from '../models/index.js';
import type { AuthContext } from '../schemas/auth_types.js';

export abstract class BaseController {
    // Use `ZodTypeAny` + `z.infer<S>` so the inferred return type is the
    // schema's *output* shape (post-default, post-transform). Constraining
    // to a single generic via `ZodSchema<T>` collapses input and output
    // and breaks `.default()` / `.transform()` schemas.
    protected parse_body<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const messages = result.error.issues
                .map(i => `${i.path.join('.')}: ${i.message}`)
                .join('; ');
            throw new LegacyApiError('invalid_params', messages, 422);
        }
        return result.data;
    }

    protected ok<T>(res: Response, data: T, status: number = 200): void {
        res.status(status).json({ ok: true, data });
    }

    /**
     * Express adapter: async controller method → handler with `.catch(next)`.
     * Generic so typed `ApiRequest` / `ApiOkResponse` methods still wire cleanly.
     */
    wrap<Req extends Request, Res extends Response>(
        handler: (req: Req, res: Res) => Promise<void>,
    ): (req: Request, res: Response, next: NextFunction) => Promise<void> {
        return (req, res, next) => {
            return handler.call(this, req as Req, res as Res).catch(next);
        };
    }

    protected auth_from(req: Request): AuthContext | undefined {
        return (req as Request & { auth?: AuthContext }).auth;
    }

    /**
     * Bearer must be allowed to act on `org_id`.
     * PAT/session: org_id ∈ auth.org_ids. Daemon token: realm.org_id === org_id.
     * Site hub admin may act on any org_id.
     */
    protected async assert_org_authorized(auth: AuthContext | undefined, org_id: string): Promise<void> {
        if (!auth) {
            throw ApiError.unauthorized('authentication required');
        }

        if (auth.user?.role === 'admin') return;

        if (auth.auth_via === 'daemon_token') {
            if (!auth.realm_id) {
                throw ApiError.forbidden('daemon token has no realm binding');
            }
            const realm = await Realm.findByPk(auth.realm_id);
            if (!realm || realm.org_id !== org_id) {
                throw ApiError.forbidden('org_id does not match daemon realm organization');
            }
            return;
        }

        if (!auth.org_ids.includes(org_id)) {
            throw ApiError.forbidden('not a member of the requested organization');
        }
    }
}
