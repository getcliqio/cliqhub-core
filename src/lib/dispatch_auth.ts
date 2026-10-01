/**
 * DispatchAuth — JWT signing/verification and key-pair generation for dispatch tokens.
 *
 * Dispatch tokens authenticate a realm's outbound calls to the dispatch service.
 * Each realm holds an RSA key pair: the private key signs JWTs issued by Core;
 * the public key is registered with the dispatch service for verification.
 *
 * Merged from the former `dispatch_jwt.ts` (sign/verify) and `dispatch_keys.ts`
 * (key-pair generation) into a single class for cohesion.
 */

import { importPKCS8, importSPKI, SignJWT, jwtVerify } from 'jose';
import { generateKeyPair, exportSPKI, exportPKCS8 } from 'jose';
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

export interface DispatchKeyPair {
    public_key_pem: string;
    private_key_pem: string;
}

export class DispatchAuth {
    /**
     * Sign a dispatch JWT using an Ed25519 private key.
     *
     * @param private_key_pem - PKCS8 PEM-encoded Ed25519 private key.
     * @param claims - Required realm_id plus optional aud / run_id / action.
     * @returns Compact JWT string, valid for {@link DISPATCH_JWT_TTL_SECONDS} seconds.
     */
    static async sign_jwt(private_key_pem: string, claims: DispatchJwtClaims): Promise<string> {
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

    /**
     * Verify a dispatch JWT using an Ed25519 public key.
     *
     * Validates the signature, expiry, and issuer claim.
     * Throws a `JWTExpired` / `JWTInvalid` error from `jose` on failure.
     *
     * @param token - Compact JWT to verify.
     * @param public_key_pem - SPKI PEM-encoded Ed25519 public key.
     * @returns Decoded and verified claims.
     */
    static async verify_jwt(token: string, public_key_pem: string): Promise<VerifiedDispatchClaims> {
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

    /**
     * Generate a fresh Ed25519 key pair for dispatch authentication.
     *
     * Store the private key in the realm row (encrypted at rest);
     * register the public key with the dispatch service.
     *
     * @returns `{ public_key_pem, private_key_pem }` both as SPKI/PKCS8 PEM strings.
     */
    static async generate_key_pair(): Promise<DispatchKeyPair> {
        const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
        const public_key_pem = await exportSPKI(publicKey);
        const private_key_pem = await exportPKCS8(privateKey);
        return { public_key_pem, private_key_pem };
    }
}
