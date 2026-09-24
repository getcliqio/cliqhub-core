/**
 * HTTP-shaped error thrown from controllers/services. The error handler
 * turns it into the standard `{ ok: false, error, code? }` envelope.
 *
 * `code` is an optional machine-readable tag (e.g. `run/stranded`) that
 * the UI uses to pick specialised messaging (a "Run again" quick-action
 * for stranded runs, a "waiting for daemon" toast for transient offline,
 * etc.) without string-matching on the human message.
 *
 * Existing callers that pass only `(message)` keep working — `code`
 * defaults to undefined and is omitted from the response body.
 */
export class ApiError extends Error {
    constructor(
        public readonly status_code: number,
        message: string,
        public readonly code?: string,
    ) {
        super(message);
        this.name = 'ApiError';
    }

    static bad_request(message: string, code?: string): ApiError {
        return new ApiError(400, message, code);
    }

    static unauthorized(message: string, code?: string): ApiError {
        return new ApiError(401, message, code);
    }

    static forbidden(message: string, code?: string): ApiError {
        return new ApiError(403, message, code);
    }

    static not_found(message: string, code?: string): ApiError {
        return new ApiError(404, message, code);
    }

    static gone(message: string, code?: string): ApiError {
        return new ApiError(410, message, code);
    }

    static conflict(message: string, code?: string): ApiError {
        return new ApiError(409, message, code);
    }

    static internal(message: string, code?: string): ApiError {
        return new ApiError(500, message, code);
    }

    static service_unavailable(message: string, code?: string): ApiError {
        return new ApiError(503, message, code);
    }
}
