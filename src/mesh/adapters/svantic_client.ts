/**
 * Svantic mesh HTTP + inbound JWT — thin Hub wrappers over `@svantic/sdk`.
 *
 * Token / register / JWT verify come from the SDK. Deregister stays a
 * small fetch here until RegistrationClient grows a public deregister.
 * Hub still owns envelope extraction from inbound A2A `/send` bodies.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { verify_dispatch_auth } from '@svantic/sdk';
import { MeshAuth, RegistrationClient } from '@svantic/sdk/mesh';
import type { Inbound_dispatch } from '../types.js';

export interface Svantic_register_response {
    ok: true;
    tenant_id?: string;
    instance_id?: string;
    deployment_mode?: 'hosted' | 'connected';
    connect_url?: string | null;
    svantic_jwks_url?: string | null;
    dispatch_auth?: unknown;
}

export interface Svantic_http_client {
    get_token(input: {
        api_url: string;
        client_id: string;
        client_secret: string;
        agent_type: string;
    }): Promise<string>;

    register(input: {
        api_url: string;
        token: string;
        agent_type: string;
        instance_id: string;
        deployment_mode: 'hosted' | 'connected';
        /** Hosted public A2A base URL — sent as gateway field `url`. */
        public_url?: string;
        agent_card?: Record<string, unknown>;
        dispatch_auth?: { scheme: 'svantic_jwt' | 'shared_secret'; required: boolean };
    }): Promise<Svantic_register_response>;

    deregister(input: {
        api_url: string;
        token: string;
        agent_type: string;
        instance_id: string;
    }): Promise<void>;
}

function api_base(url: string): string {
    return url.replace(/\/+$/, '');
}

async function read_json(res: Response): Promise<Record<string, unknown>> {
    try {
        return await res.json() as Record<string, unknown>;
    } catch {
        return {};
    }
}

export const svantic_http: Svantic_http_client = {
    async get_token({ api_url, client_id, client_secret, agent_type }) {
        return MeshAuth.get_token(api_base(api_url), {
            client_id,
            client_secret,
            agent_type,
        });
    },

    async register(input) {
        const client = new RegistrationClient({
            svantic_url: input.api_url,
            auth_headers: () => ({ Authorization: `Bearer ${input.token}` }),
        });

        const reg = await client.register({
            agent_type: input.agent_type,
            instance_id: input.instance_id,
            deployment_mode: input.deployment_mode,
            ...(input.public_url ? { url: input.public_url } : {}),
            ...(input.agent_card ? { agent_card: input.agent_card } : {}),
            ...(input.dispatch_auth ? { dispatch_auth: input.dispatch_auth } : {}),
        });

        return {
            ok: true as const,
            tenant_id: reg.tenant_id,
            instance_id: reg.instance_id,
            deployment_mode: reg.deployment_mode === 'connected' || reg.deployment_mode === 'hosted'
                ? reg.deployment_mode
                : input.deployment_mode,
            connect_url: reg.connect_url,
            svantic_jwks_url: reg.svantic_jwks_url,
            dispatch_auth: reg.dispatch_auth,
        };
    },

    async deregister(input) {
        // RegistrationClient has no public deregister yet — MeshConnector
        // owns that path. Keep a thin call so Hub disconnect stays complete.
        const res = await fetch(`${api_base(input.api_url)}/agents/deregister`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${input.token}`,
            },
            body: JSON.stringify({
                agent_type: input.agent_type,
                instance_id: input.instance_id,
            }),
        });
        if (res.ok || res.status === 404) return;
        const data = await read_json(res);
        throw new Error(
            `Svantic deregister failed (${res.status}): ${
                typeof data.error === 'string' ? data.error : JSON.stringify(data)
            }`,
        );
    },
};

export function svantic_instance_id(realm_id: string): string {
    return `cliq-realm-${realm_id}`;
}

/** Pull the DataPart that may carry `svantic_auth` from an A2A /send body. */
function extract_dispatch_data(body: unknown): Record<string, unknown> | null {
    if (!body || typeof body !== 'object') return null;
    const root = body as Record<string, unknown>;

    if (root.svantic_auth !== undefined) {
        return root;
    }

    const params = root.params;
    if (!params || typeof params !== 'object') return null;
    const message = (params as Record<string, unknown>).message;
    if (!message || typeof message !== 'object') return null;
    const parts = (message as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) return null;

    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const data = (part as Record<string, unknown>).data;
        if (data && typeof data === 'object') {
            return data as Record<string, unknown>;
        }
    }
    return null;
}

/**
 * Normalize Hub-inbound shapes into the SDK verifier envelope:
 * `{ scheme: 'svantic_jwt', token, expires_at }`.
 */
function to_verifier_data(
    body: unknown,
    header_auth: string | undefined,
): Record<string, unknown> | null {
    const data = extract_dispatch_data(body);
    let auth = data?.svantic_auth;

    if (!auth && typeof header_auth === 'string' && header_auth.startsWith('Bearer ')) {
        const token = header_auth.slice(7).trim();
        if (token && !token.startsWith('cliq_a2a_')) {
            auth = token;
        }
    }
    if (!auth) return null;

    if (typeof auth === 'string') {
        return {
            ...(data ?? {}),
            svantic_auth: {
                scheme: 'svantic_jwt',
                token: auth,
                expires_at: Math.floor(Date.now() / 1000) + 120,
            },
        };
    }

    if (typeof auth === 'object') {
        const obj = auth as Record<string, unknown>;
        const token = typeof obj.token === 'string'
            ? obj.token
            : (typeof obj.jwt === 'string' ? obj.jwt : '');
        if (!token) return null;
        return {
            ...(data ?? {}),
            svantic_auth: {
                scheme: typeof obj.scheme === 'string' ? obj.scheme : 'svantic_jwt',
                token,
                expires_at: typeof obj.expires_at === 'number'
                    ? obj.expires_at
                    : Math.floor(Date.now() / 1000) + 120,
            },
        };
    }

    return null;
}

export async function verify_svantic_dispatch_jwt(input: {
    req: Inbound_dispatch;
    signing_secret: string;
    instance_id: string;
}): Promise<boolean> {
    const header_auth = input.req.headers.authorization;
    const data = to_verifier_data(
        input.req.body,
        typeof header_auth === 'string' ? header_auth : undefined,
    );
    if (!data) return false;

    try {
        verify_dispatch_auth(data, {
            instance_id: input.instance_id,
            signing_secret: input.signing_secret,
        });
        return true;
    } catch {
        return false;
    }
}

/** Constant-time shared_secret compare helper (future scheme). */
export function verify_shared_secret(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export function hmac_preview(secret: string): string {
    return createHmac('sha256', secret).update('cliq-svantic').digest('hex').slice(0, 12);
}
