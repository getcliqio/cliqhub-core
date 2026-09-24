import type { Request, Response, NextFunction } from 'express';
import type { z, ZodTypeAny } from 'zod';
import { ApiError } from '../errors/api_error.js';

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
            throw new ApiError('invalid_params', messages, 422);
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
}
