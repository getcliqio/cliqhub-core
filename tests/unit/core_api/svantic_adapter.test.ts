import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

vi.mock('../../../src/mesh/adapters/svantic_client.js', async (import_original) => {
    const actual = await import_original<typeof import('../../../src/mesh/adapters/svantic_client.js')>();
    return {
        ...actual,
        svantic_http: {
            get_token: vi.fn(async () => 'tok'),
            register: vi.fn(async () => ({ ok: true })),
            deregister: vi.fn(async () => undefined),
        },
    };
});

import { svantic_mesh_adapter } from '../../../src/mesh/adapters/svantic.adapter.js';
import {
    svantic_http,
    svantic_instance_id,
    verify_svantic_dispatch_jwt,
} from '../../../src/mesh/adapters/svantic_client.js';

describe('svantic adapter hosted', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('connect registers hosted agent and can mint dispatch secret', async () => {
        const health = await svantic_mesh_adapter.connect({
            realm_id: 'r1',
            realm_slug: 'acme',
            public_a2a_url: 'https://api.cliqhub.io/a2a/r/acme',
            settings: {
                api_url: 'https://api.svantic.com',
                client_id: 'cid',
                client_secret: 'csec',
                mode: 'hosted',
            },
        });

        expect(health.status).toBe('connected');
        expect(svantic_http.get_token).toHaveBeenCalled();
        expect(svantic_http.register).toHaveBeenCalledWith(
            expect.objectContaining({
                deployment_mode: 'hosted',
                public_url: 'https://api.cliqhub.io/a2a/r/acme',
                instance_id: 'cliq-realm-r1',
            }),
        );
        expect(health.details?.dispatch_secret_once).toBeTruthy();
        expect(health.details?.settings_patch).toMatchObject({
            dispatch_secret: expect.any(String),
        });
    });

    it('verify_inbound accepts valid svantic JWT', async () => {
        const secret = 'test-signing-secret';
        const instance_id = svantic_instance_id('r1');
        const jwt = await new SignJWT({
            instance_id,
            tenant_id: 't1',
            agent_type: 'cliq-realm',
            dispatch_id: 'd1',
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('svantic-mesh')
            .setAudience(`agent:${instance_id}`)
            .setExpirationTime('2m')
            .sign(new TextEncoder().encode(secret));

        const ok = await verify_svantic_dispatch_jwt({
            req: {
                headers: {},
                body: {
                    params: {
                        message: {
                            parts: [{ kind: 'data', data: { svantic_auth: jwt } }],
                        },
                    },
                },
            },
            signing_secret: secret,
            instance_id,
        });
        expect(ok).toBe(true);

        const adapter_ok = await svantic_mesh_adapter.verify_inbound!(
            {
                headers: {},
                body: {
                    params: {
                        message: {
                            parts: [{ kind: 'data', data: { svantic_auth: jwt } }],
                        },
                    },
                },
            },
            { dispatch_secret: secret },
            'r1',
        );
        expect(adapter_ok).toBe(true);
    });
});
