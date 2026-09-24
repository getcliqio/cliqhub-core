import jwt, { type SignOptions } from 'jsonwebtoken';

export interface JwtPayload {
    user_id: string;
    username: string;
    role: string;
    org_ids: string[];
    /**
     * Slugs the user could access at the time the token was issued.
     * Informational — always re-check server-side against the live DB.
     * Hub API auth no longer uses JWTs (see auth_middleware); this module
     * remains for builder / non-Hub signing only.
     */
    scopes?: string[];
    /** @deprecated Hub act-as is BFF session/update — not JWT claims. */
    impersonator_id?: number;
    impersonator_username?: string;
}

// jsonwebtoken v9 narrowed `expiresIn` to `number | StringValue` (a branded
// template type from `ms`). We accept arbitrary user-supplied strings (e.g.
// "30d", "1h") and cast to satisfy the overload — runtime validation is still
// performed by jsonwebtoken/ms.
export function sign_token(
    payload: JwtPayload,
    secret: string,
    expires_in: string = '30d',
): string {
    const options: SignOptions = { expiresIn: expires_in as SignOptions['expiresIn'] };
    return jwt.sign(payload, secret, options);
}

export function verify_token(token: string, secret: string): JwtPayload {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload & JwtPayload;
    const payload: JwtPayload = {
        user_id: decoded.user_id,
        username: decoded.username,
        role: decoded.role,
        org_ids: decoded.org_ids ?? [],
        scopes: Array.isArray(decoded.scopes) ? decoded.scopes : undefined,
    };
    if (typeof decoded.impersonator_id === 'number' && decoded.impersonator_username) {
        payload.impersonator_id = decoded.impersonator_id;
        payload.impersonator_username = decoded.impersonator_username;
    }
    return payload;
}
