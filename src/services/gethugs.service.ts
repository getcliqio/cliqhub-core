/**
 * getHugs, where Hugs live for orgs switched to it (PLAN-gethugs-integration.md, step 1).
 *
 * Core is the only thing in cliq that talks to getHugs (decision 1), always with cliqhub's partner service token
 * (decision 3): the partner's own calls (`site/*` — provisioning orgs — and the event feed) and calls inside one org and
 * workspace (asking). Which orgs use it is the per-org switch `orgs.hugs_provider` (`cliqhub` by default).
 */

import { HugsClient } from '@gethugs/client';

import { gethugs_config, type GethugsConfig } from '../config/env.js';
import { Org } from '../models/org.model.js';

/** Where an org's Hugs live: cliqhub's own (today) or getHugs. */
export type HugsProvider = 'cliqhub' | 'gethugs';
export const HUGS_PROVIDERS: readonly HugsProvider[] = ['cliqhub', 'gethugs'];

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

/** cliqhub's partner at getHugs, or null when getHugs isn't configured (`GETHUGS_URL`, `GETHUGS_PARTNER_TOKEN`). */
export function gethugs_partner(fetch_impl?: typeof fetch): GethugsPartner | null {
    const config = gethugs_config();
    return config ? new GethugsPartner(config, fetch_impl) : null;
}

/** Where an org's Hugs live. An unknown org is `cliqhub` (nothing is switched for it). */
export async function hugs_provider_of(org_id: string): Promise<HugsProvider> {
    const org = await Org.findByPk(org_id, { attributes: ['hugs_provider'], raw: true });
    return org?.hugs_provider === 'gethugs' ? 'gethugs' : 'cliqhub';
}
