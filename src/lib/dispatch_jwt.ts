/**
 * Sign / verify short-lived Ed25519 JWTs for Hub → daemon calls.
 */

import { importPKCS8, importSPKI, SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';

export const DISPATCH_JWT_ISS = 'cliq-core-api';
export const DISPATCH_JWT_TTL_SECONDS = 5 * 60;

export interface DispatchJwtClaims {
    realm_id: string;
    aud?: string;
    run_id?: string;
    action?: 'execute' | 'cancel' | 'access';
}

export interface VerifiedDispatchClaims {
    realm_id?: string;
    aud?: string | string[];
    run_id?: string;
    action?: string;
    iss?: string;
    exp?: number;
    iat?: number;
    jti?: string;
}

export async function sign_dispatch_jwt(
    private_key_pem: string,
    claims: DispatchJwtClaims,
): Promise<string> {
    const key = await importPKCS8(private_key_pem, 'EdDSA');
    const now = Math.floor(Date.now() / 1000);

    let builder = new SignJWT({
        realm_id: claims.realm_id,
        ...(claims.run_id ? { run_id: claims.run_id } : {}),
        ...(claims.action ? { action: claims.action } : { action: 'access' }),
    })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
        .setIssuer(DISPATCH_JWT_ISS)
        .setIssuedAt(now)
        .setExpirationTime(now + DISPATCH_JWT_TTL_SECONDS)
        .setJti(randomUUID());

    if (claims.aud) {
        builder = builder.setAudience(claims.aud);
    }

    return builder.sign(key);
}

export async function verify_dispatch_jwt(
    token: string,
    public_key_pem: string,
): Promise<VerifiedDispatchClaims> {
    const key = await importSPKI(public_key_pem, 'EdDSA');
    const { payload } = await jwtVerify(token, key, {
        issuer: DISPATCH_JWT_ISS,
    });
    return {
        realm_id: typeof payload.realm_id === 'string' ? payload.realm_id : undefined,
        aud: payload.aud,
        run_id: typeof payload.run_id === 'string' ? payload.run_id : undefined,
        action: typeof payload.action === 'string' ? payload.action : undefined,
        iss: typeof payload.iss === 'string' ? payload.iss : undefined,
        exp: typeof payload.exp === 'number' ? payload.exp : undefined,
        iat: typeof payload.iat === 'number' ? payload.iat : undefined,
        jti: typeof payload.jti === 'string' ? payload.jti : undefined,
    };
}
