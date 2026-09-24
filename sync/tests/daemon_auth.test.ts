import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT } from 'jose';
import type { Request, Response, NextFunction } from 'express';

import { create_daemon_auth } from '../src/middleware/daemon_auth.js';
import type { SyncEnvConfig } from '../src/config/env.js';

const JWT_SECRET = 'test-jwt-secret-for-unit-tests';

/** Minimal config for auth middleware tests. */
function make_config(): SyncEnvConfig {
    return {
        port: 4901,
        database_url: 'postgres://localhost/test',
        jwt_secret: JWT_SECRET,
        poll_timeout_ms: 30000,
        command_ttl_ms: 30000,
        client_timeout_ms: 30000,
        liveness_threshold_ms: 60000,
        notify_channel: 'sync_command_ready',
        response_notify_channel: 'sync_response_ready',
        log_level: 'silent',
        node_env: 'test',
        public_url: 'http://localhost:4901',
    };
}

/** Sign a test JWT with given claims. */
async function sign_token(
    claims: Record<string, unknown>,
    options?: { expired?: boolean },
): Promise<string> {
    const secret = new TextEncoder().encode(JWT_SECRET);
    let builder = new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt();

    if (options?.expired) {
        // Issue a token that expired 1 hour ago
        builder = builder.setExpirationTime(Math.floor(Date.now() / 1000) - 3600);
    }

    if (!options?.expired) {
        builder = builder.setExpirationTime('1h');
    }

    return builder.sign(secret);
}

/** Creates a minimal Express request mock. */
function make_req(headers: Record<string, string> = {}): Request {
    return { headers, daemon_auth: undefined } as unknown as Request;
}

/** Creates a no-op Response mock. */
function make_res(): Response {
    return {} as unknown as Response;
}

describe('create_daemon_auth middleware', () => {
    let middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;

    beforeAll(() => {
        const config = make_config();
        middleware = create_daemon_auth(config);
    });

    it('rejects requests with no Authorization header (401)', async () => {
        const req = make_req({});
        const next = () => {};

        await expect(
            middleware(req, make_res(), next),
        ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects requests with non-Bearer scheme (401)', async () => {
        const req = make_req({ authorization: 'Basic abc123' });
        const next = () => {};

        await expect(
            middleware(req, make_res(), next),
        ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects invalid tokens (401)', async () => {
        const req = make_req({ authorization: 'Bearer not.a.valid.token' });
        const next = () => {};

        await expect(
            middleware(req, make_res(), next),
        ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects expired tokens (401)', async () => {
        const token = await sign_token(
            { daemon_id: 'd1', realm_id: 'r1', scope_id: 's1' },
            { expired: true },
        );
        const req = make_req({ authorization: `Bearer ${token}` });
        const next = () => {};

        await expect(
            middleware(req, make_res(), next),
        ).rejects.toMatchObject({ status: 401 });
    });

    it('sets req.daemon_auth with valid token claims', async () => {
        const token = await sign_token({
            daemon_id: 'daemon-xyz',
            realm_id: 'realm-abc',
            scope_id: 'scope-123',
        });
        const req = make_req({ authorization: `Bearer ${token}` });
        const next = () => {};

        await middleware(req, make_res(), next);

        expect(req.daemon_auth).toEqual({
            daemon_id: 'daemon-xyz',
            realm_id: 'realm-abc',
            scope_id: 'scope-123',
        });
    });

    it('uses sub as scope_id fallback when scope_id claim is missing', async () => {
        const secret = new TextEncoder().encode(JWT_SECRET);
        const token = await new SignJWT({
            daemon_id: 'daemon-1',
            realm_id: 'realm-1',
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject('fallback-scope-from-sub')
            .setExpirationTime('1h')
            .setIssuedAt()
            .sign(secret);

        const req = make_req({ authorization: `Bearer ${token}` });
        const next = () => {};

        await middleware(req, make_res(), next);

        expect(req.daemon_auth?.scope_id).toBe('fallback-scope-from-sub');
    });

    it('rejects token missing daemon_id claim', async () => {
        const token = await sign_token({
            realm_id: 'realm-1',
            scope_id: 'scope-1',
        });
        const req = make_req({ authorization: `Bearer ${token}` });
        const next = () => {};

        await expect(
            middleware(req, make_res(), next),
        ).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    });

    it('rejects token missing realm_id claim', async () => {
        const token = await sign_token({
            daemon_id: 'daemon-1',
            scope_id: 'scope-1',
        });
        const req = make_req({ authorization: `Bearer ${token}` });
        const next = () => {};

        await expect(
            middleware(req, make_res(), next),
        ).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    });
});
