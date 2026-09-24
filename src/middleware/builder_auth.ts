import type { Request, Response, NextFunction } from 'express';
import { verify_token } from '../auth/jwt.js';

export function create_builder_auth(jwt_secret: string, allowed_origins: string[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const header = req.headers.authorization;
        if (header?.startsWith('Bearer ')) {
            try {
                verify_token(header.slice(7), jwt_secret);
                return next();
            } catch {
                // fall through to origin check
            }
        }

        const origin = req.headers.origin as string | undefined;
        if (origin && allowed_origins.includes(origin)) {
            return next();
        }

        res.status(401).json({
            ok: false,
            error: { code: 'unauthorized', message: 'Authentication required' },
        });
    };
}
