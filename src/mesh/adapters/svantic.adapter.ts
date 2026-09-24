import { randomBytes } from 'node:crypto';
import type {
    Mesh_adapter,
    Mesh_health,
    Realm_mesh_context,
    Inbound_dispatch,
} from '../types.js';
import {
    svantic_http,
    svantic_instance_id,
    verify_svantic_dispatch_jwt,
} from './svantic_client.js';
import { svantic_connected_pool } from './svantic_connected_pool.js';

function str(settings: Record<string, unknown>, key: string, fallback = ''): string {
    const value = settings[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    return fallback;
}

/**
 * Svantic mesh adapter — hosted (HTTP+JWT) and connected (outbound WS).
 */
export const svantic_mesh_adapter: Mesh_adapter = {
    id: 'svantic',
    label: 'Svantic',
    settings_schema: [
        {
            key: 'api_url',
            label: 'Svantic API URL',
            type: 'url',
            required: true,
            default: 'https://api.svantic.com',
            description: 'Control plane base URL',
        },
        {
            key: 'client_id',
            label: 'Client ID',
            type: 'string',
            required: true,
        },
        {
            key: 'client_secret',
            label: 'Client secret',
            type: 'secret',
            required: true,
        },
        {
            key: 'mode',
            label: 'Deployment mode',
            type: 'enum',
            required: true,
            default: 'hosted',
            options: [
                { value: 'hosted', label: 'Hosted (public URL + dispatch JWT)' },
                { value: 'connected', label: 'Connected (outbound WebSocket)' },
            ],
        },
        {
            key: 'dispatch_secret',
            label: 'Dispatch signing secret',
            type: 'secret',
            required: false,
            description: 'Paste the same value into Svantic Dispatch Auth (hosted mode)',
        },
        {
            key: 'agent_type',
            label: 'Agent type',
            type: 'string',
            required: false,
            default: 'cliq-realm',
        },
    ],

    async connect(ctx: Realm_mesh_context): Promise<Mesh_health> {
        const api_url = str(ctx.settings, 'api_url', 'https://api.svantic.com');
        const client_id = str(ctx.settings, 'client_id');
        const client_secret = str(ctx.settings, 'client_secret');
        const mode = str(ctx.settings, 'mode', 'hosted') as 'hosted' | 'connected';
        const agent_type = str(ctx.settings, 'agent_type', 'cliq-realm');
        const instance_id = svantic_instance_id(ctx.realm_id);

        if (!client_id || !client_secret) {
            return {
                status: 'error',
                message: 'client_id and client_secret are required',
            };
        }

        if (mode === 'connected') {
            try {
                const entry = await svantic_connected_pool.start({
                    realm_id: ctx.realm_id,
                    api_url,
                    client_id,
                    client_secret,
                    agent_type,
                });
                return {
                    status: 'connected',
                    message: 'Connected to Svantic over WebSocket',
                    details: {
                        instance_id: entry.instance_id,
                        mode,
                        connect_url: entry.connect_url,
                        agent_type,
                        ws_state: entry.state,
                    },
                };
            } catch (err) {
                return {
                    status: 'error',
                    message: err instanceof Error ? err.message : String(err),
                    details: { instance_id, mode },
                };
            }
        }

        let dispatch_secret = str(ctx.settings, 'dispatch_secret');
        const settings_patch: Record<string, unknown> = {};
        let generated_secret: string | undefined;
        if (!dispatch_secret) {
            generated_secret = randomBytes(36).toString('base64url');
            dispatch_secret = generated_secret;
            settings_patch.dispatch_secret = generated_secret;
        }

        try {
            const token = await svantic_http.get_token({ api_url, client_id, client_secret, agent_type });
            await svantic_http.register({
                api_url,
                token,
                agent_type,
                instance_id,
                deployment_mode: 'hosted',
                public_url: ctx.public_a2a_url,
                dispatch_auth: { scheme: 'svantic_jwt', required: true },
            });
        } catch (err) {
            return {
                status: 'error',
                message: err instanceof Error ? err.message : String(err),
                details: { instance_id, mode },
            };
        }

        return {
            status: 'connected',
            message: generated_secret
                ? 'Registered. Copy dispatch_secret into Svantic Dispatch Auth for this instance.'
                : 'Registered with Svantic (hosted).',
            details: {
                instance_id,
                mode,
                public_url: ctx.public_a2a_url,
                agent_type,
                ...(Object.keys(settings_patch).length ? { settings_patch } : {}),
                ...(generated_secret ? { dispatch_secret_once: generated_secret } : {}),
            },
        };
    },

    async disconnect(ctx: Realm_mesh_context): Promise<Mesh_health> {
        const api_url = str(ctx.settings, 'api_url', 'https://api.svantic.com');
        const client_id = str(ctx.settings, 'client_id');
        const client_secret = str(ctx.settings, 'client_secret');
        const agent_type = str(ctx.settings, 'agent_type', 'cliq-realm');
        const instance_id = svantic_instance_id(ctx.realm_id);
        const mode = str(ctx.settings, 'mode', 'hosted');

        await svantic_connected_pool.stop(ctx.realm_id);

        if (!client_id || !client_secret) {
            return { status: 'disconnected', message: 'Disconnected (no credentials)' };
        }

        try {
            const token = await svantic_http.get_token({ api_url, client_id, client_secret, agent_type });
            await svantic_http.deregister({
                api_url,
                token,
                agent_type,
                instance_id,
            });
        } catch (err) {
            return {
                status: 'error',
                message: err instanceof Error ? err.message : String(err),
                details: { instance_id, mode },
            };
        }

        return {
            status: 'disconnected',
            message: 'Deregistered from Svantic',
            details: { instance_id, mode },
        };
    },

    async re_register(ctx: Realm_mesh_context): Promise<Mesh_health> {
        return svantic_mesh_adapter.connect(ctx);
    },

    async health(ctx: Realm_mesh_context): Promise<Mesh_health> {
        const mode = str(ctx.settings, 'mode', 'hosted');
        const instance_id = svantic_instance_id(ctx.realm_id);
        const has_creds = Boolean(str(ctx.settings, 'client_id') && str(ctx.settings, 'client_secret'));
        if (!has_creds) {
            return { status: 'disconnected', message: 'Missing credentials', details: { instance_id } };
        }

        if (mode === 'connected') {
            const entry = svantic_connected_pool.get(ctx.realm_id);
            if (entry?.state === 'ready') {
                return {
                    status: 'connected',
                    message: 'WebSocket ready',
                    details: { instance_id, mode, ws_state: entry.state, connect_url: entry.connect_url },
                };
            }
            return {
                status: 'disconnected',
                message: entry
                    ? `WebSocket ${entry.state}`
                    : 'No active WebSocket — use Connect',
                details: { instance_id, mode, ws_state: entry?.state ?? 'absent' },
            };
        }

        return {
            status: 'disconnected',
            message: 'Credentials present — use Connect to register',
            details: { instance_id, mode },
        };
    },

    async verify_inbound(
        req: Inbound_dispatch,
        settings: Record<string, unknown>,
        realm_id: string,
    ): Promise<boolean> {
        const signing_secret = str(settings, 'dispatch_secret');
        if (!signing_secret) return false;
        try {
            return await verify_svantic_dispatch_jwt({
                req,
                signing_secret,
                instance_id: svantic_instance_id(realm_id),
            });
        } catch {
            return false;
        }
    },
};
