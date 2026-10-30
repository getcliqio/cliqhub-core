/**
 * Startup backfill (PLAN-team-bundle S1.4a): a published version without team_files gets them — from its zip
 * (team files only), else from its columns; the bytes are stored by file id and match the rows' sha256; a
 * version with neither is listed; one failing doesn't stop the rest; a second pass has nothing to do.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/sequelize.js', () => ({ get_sequelize: () => ({ transaction: (fn: (t: unknown) => unknown) => fn({}) }) }));

import yaml from 'js-yaml';
import { backfill_team_files, files_from_columns, team_yml_from_derived } from '../../../src/models/migrations/backfill_team_files.js';
import { workflow_from_team_yml } from '../../../src/services/package_parser.js';
import type { TeamFileRow } from '../../../src/repositories/team_file_repository.js';
import { create_package_storage, version_zip_key } from '../../../src/storage/package_storage.js';

const TEAM = 'aaaaaaaa-1111-4111-8111-111111111111';
const V_ZIP = 'cccccccc-3333-4333-8333-333333333333';
const V_COLS = 'dddddddd-4444-4444-8444-444444444444';
const V_EMPTY = 'eeeeeeee-5555-4555-8555-555555555555';
const V_BAD = 'ffffffff-6666-4666-8666-666666666666';

type Version = Awaited<ReturnType<Parameters<typeof backfill_team_files>[0]['versions']['list_published_without_files']>>[number];
const blank = {
    manifest_yaml: '', readme: '', dependencies_yaml: '', roles_json: '[]', workflow_json: '{"phases":[]}', capability_json: '{}', agents_json: '{}',
    team_scope: 'cliq', team_name: 'leaf', team_description: null,
};
/** @cliq/hello-world 2.0.0 as stored before team.yml was kept: phases, inputs, agents, README; no manifest. */
const HELLO_2_0 = {
    ...blank, team_name: 'hello-world', team_description: 'Say hello, then a person reviews it',
    readme: '# hello-world',
    workflow_json: JSON.stringify({ phases: [
        { name: 'greet', type: 'standard', agent: 'exec', commands: [{ name: 'print-name', run: 'echo "Hi {{inputs.name}}"' }] },
        { name: 'human-review', type: 'gate', agent: 'hug', depends_on: ['greet'], review: { reviewers: ['{{inputs.reviewers}}'] } },
    ] }),
    capability_json: JSON.stringify({ inputs: [
        { name: 'name', type: 'text', description: 'Who to greet', required: true },
        { name: 'reviewers', type: 'channel', description: 'Who should review this run', required: true },
    ] }),
    agents_json: JSON.stringify({ exec: {}, hug: {} }),
};

let dir: string;
let versions: Version[];
let rows: TeamFileRow[];
const storage = () => create_package_storage({ packages_path: dir, storage_backend: 'local', s3_endpoint: '', s3_teams_bucket: '', s3_access_key_id: '', s3_secret_access_key: '' });
const deps = () => ({
    storage: storage(),
    versions: { list_published_without_files: async () => versions.filter((v) => !rows.some((r) => r.version_id === v.id)) } as never,
    files: { replace_paths: async (_v: string, add: TeamFileRow[]) => { rows.push(...add); } } as never,
});
const files_of = async (version_id: string) => Object.fromEntries(await Promise.all(rows.filter((r) => r.version_id === version_id)
    .map(async (r) => [r.path, (await storage().read(r.storage_key))!.toString('utf8')])));

async function zip_of(files: Record<string, string>): Promise<Buffer> {
    const z = new JSZip();
    for (const [p, t] of Object.entries(files)) z.file(p, t);
    return z.generateAsync({ type: 'nodebuffer' });
}

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliqhub-backfill-'));
    rows = [];
    await storage().write(version_zip_key(TEAM, V_ZIP), await zip_of({
        'team.yml': 'name: "@a/leaf"\nphases: []\n', 'README.md': '# leaf', 'roles/say.md': 'Say it.', 'Dockerfile': 'FROM x',
    }));
    await storage().write(version_zip_key(TEAM, V_BAD), Buffer.from('not a zip'));
    versions = [
        { id: V_ZIP, team_id: TEAM, version: '1.0.0', package_path: version_zip_key(TEAM, V_ZIP), ...blank, manifest_yaml: 'ignored: the zip wins' },
        {
            id: V_COLS, team_id: TEAM, version: '0.1.0', package_path: '', manifest_yaml: 'name: "@cliq/hello"\nphases: []\n',
            readme: '# hello', dependencies_yaml: '- name: jq\n', roles_json: JSON.stringify([{ name: 'greet', content_md: 'Hi.' }, { name: 'plan.md', content_md: 'Plan.' }]),
        },
        { id: V_EMPTY, team_id: TEAM, version: '0.0.1', package_path: 'draft://x', ...blank },
        { id: V_BAD, team_id: TEAM, version: '0.0.2', package_path: version_zip_key(TEAM, V_BAD), ...blank },
    ];
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('backfill_team_files', () => {
    it("gives each version its files: the zip's team files, else its columns; lists the rest", async () => {
        const out = await backfill_team_files(deps());
        expect(out.from_zip).toEqual([`${TEAM}@1.0.0`]);
        expect(out.from_columns).toEqual([`${TEAM}@0.1.0`]);
        expect(out.empty).toEqual([`${TEAM}@0.0.1`]);
        expect(out.failed).toHaveLength(1);
        expect(out.failed[0]).toMatch(new RegExp(`^${TEAM}@0.0.2: `));

        // the zip's team files only (a Dockerfile isn't part of a team); its columns are not used
        expect(await files_of(V_ZIP)).toEqual({ 'team.yml': 'name: "@a/leaf"\nphases: []\n', 'README.md': '# leaf', 'roles/say.md': 'Say it.' });
        expect(await files_of(V_COLS)).toEqual({
            'team.yml': 'name: "@cliq/hello"\nphases: []\n', 'README.md': '# hello', 'dependencies.yml': '- name: jq\n',
            'roles/greet.md': 'Hi.', 'roles/plan.md': 'Plan.',
        });
    });

    it('stores each file by its id, with its size and sha256 and a team type', async () => {
        await backfill_team_files(deps());
        for (const r of rows) {
            expect(r.storage_key).toBe(`teams/${TEAM}/files/${r.id}`);
            const data = (await storage().read(r.storage_key))!;
            expect(r.size).toBe(data.length);
            expect(r.sha256).toBe(createHash('sha256').update(data).digest('hex'));
            expect(r.content_type).toBe(r.path.endsWith('.md') ? 'text/markdown' : 'text/yaml');
        }
    });

    it('a second pass has nothing left to do but the versions it could not fill', async () => {
        await backfill_team_files(deps());
        const n = rows.length;
        const again = await backfill_team_files(deps());
        expect(again.from_zip).toEqual([]);
        expect(again.from_columns).toEqual([]);
        expect(rows).toHaveLength(n);
    });

    it('files_from_columns: nothing without a manifest; unsafe role names are left out', () => {
        expect(files_from_columns(blank)).toEqual({});
        expect(files_from_columns({ ...blank, manifest_yaml: 'x: 1', roles_json: JSON.stringify([{ name: '../evil', content_md: 'x' }, { name: 'a/b', content_md: 'x' }]) }))
            .toEqual({ 'team.yml': 'x: 1' });
    });

    it('a version stored without team.yml gets one rebuilt from its phases, inputs and agents (round trip)', () => {
        const v = { ...HELLO_2_0, id: V_EMPTY, team_id: TEAM, version: '2.0.0', package_path: '' };
        const files = files_from_columns(v);
        expect(Object.keys(files).sort()).toEqual(['README.md', 'team.yml']);
        const doc = yaml.load(files['team.yml']) as Record<string, unknown>;
        expect(doc).toMatchObject({ name: '@cliq/hello-world', version: '2.0.0', description: 'Say hello, then a person reviews it' });
        // the seed stored the agents it uses as empty entries: those define nothing, so team.yml has no agents
        expect(doc).not.toHaveProperty('agents');
        const defined = yaml.load(team_yml_from_derived({ ...v, agents_json: JSON.stringify({ exec: {}, mine: { entry: 'node mine.js' } }) })!) as Record<string, unknown>;
        expect(defined.agents).toEqual({ mine: { entry: 'node mine.js' } });
        // parsed the way publish parses team.yml, it gives back the stored phases and inputs
        expect(workflow_from_team_yml(doc)).toEqual(JSON.parse(HELLO_2_0.workflow_json));
        expect({ inputs: doc.inputs }).toEqual(JSON.parse(HELLO_2_0.capability_json));
    });

    it('nothing is rebuilt without phases', () => {
        expect(team_yml_from_derived({ ...blank, version: '1.0.0' })).toBeNull();
    });
});
