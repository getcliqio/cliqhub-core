/**
 * Publishing refuses a team with lines cliq would ignore (cliq-sdk `lint_team`), with every problem
 * listed, and writes nothing; the same team fixed publishes. Publishing a saved draft is checked
 * too; changing an already-published team's tags is not. Architect v0.1.28 is the fixture. A
 * `type: team` phase must give its sub-team (from the catalog) every input it requires (§14).
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
import { publish_team, upload_files } from '../helpers/publish_team.js';

const has_postgres = await postgres_reachable();
const ARCHITECT = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/teams/architect-0.1.28.team.yml'), 'utf8');
/** v0.1.29: team_inputs → args; the ignored when / escalate_on_fail / optional lines gone. */
const FIXED = ARCHITECT
    .replace('    team_inputs:\n', '    args:\n')
    .replace('    action: get_issue_tree\n    escalate_on_fail: true\n', '    action: get_issue_tree\n')
    .replace('    agent: exec\n    escalate_on_fail: true\n', '    agent: exec\n')
    .replace('    when: "{{inputs.create_stories}}"\n', '')
    .replace('    optional: true\n', '');
const named = (yml: string, name: string) => yml.replace(/^name: .*$/m, `name: ${name}`);

describe.skipIf(!has_postgres)('publish refuses lines cliq would ignore', () => {
    let app: Express;
    let s: Seed;
    let me: Awaited<ReturnType<Seed['signup']>>;
    const team_ids: string[] = [];
    const post = (p: string, body: Record<string, unknown>) => request(app).post(p).set('Authorization', `Bearer ${me.token}`).send(body);
    const publish = (name: string, version: string, files: Record<string, string>) =>
        publish_team(app, me.token, { name, scope: me.username, version, files });
    /** Published versions of a team (a refused publish leaves its draft, never a version). */
    const published = async (name: string) => {
        const t = await Team.findOne({ where: { name, scope: me.username }, attributes: ['id'], raw: true }) as { id: string } | null;
        return t ? TeamVersion.count({ where: { team_id: t.id, status: 'published' } }) : 0;
    };
    const track = async (name: string) => {
        const t = await Team.findOne({ where: { name, scope: me.username }, attributes: ['id'], raw: true }) as { id: string } | null;
        if (t && !team_ids.includes(t.id)) team_ids.push(t.id);
    };
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

    it('architect v0.1.28: 422 invalid_team listing each line; no version published', async () => {
        const res = await publish('architect', '0.1.28', { 'team.yml': named(ARCHITECT, 'architect') });
        await track('architect');
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(err(res).code).toBe('invalid_team');
        expect(err(res).details.problems.map((p: { phase: string | null; line: string }) => `${p.phase ?? '-'}:${p.line}`)).toEqual([
            'fetch:escalate_on_fail', 'ensure-clones:team_inputs', 'create-stories:escalate_on_fail', 'create-stories:when', '-:optional',
        ]);
        expect(err(res).message).toContain('`team_inputs` isn\'t accepted by a team phase — use `args`');
        expect(await published('architect')).toBe(0);
    });

    it('the same team fixed (v0.1.29) publishes', async () => {
        const res = await publish('architect', '0.1.29', { 'team.yml': named(FIXED, 'architect') });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await track('architect');
        // Re-listing / new tags check the latest version again (it's clean).
        const tags = await post('/v1/teams/publish', { team_id: res.body.data.id, tags: ['lld'] });
        expect(tags.status, JSON.stringify(tags.body)).toBe(200);
    });

    it('publishing a saved draft checks its team.yml too', async () => {
        const created = await post('/v1/teams/create', { name: 'drafty', scope: me.username, description: 'x' });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const { id: team_id, version_id } = created.body.data;
        team_ids.push(team_id);
        const saved = await upload_files(app, me.token, { team_id, version_id }, { 'team.yml': named(ARCHITECT, 'drafty') });
        expect(saved.status, JSON.stringify(saved.body)).toBe(201);
        const res = await post('/v1/teams/publish', { team_id, version: '1.0.0', version_id });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(err(res).code).toBe('invalid_team');
        expect(await published('drafty')).toBe(0);
    });

    it("a team phase must give its catalog sub-team every input it requires (args)", async () => {
        const child = 'name: subby\ndescription: child\ninputs:\n  - name: ticket\n    type: string\n    required: true\nphases:\n  - name: go\n    type: standard\n    agent: exec\n    commands:\n      - run: echo "{{inputs.ticket}}"\n';
        const sub = await publish('subby', '1.0.0', { 'team.yml': child });
        expect(sub.status, JSON.stringify(sub.body)).toBe(200);
        await track('subby');

        const parent = (args: string) => `name: parenty\ndescription: parent\nphases:\n  - name: child\n    type: team\n    team: "@${me.username}/subby"\n${args}`;
        const bad = await publish('parenty', '1.0.0', { 'team.yml': parent('') });
        await track('parenty');
        expect(bad.status, JSON.stringify(bad.body)).toBe(422);
        expect(err(bad).code).toBe('invalid_team');
        expect(err(bad).message).toContain(`sub-team @${me.username}/subby needs input \`ticket\` — add it to args`);

        const good = await publish('parenty', '1.0.0', { 'team.yml': parent('    args:\n      ticket: T-1\n') });
        expect(good.status, JSON.stringify(good.body)).toBe(200);
    });

    it('dependencies.yml: published with the team, returned by get_by_id, packed in the download; a broken one is refused', async () => {
        const deps = '- name: jq\n  version: "1.7"\n  install: apt-get install -y jq\n';
        const res = await publish('depsy', '1.0.0', { 'team.yml': named(FIXED, 'depsy'), 'dependencies.yml': deps });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await track('depsy');

        const got = await post('/v1/teams/get_by_id', { name: 'depsy', scope: me.username });
        expect(got.body.data.dependencies).toBe(deps);
        const dl = await post('/v1/teams/download', { name: 'depsy', scope: me.username });
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(Buffer.from(dl.body.data.data_base64, 'base64'));
        expect(await zip.file('dependencies.yml')!.async('string')).toBe(deps);

        const bad = await publish('depsy', '1.0.1', { 'team.yml': named(FIXED, 'depsy'), 'dependencies.yml': '- name: jq\n' });
        expect(bad.status, JSON.stringify(bad.body)).toBe(422);
        expect(err(bad).details).toMatchObject({ field: 'dependencies.yml', problems: ['dependency `jq` has no `install` command'] });
    });
});
