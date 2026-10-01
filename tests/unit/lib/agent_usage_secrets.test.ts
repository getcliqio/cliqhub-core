import { describe, it, expect } from 'vitest';
import { build_agent_usage } from '../../../src/lib/agent_workflow.js';
import { is_secret_key, mask_secret, mask_settings } from '../../../src/lib/agent_secrets.js';
import { resolve_agent_settings } from '../../../src/lib/agent_settings.js';
import { SemVer } from '../../../src/lib/semver.js';

const wf = (...agents: string[]) => JSON.stringify({ phases: agents.map((a, i) => ({ name: `p${i}`, type: 'standard', agent: a })) });

describe('build_agent_usage', () => {
    it('uses the latest version, strips @pins, maps realms from team_list', () => {
        const teams = [{ id: 't1', scope: 'acme', name: 'triage' }, { id: 't2', scope: 'acme', name: 'docs' }, { id: 't3', scope: 'acme', name: 'draft-only' }];
        const versions = [
            { team_id: 't1', version: '1.0.0', workflow_json: wf('cursor') },
            { team_id: 't1', version: '1.2.0', workflow_json: wf('jira', 'matcher@0.3.1') },
            { team_id: 't2', version: '0.1.0', workflow_json: JSON.stringify({ phases: [{ name: 'a', agent: 'jira' }, { name: 'sub', type: 'team', agent: 'ignored' }], support: [{ name: 's', agent: 'git' }] }) },
        ];
        const realms = [{ id: 'r1', team_list: [{ scope: 'acme', slug: 'triage' }] }, { id: 'r2', team_list: [{ scope: 'acme', slug: 'triage' }, { scope: 'acme', slug: 'docs' }] }];
        const u = build_agent_usage(teams, versions, realms, (v) => SemVer.max(v));
        expect(u.get('cursor')).toBeUndefined(); // only in the old version
        expect(u.get('matcher')).toEqual([{ scope: 'acme', name: 'triage', version: '1.2.0', realm_ids: ['r1', 'r2'] }]);
        expect(u.get('jira')!.map((e) => e.name)).toEqual(['docs', 'triage']);
        expect(u.get('git')).toEqual([{ scope: 'acme', name: 'docs', version: '0.1.0', realm_ids: ['r2'] }]);
        expect(u.get('ignored')).toBeUndefined(); // sub-team phases don't count
    });
});

describe('secrets', () => {
    it('spots credential keys by flag or by name', () => {
        for (const k of ['api_key', 'api_token', 'github.token', 'bitbucket.api_token', 'client_secret', 'password', 'bank_api_key']) expect(is_secret_key(k)).toBe(true);
        for (const k of ['base_url', 'email', 'model', 'provider', 'github.base_branch', 'max_turns', 'tolerance']) expect(is_secret_key(k)).toBe(false);
        expect(is_secret_key('webhook', { secret: true })).toBe(true);
        expect(is_secret_key('api_key', { secret: false })).toBe(false);
    });
    it('masks with the last 4 only for long values', () => {
        expect(mask_secret('sk-ant-1234567890abcd')).toBe('••••abcd');
        expect(mask_secret('short')).toBe('••••');
        expect(mask_secret('')).toBe('');
        const m = mask_settings({ settings: { required: [{ key: 'api_key' }], optional: [] }, values: { api_key: 'sk-ant-1234567890abcd', model: 'opus' } });
        expect(m.values).toEqual({ api_key: '••••abcd', model: 'opus' });
    });
    it('setting definitions carry secret: true', () => {
        const s = resolve_agent_settings({ settings: { required: [{ key: 'base_url' }, { key: 'api_token' }, 'api_key'], optional: [{ key: 'webhook', secret: true }] } });
        expect(s.required).toEqual([{ key: 'base_url' }, { key: 'api_token', secret: true }, { key: 'api_key', secret: true }]);
        expect(s.optional[0]).toMatchObject({ key: 'webhook', secret: true });
    });
});

describe('find_org_agent_usage (queries)', () => {
    it('scopes to the org: its scopes + teams listed in its live realms', async () => {
        const { find_org_agent_usage } = await import('../../../src/lib/agent_workflow.js');
        const calls: Array<{ sql: string; rep: Record<string, unknown> }> = [];
        const sq = { query: async (sql: string, o: { replacements: Record<string, unknown> }) => {
            calls.push({ sql, rep: o.replacements });
            if (sql.includes('FROM cliq.realms')) return [{ id: 'r1', team_list: [{ scope: 'other', slug: 'shared' }] }];
            if (sql.includes('FROM cliq.scopes')) return [{ slug: 'acme' }];
            if (sql.includes('FROM cliq.teams')) return [{ id: 't1', scope: 'acme', name: 'triage' }, { id: 't2', scope: 'other', name: 'shared' }];
            return [{ team_id: 't1', version: '1.0.0', workflow_json: wf('jira') }, { team_id: 't2', version: '2.0.0', workflow_json: wf('jira', 'git') }];
        } };
        const u = await find_org_agent_usage('org-1', sq as never);
        expect(calls[0].sql).toMatch(/org_id = :org_id AND deleted = false/);
        expect(calls[0].rep).toEqual({ org_id: 'org-1' });
        expect(calls[2].sql).toMatch(/t\.scope IN \(:scopes\) OR \(t\.scope = :ls0 AND t\.name = :ln0\)/);
        expect(calls[2].rep).toEqual({ scopes: ['acme'], ls0: 'other', ln0: 'shared' });
        expect(u.get('jira')!.map((e) => [e.scope, e.name, e.realm_ids])).toEqual([['acme', 'triage', []], ['other', 'shared', ['r1']]]);
        expect(u.get('git')!.length).toBe(1);
    });
    it('no scopes and nothing listed → empty, no team query', async () => {
        const { find_org_agent_usage } = await import('../../../src/lib/agent_workflow.js');
        let n = 0;
        const sq = { query: async (sql: string) => { n++; return sql.includes('realms') ? [{ id: 'r1', team_list: [] }] : []; } };
        expect((await find_org_agent_usage('o', sq as never)).size).toBe(0);
        expect(n).toBe(2);
    });
});
