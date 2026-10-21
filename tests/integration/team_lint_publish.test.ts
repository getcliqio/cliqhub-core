/**
 * Publishing refuses a team with lines cliq would ignore (cliq-sdk `lint_team`), with every problem
 * listed, and writes nothing; the same team fixed publishes. Publishing a saved draft is checked
 * too; changing an already-published team's tags is not. Architect v0.1.28 is the fixture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';
import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { Team, TeamVersion } from '../../src/models/index.js';
import { seed_all } from '../../src/lib/seed.js';

const has_postgres = await postgres_reachable();
const ARCHITECT = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/teams/architect-0.1.28.team.yml'), 'utf8');
/** v0.1.29: team_inputs → args; the ignored when / escalate_on_fail / optional lines gone. */
const FIXED = ARCHITECT
    .replace('    team_inputs:\n', '    args:\n')
    .replace('    action: get_issue_tree\n    escalate_on_fail: true\n', '    action: get_issue_tree\n')
    .replace('    agent: exec\n    escalate_on_fail: true\n', '    agent: exec\n')
    .replace('    when: "{{inputs.create_stories}}"\n', '')
    .replace('    optional: true\n', '');
const pkg = (yml: string, name: string) => Buffer.from(JSON.stringify({ 'team.yml': yml.replace(/^name: .*$/m, `name: ${name}`), roles: [] })).toString('base64');

describe.skipIf(!has_postgres)('publish refuses lines cliq would ignore', () => {
    let app: Express;
    let s: Seed;
    let me: Awaited<ReturnType<Seed['signup']>>;
    const team_ids: string[] = [];
    const post = (p: string, body: Record<string, unknown>) => request(app).post(p).set('Authorization', `Bearer ${me.token}`).send(body);
    /** Core's error, nested (`error: {code, message, details}`) or flat (`error: message, code, details`). */
    const err = (res: request.Response) => {
        const e = res.body.error;
        return typeof e === 'object' && e !== null ? { code: e.code, message: e.message, details: e.details } : { code: res.body.code, message: e, details: res.body.details };
    };

    beforeAll(async () => {
        app = (await open_live_hub_app()).app;
        await seed_all();
        s = await seed_authz(app);
        me = await s.signup('lintpub');
    }, 300_000);
    afterAll(async () => {
        await TeamVersion.destroy({ where: { team_id: { [Op.in]: team_ids } } });
        await Team.destroy({ where: { id: { [Op.in]: team_ids } } });
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    it('architect v0.1.28: 422 invalid_team listing each line; nothing written', async () => {
        const res = await post('/v1/teams/publish', { name: 'architect', scope: me.username, version: '0.1.28', data_base64: pkg(ARCHITECT, 'architect') });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(err(res).code).toBe('invalid_team');
        expect(err(res).details.problems.map((p: { phase: string | null; line: string }) => `${p.phase ?? '-'}:${p.line}`)).toEqual([
            'fetch:escalate_on_fail', 'ensure-clones:team_inputs', 'create-stories:escalate_on_fail', 'create-stories:when', '-:optional',
        ]);
        expect(err(res).message).toContain('`team_inputs` isn\'t accepted by a team phase — use `args`');
        expect(await Team.count({ where: { name: 'architect', scope: me.username } })).toBe(0);
    });

    it('the same team fixed (v0.1.29) publishes', async () => {
        const res = await post('/v1/teams/publish', { name: 'architect', scope: me.username, version: '0.1.29', data_base64: pkg(FIXED, 'architect') });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        team_ids.push(res.body.data.id);
        // Re-listing / new tags check the latest version again (it's clean).
        const tags = await post('/v1/teams/publish', { team_id: res.body.data.id, tags: ['lld'] });
        expect(tags.status, JSON.stringify(tags.body)).toBe(200);
    });

    it('publishing a saved draft checks its team.yml too', async () => {
        const created = await post('/v1/teams/create', { name: 'drafty', scope: me.username, description: 'x', manifest: ARCHITECT.replace(/^name: .*$/m, 'name: drafty') });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        team_ids.push(created.body.data.id);
        const res = await post('/v1/teams/publish', { team_id: created.body.data.id });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(err(res).code).toBe('invalid_team');
    });

    it('dependencies.yml: published with the team, returned by get_by_id, packed in the download; a broken one is refused', async () => {
        const deps = '- name: jq\n  version: "1.7"\n  install: apt-get install -y jq\n';
        const with_deps = Buffer.from(JSON.stringify({ 'team.yml': FIXED.replace(/^name: .*$/m, 'name: depsy'), roles: [], 'dependencies.yml': deps })).toString('base64');
        const res = await post('/v1/teams/publish', { name: 'depsy', scope: me.username, version: '1.0.0', data_base64: with_deps });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        team_ids.push(res.body.data.id);

        const got = await post('/v1/teams/get_by_id', { name: 'depsy', scope: me.username });
        expect(got.body.data.dependencies).toBe(deps);
        const dl = await post('/v1/teams/download', { name: 'depsy', scope: me.username });
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(Buffer.from(dl.body.data.data_base64, 'base64'));
        expect(await zip.file('dependencies.yml')!.async('string')).toBe(deps);

        const broken = Buffer.from(JSON.stringify({ 'team.yml': FIXED.replace(/^name: .*$/m, 'name: depsy'), roles: [], 'dependencies.yml': '- name: jq\n' })).toString('base64');
        const bad = await post('/v1/teams/publish', { name: 'depsy', scope: me.username, version: '1.0.1', data_base64: broken });
        expect(bad.status, JSON.stringify(bad.body)).toBe(422);
        expect(err(bad).details).toMatchObject({ field: 'dependencies.yml', problems: ['dependency `jq` has no `install` command'] });
    });
});
