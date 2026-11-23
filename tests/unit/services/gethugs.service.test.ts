/**
 * PLAN-gethugs-integration.md step 1: getHugs' settings (both or neither; an http(s) origin; a service token) and the
 * partner client — the partner's own calls name no org, calls inside an org name it and the workspace; the token goes
 * only to getHugs, as the bearer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/models/org.model.js', () => ({ Org: { findByPk: vi.fn() } }));

import { gethugs_config } from '../../../src/config/env.js';
import { Org } from '../../../src/models/org.model.js';
import { gethugs_partner, hugs_provider_of } from '../../../src/services/gethugs.service.js';

const TOKEN = 'hugs_svc_' + 'x'.repeat(43);
const set = (url?: string, token?: string) => {
    if (url === undefined) delete process.env.GETHUGS_URL;
    else process.env.GETHUGS_URL = url;
    if (token === undefined) delete process.env.GETHUGS_PARTNER_TOKEN;
    else process.env.GETHUGS_PARTNER_TOKEN = token;
};

afterEach(() => {
    set();
    delete process.env.GETHUGS_APP_URL;
});

describe('gethugs_config', () => {
    it('neither set: getHugs is off', () => {
        set();
        expect(gethugs_config()).toBeNull();
    });

    it('both set: the origin (no trailing slash) and the token', () => {
        set('https://api.gethugs.ai/', TOKEN);
        expect(gethugs_config()).toEqual({ url: 'https://api.gethugs.ai', token: TOKEN, app_url: 'https://api.gethugs.ai' });
        set('http://localhost:8080', TOKEN);
        expect(gethugs_config()!.url).toBe('http://localhost:8080');
    });

    it('refuses one without the other, a URL that is not an origin, and a token that is not a service token', () => {
        set('https://api.gethugs.ai', undefined);
        expect(() => gethugs_config()).toThrow(/both/);
        set(undefined, TOKEN);
        expect(() => gethugs_config()).toThrow(/both/);
        for (const url of ['api.gethugs.ai', 'ftp://api.gethugs.ai', 'https://api.gethugs.ai/v1']) {
            set(url, TOKEN);
            expect(() => gethugs_config(), url).toThrow(/origin/);
        }
        set('https://api.gethugs.ai', 'hugs_k_abc');
        expect(() => gethugs_config()).toThrow(/service token/);
    });

    it('the web app: GETHUGS_APP_URL when set (an origin), else the API origin', () => {
        set('http://localhost:8080', TOKEN);
        expect(gethugs_config()!.app_url).toBe('http://localhost:8080');
        process.env.GETHUGS_APP_URL = 'http://localhost:8082/';
        expect(gethugs_config()!.app_url).toBe('http://localhost:8082');
        process.env.GETHUGS_APP_URL = 'https://app.gethugs.ai/hugs';
        expect(() => gethugs_config()).toThrow(/GETHUGS_APP_URL/);
    });
});

describe('the partner client', () => {
    type Sent = { url: string; auth: string | null; body: Record<string, unknown> };
    const fake = () => {
        const sent: Sent[] = [];
        const fetch_impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            sent.push({ url: String(input), auth: headers.get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) });
            return new Response(JSON.stringify({ data: { items: [], next_cursor: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        return { sent, fetch_impl };
    };

    it('is null when getHugs is off', () => {
        set();
        expect(gethugs_partner()).toBeNull();
    });

    it('the partner’s own calls name no org; calls in an org name it and the workspace; the token is the bearer', async () => {
        set('http://localhost:8080', TOKEN);
        const { sent, fetch_impl } = fake();
        const partner = gethugs_partner(fetch_impl)!;
        await partner.site.call('site/get_orgs', { limit: 1 });
        await partner.in_workspace('org_1', 'ws_1', 'payments · run 7').hugs.get({ ref_id: 'cliqhub:run:7' });
        expect(sent.map((s) => s.url)).toEqual(['http://localhost:8080/v1/site/get_orgs', 'http://localhost:8080/v1/hugs/get']);
        expect(sent[0]!.body).toEqual({ limit: 1 });
        expect(sent[1]!.body).toEqual({ workspace_id: 'ws_1', org_id: 'org_1', ref_id: 'cliqhub:run:7' });
        expect(sent.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
        expect(JSON.stringify(partner.site)).not.toContain(TOKEN);
    });
});

describe('hugs_provider_of', () => {
    it('gethugs only when the org says so; anything else, or no org, is cliqhub', async () => {
        const find = vi.mocked(Org.findByPk);
        find.mockResolvedValueOnce({ hugs_provider: 'gethugs' } as never);
        expect(await hugs_provider_of('o1')).toBe('gethugs');
        find.mockResolvedValueOnce({ hugs_provider: 'cliqhub' } as never);
        expect(await hugs_provider_of('o2')).toBe('cliqhub');
        find.mockResolvedValueOnce(null);
        expect(await hugs_provider_of('o3')).toBe('cliqhub');
    });
});
