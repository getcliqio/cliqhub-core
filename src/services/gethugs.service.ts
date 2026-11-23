/**
 * getHugs, where every org's Hugs live (PLAN-gethugs-integration.md; step 8: every org, no way back).
 *
 * Core is the only thing in cliq that talks to getHugs (decision 1), always with cliqhub's partner service token
 * (decision 3): the partner's own calls (`site/*` — provisioning orgs — and the event feed) and calls inside one org and
 * workspace (asking).
 */

import { HugsClient } from '@gethugs/client';

import { gethugs_config, type GethugsConfig } from '../config/env.js';

/**
 * `HugsClient` needs an org and a workspace, but the partner's own calls (`site/*`, `events/*`) send neither — the
 * client sends `org_id` / `workspace_id` only on calls inside an org. These placeholders are never sent.
 */
const PARTNER_SCOPE = 'partner';

/** A User-Agent naming the caller, never anything about the org or person. */
const USER_AGENT = 'cliqhub-core';

/** cliqhub's partner credential at getHugs. */
export class GethugsPartner {
    /** The partner's own calls: provisioning (`site/*`) and the event feed (`events/*`). */
    readonly site: HugsClient;

    constructor(
        private readonly config: GethugsConfig,
        private readonly fetch_impl?: typeof fetch,
    ) {
        this.site = this.client(PARTNER_SCOPE, PARTNER_SCOPE);
    }

    /** A client asking inside one getHugs org and workspace, as the partner (who asked shows as `requester`). */
    in_workspace(org_id: string, workspace_id: string, requester?: string): HugsClient {
        return this.client(org_id, workspace_id, requester);
    }

    private client(org: string, workspace: string, requester?: string): HugsClient {
        return new HugsClient({
            base_url: this.config.url,
            org,
            workspace,
            key: this.config.token,
            user_agent: USER_AGENT,
            ...(requester ? { requester } : {}),
            ...(this.fetch_impl ? { fetch: this.fetch_impl } : {}),
        });
    }
}

/** cliqhub's partner at getHugs. @throws Error when the `GETHUGS_*` settings are missing ({@link gethugs_config}). */
export function gethugs_partner(fetch_impl?: typeof fetch): GethugsPartner {
    return new GethugsPartner(gethugs_config(), fetch_impl);
}
