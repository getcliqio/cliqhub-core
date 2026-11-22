/**
 * PLAN-gethugs-integration.md step 1, against a real getHugs (the local stack): cliqhub's partner token reaches the
 * site API (its orgs) and the partner event feed. Reads only GETHUGS_URL and GETHUGS_PARTNER_TOKEN from `.env` — never
 * the rest of it — and skips when they aren't there.
 */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';

import { gethugs_partner } from '../../src/services/gethugs.service.js';

function gethugs_from_dotenv(): boolean {
    let text = '';
    try {
        text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    } catch {
        return false;
    }
    const env = parseEnv(text);
    if (!env.GETHUGS_URL || !env.GETHUGS_PARTNER_TOKEN) return false;
    process.env.GETHUGS_URL = env.GETHUGS_URL;
    process.env.GETHUGS_PARTNER_TOKEN = env.GETHUGS_PARTNER_TOKEN;
    return true;
}

const configured = gethugs_from_dotenv();

describe.skipIf(!configured)('getHugs, live (local stack)', () => {
    it('the partner token lists its orgs and reads the event feed', async () => {
        const partner = gethugs_partner()!;
        const orgs = await partner.site.call<{ items: Array<{ id: string; partner: { name: string } | null }> }>('site/get_orgs', { limit: 50 });
        expect(Array.isArray(orgs.items)).toBe(true);
        // A partner's token reaches only its partner's orgs.
        const partners = new Set(orgs.items.map((o) => o.partner?.name ?? null));
        expect(partners.size).toBeLessThanOrEqual(1);
        expect(partners.has(null)).toBe(false);

        const start = await partner.site.events.get();
        expect(start).toMatchObject({ events: [], has_more: false });
        expect(typeof start.cursor).toBe('string');
    });
});
