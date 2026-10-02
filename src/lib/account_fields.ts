/**
 * The rules every account field follows, wherever an account is created or
 * changed (signup, users/new, invite accept, password changes, orgs/new):
 * username, email and password. Each check throws the same `422
 * invalid_params` with `details.field`, so every route reports a bad field the
 * same way.
 */

import { ApiError } from '../errors/api_error.js';
import { EMAIL_PATTERN, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, RESERVED_SCOPES, SLUG_PATTERN } from '../config/env.js';

/**
 * Normalizes a username (trimmed, lowercase) and checks its form. Whether the
 * name is free is checked separately (lib/namespace.ts).
 *
 * @param field - The request field reported in `details.field`.
 * @throws ApiError 422 invalid_params when it is empty, malformed or reserved
 */
export function normalize_username(raw: string | undefined, field = 'username'): string {
    const username = (raw ?? '').trim().toLowerCase();
    if (!username) throw new ApiError('invalid_params', `${field} is required`, 422, { field });
    if (!SLUG_PATTERN.test(username)) {
        throw new ApiError('invalid_params', 'Username must start with a letter and contain only lowercase letters, numbers, and hyphens', 422, { field });
    }
    if (RESERVED_SCOPES.includes(username)) throw new ApiError('invalid_params', `Username '${username}' is reserved`, 422, { field });
    return username;
}

/**
 * Normalizes an email address (trimmed, lowercase) and checks its form.
 *
 * @param field - The request field reported in `details.field`.
 * @throws ApiError 422 invalid_params when it is not an email address
 */
export function normalize_email(raw: string, field = 'email'): string {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new ApiError('invalid_params', 'Invalid email address', 422, { field });
    return email;
}

/**
 * Checks a new password's length.
 *
 * @param field - The request field reported in `details.field`.
 * @throws ApiError 422 invalid_params when it is too short or too long
 */
export function assert_password_rules(password: string, field = 'password'): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
        throw new ApiError('invalid_params', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 422, { field });
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
        throw new ApiError('invalid_params', `Password must be at most ${MAX_PASSWORD_LENGTH} characters`, 422, { field });
    }
}
