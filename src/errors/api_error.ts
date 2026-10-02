const STATUS_MAP: Record<string, number> = {
    unauthorized: 401,
    sign_in_required: 401,
    forbidden: 403,
    email_mismatch: 403,
    account_deleted: 403,
    not_found: 404,
    conflict: 409,
    deleted: 409,
    locked: 409,
    already_member: 409,
    not_pending: 409,
    owns_orgs: 409,
    not_active: 409,
    expired: 410,
    invalid_params: 422,
    rate_limited: 429,
};

export function status_for_code(code: string): number {
    return STATUS_MAP[code] ?? 500;
}

/** What kind of row holds a name (org slug, username or email). */
export type NameHolderKind = 'org' | 'user';

/** `details` of `409 deleted`: the soft-deleted row that holds the name. */
export interface DeletedDetails {
    kind: NameHolderKind;
    id: string;
    /** ISO timestamp. */
    deleted_at: string;
    /** Whether the row was ever active (an org whose owner joined, a user who signed in). */
    was_active: boolean;
}

/** `details` of `409 conflict`: the live row that holds the name. */
export interface ConflictDetails {
    kind: NameHolderKind | 'scope';
    /** The request field that collided (`slug`, `username`, `email`). */
    field: string;
    holder: { id: string; slug: string | null };
    [extra: string]: unknown;
}

export class ApiError extends Error {
    code: string;
    status: number;
    /** Machine-readable context sent with the error (e.g. who holds a conflicting slug). */
    details?: Record<string, unknown>;

    constructor(code: string, message: string, status?: number, details?: Record<string, unknown>) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.status = status ?? status_for_code(code);
        if (details) this.details = details;
    }

    /** `409 conflict`: a live org or user holds the slug, username or email. */
    static name_conflict(message: string, details: ConflictDetails): ApiError {
        return new ApiError('conflict', message, 409, details);
    }

    /** `409 deleted`: the name belongs to a soft-deleted org or user (a site admin may reactivate it). */
    static deleted(message: string, details: DeletedDetails): ApiError {
        return new ApiError('deleted', message, 409, { ...details });
    }

    /** `409 locked`: a system rule or channel cannot be changed or removed. */
    static locked(system_key: string, message = 'This is a built-in setting and cannot be changed.'): ApiError {
        return new ApiError('locked', message, 409, { system_key });
    }

    /** `409 already_member`: the invited person is already an active member. */
    static already_member(user_id: string, message = 'Already a member.'): ApiError {
        return new ApiError('already_member', message, 409, { user_id });
    }

    /** `409 not_pending`: accept, decline or revoke on an invite (or a used link) that is no longer pending. */
    static not_pending(status: string, message = `This link was already ${status}.`): ApiError {
        return new ApiError('not_pending', message, 409, { status });
    }

    /** `409 owns_orgs`: the user still owns orgs that must be transferred or deleted first. */
    static owns_orgs(orgs: Array<{ slug: string }>, message = 'Transfer or delete these orgs first.'): ApiError {
        return new ApiError('owns_orgs', message, 409, { orgs });
    }

    /** `409 not_active`: the user is not active (for example suspended). */
    static not_active(status: string, message = 'The user is not active.'): ApiError {
        return new ApiError('not_active', message, 409, { status });
    }

    /** `410 expired`: the invite or password link expired. `expired_at` is an ISO timestamp. */
    static expired(expired_at: string, message = 'This link has expired. Ask for it to be sent again.'): ApiError {
        return new ApiError('expired', message, 410, { expired_at });
    }

    /** `401 sign_in_required`: the invitee has an account and must sign in to accept. */
    static sign_in_required(invitee_email: string, message = 'Sign in to accept this invite.'): ApiError {
        return new ApiError('sign_in_required', message, 401, { invitee_email });
    }

    /** `403 email_mismatch`: signed in as someone other than the invitee. */
    static email_mismatch(invitee_email: string, message = 'This invite is for a different email address.'): ApiError {
        return new ApiError('email_mismatch', message, 403, { invitee_email });
    }

    /** `403 account_deleted`: a deleted person tried to sign in or sign up. */
    static account_deleted(message = 'This account was deleted. Contact your admin.'): ApiError {
        return new ApiError('account_deleted', message, 403);
    }

    /** `429 rate_limited`: too many requests. */
    static rate_limited(message = 'Too many requests. Try again later.'): ApiError {
        return new ApiError('rate_limited', message, 429);
    }
}

export class ParamError extends ApiError {
    constructor(message: string) {
        super('invalid_params', message, 422);
        this.name = 'ParamError';
    }
}
