/**
 * getHugs' settings — all required (PLAN-gethugs-step8-cutover.md decision 9); http(s) origins; a service token — and
 * the partner client: the partner's own calls name no org, calls inside an org name it and the workspace; the token
 * goes only to getHugs, as the bearer.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { gethugs_config } from '../../../src/config/env.js';
import { gethugs_partner } from '../../../src/services/gethugs.service.js';

const TOKEN = 'hugs_svc_' + 'x'.repeat(43);
const saved = { url: process.env.GETHUGS_URL, token: process.env.GETHUGS_PARTNER_TOKEN, app: process.env.GETHUGS_APP_URL };
const put = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
};
const set = (url?: string, token?: string, app?: string) => {
    put('GETHUGS_URL', url);
    put('GETHUGS_PARTNER_TOKEN', token);
    put('GETHUGS_APP_URL', app);
};

afterEach(() => set(saved.url, saved.token, saved.app));

describe('gethugs_config', () => {
    it('all three set: the origins (no trailing slash) and the token', () => {
        set('https://api.gethugs.ai/', TOKEN, 'https://app.gethugs.ai/');
        expect(gethugs_config()).toEqual({ url: 'https://api.gethugs.ai', token: TOKEN, app_url: 'https://app.gethugs.ai' });
        set('http://localhost:8080', TOKEN, 'http://localhost:8082');
        expect(gethugs_config()).toMatchObject({ url: 'http://localhost:8080', app_url: 'http://localhost:8082' });
    });

    it('required: any one missing is refused', () => {
        for (const [url, token, app] of [[undefined, undefined, undefined], ['https://a.test', TOKEN, undefined], ['https://a.test', undefined, 'https://b.test'], [undefined, TOKEN, 'https://b.test']]) {
            set(url, token, app);
            expect(() => gethugs_config()).toThrow(/Missing required env var/);
        }
    });

    it('refuses a URL that is not an origin, and a token that is not a service token', () => {
        for (const url of ['api.gethugs.ai', 'ftp://api.gethugs.ai', 'https://api.gethugs.ai/v1']) {
            set(url, TOKEN, 'https://app.gethugs.ai');
            expect(() => gethugs_config(), url).toThrow(/GETHUGS_URL must be/);
        }
        set('https://api.gethugs.ai', TOKEN, 'https://app.gethugs.ai/hugs');
        expect(() => gethugs_config()).toThrow(/GETHUGS_APP_URL must be/);
        set('https://api.gethugs.ai', 'hugs_k_abc', 'https://app.gethugs.ai');
        expect(() => gethugs_config()).toThrow(/service token/);
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

    it('throws without the settings', () => {
        set();
        expect(() => gethugs_partner()).toThrow(/Missing required env var/);
    });

    it('the partner’s own calls name no org; calls in an org name it and the workspace; the token is the bearer', async () => {
        set('http://localhost:8080', TOKEN, 'http://localhost:8082');
        const { sent, fetch_impl } = fake();
        const partner = gethugs_partner(fetch_impl);
        await partner.site.call('site/get_orgs', { limit: 1 });
        await partner.in_workspace('org_1', 'ws_1', 'payments · run 7').hugs.get({ ref_id: 'cliqhub:run:7' });
        expect(sent.map((s) => s.url)).toEqual(['http://localhost:8080/v1/site/get_orgs', 'http://localhost:8080/v1/hugs/get']);
        expect(sent[0]!.body).toEqual({ limit: 1 });
        expect(sent[1]!.body).toEqual({ workspace_id: 'ws_1', org_id: 'org_1', ref_id: 'cliqhub:run:7' });
        expect(sent.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
        expect(JSON.stringify(partner.site)).not.toContain(TOKEN);
    });
});
