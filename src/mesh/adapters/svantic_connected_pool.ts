/**
 * Per-realm Svantic connected-mode WS pool.
 *
 * One outbound session per realm on this Hub process. Multi-replica
 * single-writer coordination is out of scope for v1 (sticky realm or
 * single backend instance).
 */

import { A2aInvokeService } from '../../services/a2a_invoke.service.js';
import { AgentCardService } from '../../services/agent_card.service.js';
import { Realm } from '../../models/index.js';
import {
    Svantic_connected_session,
    type Dispatch_handler,
    type Session_state,
    type Svantic_socket_factory,
} from './svantic_connected_session.js';
import { svantic_http, svantic_instance_id } from './svantic_client.js';

export interface Start_connected_input {
    realm_id: string;
    api_url: string;
    client_id: string;
    client_secret: string;
    agent_type: string;
    /** Injected for tests. */
    socket_factory?: Svantic_socket_factory;
    token?: string;
    connect_url?: string;
    agent_card?: Record<string, unknown>;
    on_dispatch?: Dispatch_handler;
    auto_reconnect?: boolean;
}

type Pool_entry = {
    session: Svantic_connected_session;
    token: string;
    connect_url: string;
    agent_type: string;
    instance_id: string;
    state: Session_state;
};

class Svantic_connected_pool {
    private readonly _by_realm = new Map<string, Pool_entry>();

    get(realm_id: string): Pool_entry | undefined {
        return this._by_realm.get(realm_id);
    }

    is_ready(realm_id: string): boolean {
        return this._by_realm.get(realm_id)?.state === 'ready';
    }

    async start(input: Start_connected_input): Promise<Pool_entry> {
        await this.stop(input.realm_id);

        const instance_id = svantic_instance_id(input.realm_id);
        const token = input.token
            ?? await svantic_http.get_token({
                api_url: input.api_url,
                client_id: input.client_id,
                client_secret: input.client_secret,
                agent_type: input.agent_type,
            });

        const agent_card = input.agent_card ?? await this._load_agent_card(input.realm_id);

        const reg = await svantic_http.register({
            api_url: input.api_url,
            token,
            agent_type: input.agent_type,
            instance_id,
            deployment_mode: 'connected',
            agent_card,
        });

        const connect_url = input.connect_url
            ?? (typeof reg.connect_url === 'string' ? reg.connect_url : null);
        if (!connect_url) {
            throw new Error(
                'Svantic register returned connected mode without connect_url; mesh WS endpoint may not be provisioned',
            );
        }

        const on_dispatch: Dispatch_handler = input.on_dispatch
            ?? (async ({ skill_id, args, session_id }) => {
                const task = await A2aInvokeService.invoke_skill({
                    realm_id: input.realm_id,
                    skill_id,
                    inputs: args,
                    context_id: session_id,
                });
                return {
                    task_id: task.id,
                    state: task.status.state,
                    skill_id: task.metadata.skill_id,
                    context_id: task.contextId,
                    message: task.status.message,
                };
            });

        const session = new Svantic_connected_session({
            realm_id: input.realm_id,
            connect_url,
            token_provider: () => token,
            instance_id,
            agent_type: input.agent_type,
            agent_card,
            on_dispatch,
            ...(input.socket_factory ? { socket_factory: input.socket_factory } : {}),
            auto_reconnect: input.auto_reconnect ?? true,
            on_state: (state) => {
                const entry = this._by_realm.get(input.realm_id);
                if (entry) entry.state = state;
            },
        });

        const entry: Pool_entry = {
            session,
            token,
            connect_url,
            agent_type: input.agent_type,
            instance_id,
            state: session.state,
        };
        this._by_realm.set(input.realm_id, entry);

        try {
            await session.connect();
            entry.state = session.state;
            return entry;
        } catch (err) {
            this._by_realm.delete(input.realm_id);
            throw err;
        }
    }

    async stop(realm_id: string): Promise<void> {
        const entry = this._by_realm.get(realm_id);
        if (!entry) return;
        this._by_realm.delete(realm_id);
        await entry.session.close();
    }

    /** Test helper — drop all sessions without deregister. */
    async reset_for_tests(): Promise<void> {
        const ids = [...this._by_realm.keys()];
        for (const id of ids) {
            await this.stop(id);
        }
    }

    private async _load_agent_card(realm_id: string): Promise<Record<string, unknown>> {
        try {
            const realm = await Realm.findByPk(realm_id);
            if (!realm || realm.deleted) return {};
            const card = await AgentCardService.build_for_realm(realm);
            return card as unknown as Record<string, unknown>;
        } catch {
            return {};
        }
    }
}

export const svantic_connected_pool = new Svantic_connected_pool();
