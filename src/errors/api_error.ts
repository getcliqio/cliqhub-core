const STATUS_MAP: Record<string, number> = {
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    invalid_params: 422,
    rate_limited: 429,
};

export class ApiError extends Error {
    code: string;
    status: number;

    constructor(code: string, message: string, status?: number) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.status = status ?? status_for_code(code);
    }
}

export class ParamError extends ApiError {
    constructor(message: string) {
        super('invalid_params', message, 422);
        this.name = 'ParamError';
    }
}

export function status_for_code(code: string): number {
    return STATUS_MAP[code] ?? 500;
}
