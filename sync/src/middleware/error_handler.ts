import type { Request, Response, NextFunction } from 'express';

/**
 * Canonical error envelope for all sync service responses.
 */
export function error_handler(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
): void {
    if (err instanceof SyncError) {
        res.status(err.status).json({
            ok: false,
            error: { code: err.code, message: err.message },
        });
        return;
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Sync] Unhandled error:', message);

    res.status(500).json({
        ok: false,
        error: {
            code: 'internal_error',
            message: process.env.NODE_ENV === 'production'
                ? 'Internal server error'
                : message,
        },
    });
}

export class SyncError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'SyncError';
    }
}
