/**
 * Agent settings readiness follows the daemon's rule (cliq/daemon/src/lib/required_settings.ts):
 * a required setting counts only when its `when` applies (a key missing from the values falls back
 * to its manifest default), and it's satisfied when set or when the manifest gives it a default.
 * Uses the git agent's settings block (cliq-agents/manifests/git.json): `provider` defaults to
 * github, `github.token` applies for github, the `bitbucket.*` keys only for bitbucket.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { AgentService } from '../../src/services/agent.service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { AgentCatalog } from '../../src/models/index.js';
import { missing_required_settings } from '../../src/lib/agent_settings.js';

const has_postgres = await postgres_reachable();
const ORG = '00000000-0000-4000-a000-0000000000a7';

/** The git agent's settings block, as published. */
const GIT_SETTINGS = {
    required: [
        { key: 'provider', description: 'Git hosting provider: github or bitbucket', default: 'github' },
        { key: 'github.token', description: 'GitHub personal access token (repo scope)', when: { provider: 'github' } },
        { key: 'bitbucket.email', description: 'Bitbucket account email', when: { provider: 'bitbucket' } },
        { key: 'bitbucket.api_token', description: 'Bitbucket API token / app password', when: { provider: 'bitbucket' } },
        { key: 'bitbucket.workspace', description: 'Bitbucket workspace slug', when: { provider: 'bitbucket' } },
    ],
    optional: [
        { key: 'github.base_branch', default: 'main', when: { provider: 'github' } },
        { key: 'bitbucket.base_url', default: 'https://api.bitbucket.org/2.0', when: { provider: 'bitbucket' } },
    ],
};

describe('missing_required_settings (pure)', () => {
    const all = [...GIT_SETTINGS.required, ...GIT_SETTINGS.optional];
    it('nothing saved: only github.token (provider defaults to github; bitbucket keys don’t apply)', () => {
        expect(missing_required_settings(GIT_SETTINGS.required, all, {})).toEqual({ applicable: ['provider', 'github.token'], missing: ['github.token'] });
    });
    it('a GitHub token saved: nothing missing', () => {
        expect(missing_required_settings(GIT_SETTINGS.required, all, { 'github.token': 'ghp_x' }).missing).toEqual([]);
    });
    it('provider bitbucket: its three keys, not the GitHub token', () => {
        expect(missing_required_settings(GIT_SETTINGS.required, all, { provider: 'bitbucket', 'github.token': 'ghp_x' }).missing)
            .toEqual(['bitbucket.email', 'bitbucket.api_token', 'bitbucket.workspace']);
    });
    it('a JSON-quoted stored value counts like plain text', () => {
        expect(missing_required_settings(GIT_SETTINGS.required, all, { provider: '"bitbucket"' }).missing).toEqual(['bitbucket.email', 'bitbucket.api_token', 'bitbucket.workspace']);
    });
    it('a `when` on a key with no value and no default does not apply; bare string entries always do', () => {
        const req = [{ key: 'a.token', when: { mode: 'a' } }, 'plain_key'] as never;
        expect(missing_required_settings(req, req, {})).toEqual({ applicable: ['plain_key'], missing: ['plain_key'] });
    });
});

describe.skipIf(!has_postgres)('AgentService settings readiness (git agent)', () => {
    const service = new AgentService();
    let id = '';
    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        const name = `git-when-${Date.now()}`;
        await service.register(ORG, { name, manifest: { name, entry: './agent.js', agent_type: 'connector', settings: GIT_SETTINGS }, description: 'git' });
        id = (await AgentCatalog.findOne({ where: { name } }))!.id;
    });
    afterAll(async () => { await AgentCatalog.destroy({ where: { id } }); await close_test_control_plane_store(); });

    it('GitHub token saved → ready; counts only what applies; no bitbucket keys missing', async () => {
        await service.update_settings(ORG, id, { values: { 'github.token': 'ghp_123' } });
        const s = await service.get_settings(ORG, id);
        expect(s.all_required_configured).toBe(true);
        expect(s.missing_required).toEqual([]);
        expect([s.required_total, s.required_configured]).toEqual([2, 2]);
        const row = (await service.list_settings_summary(ORG)).find((x) => x.id === id)!;
        expect(row.all_required_configured).toBe(true);
        expect(row.missing_required).toEqual([]);
    });

    it('switching to bitbucket: the three bitbucket keys are missing; switching back is ready again', async () => {
        await service.update_settings(ORG, id, { values: { provider: 'bitbucket' } });
        const s = await service.get_settings(ORG, id);
        expect(s.all_required_configured).toBe(false);
        expect(s.missing_required).toEqual(['bitbucket.email', 'bitbucket.api_token', 'bitbucket.workspace']);
        await service.update_settings(ORG, id, { clear: ['provider'] });
        expect((await service.get_settings(ORG, id)).all_required_configured).toBe(true);
    });
});
