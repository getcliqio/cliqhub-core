/**
 * Version content from files (PLAN-team-bundle S1.4b): derived the way publish derives it, checked against
 * sha256, cached for published versions only, the latest by semver; several read a few at a time.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    rows: [] as Array<Record<string, unknown>>,
    status: new Map<string, string>(),
    versions: [] as Array<{ id: string; team_id: string; version: string; status: string }>,
    reads: 0,
}));
vi.mock('../../../src/models/index.js', () => ({
    TeamVersion: {
        findOne: vi.fn(async ({ where }: { where: { id: string } }) => (state.status.has(where.id) ? { status: state.status.get(where.id) } : null)),
        findAll: vi.fn(async ({ where }: { where: { team_id: string | string[] } }) => state.versions.filter((v) => v.status === 'published'
            && (Array.isArray(where.team_id) ? where.team_id.includes(v.team_id) : v.team_id === where.team_id))),
    },
    TeamFile: {},
    TeamVersionSubTeam: {},
}));
vi.mock('../../../src/repositories/team_file_repository.js', () => ({
    TeamFileRepository: class { async list_by_version(id: string) { state.reads++; return state.rows.filter((r) => r.version_id === id); } },
}));

import { create_package_storage } from '../../../src/storage/package_storage.js';
import {
    clear_version_content_cache, init_version_content, latest_version_content, version_content, version_contents,
} from '../../../src/services/version_content.js';

const TEAM = 'aaaaaaaa-1111-4111-8111-111111111111';
const V1 = 'cccccccc-3333-4333-8333-333333333333';
const V2 = 'dddddddd-4444-4444-8444-444444444444';
const DRAFT = 'eeeeeeee-5555-4555-8555-555555555555';

let dir: string;
const storage = () => create_package_storage({ packages_path: dir, storage_backend: 'local', s3_endpoint: '', s3_teams_bucket: '', s3_access_key_id: '', s3_secret_access_key: '' });

async function put(version_id: string, files: Record<string, string>) {
    for (const [p, text] of Object.entries(files)) {
        const key = `teams/${TEAM}/files/${version_id}-${p.replace('/', '_')}`;
        await storage().write(key, Buffer.from(text));
        state.rows.push({ version_id, path: p, storage_key: key, sha256: createHash('sha256').update(text).digest('hex') });
    }
}

const LEAF = [
    'name: "@e2e/leaf"',
    'description: the bottom',
    'inputs:',
    '  - name: note',
    '    required: false',
    'agents:',
    '  exec: {}',
    'phases:',
    '  - name: say',
    '    agent: exec',
    '    commands:',
    '      - run: echo "{{inputs.note}} {{inputs.who}}"',
    'support:',
    '  - name: tidy',
    '    agent: exec',
    'tools: [jq]',
    'cliq_version: ">=1.15"',
    '',
].join('\n');

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliqhub-content-'));
    state.rows = []; state.status = new Map(); state.versions = []; state.reads = 0;
    clear_version_content_cache();
    init_version_content(storage());
    await put(V1, { 'team.yml': LEAF, 'README.md': '# leaf', 'dependencies.yml': '- name: jq\n', 'roles/say.md': 'Say it.', 'roles/brief.md': 'Brief.' });
    await put(V2, { 'team.yml': 'name: "@e2e/leaf"\nphases:\n  - name: two\n    agent: exec\n' });
    await put(DRAFT, { 'team.yml': 'name: "@e2e/leaf"\nphases: []\n' });
    state.status.set(V1, 'published'); state.status.set(V2, 'published'); state.status.set(DRAFT, 'draft');
    state.versions = [
        { id: V1, team_id: TEAM, version: '1.10.0', status: 'published' },
        { id: V2, team_id: TEAM, version: '1.9.0', status: 'published' },
        { id: DRAFT, team_id: TEAM, version: null as never, status: 'draft' },
    ];
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('version_content', () => {
    it("is what the version's files say: team.yml, roles, README, dependencies, phases, inputs, agents, tools", async () => {
        const c = (await version_content(V1))!;
        expect(c.version_id).toBe(V1);
        expect(c.manifest_yaml).toBe(LEAF);
        expect(c.roles).toEqual([{ name: 'brief', content_md: 'Brief.' }, { name: 'say', content_md: 'Say it.' }]);
        expect(c).toMatchObject({ readme: '# leaf', dependencies_yml: '- name: jq\n', agents: { exec: {} }, tools: ['jq'], cliq_version: '>=1.15' });
        expect(c.workflow.phases.map((p) => (p as { name: string }).name)).toEqual(['say']);
        expect(c.workflow.support?.map((p) => (p as { name: string }).name)).toEqual(['tidy']);
        // declared inputs stay as declared; an input a command uses without declaring it is added as required
        expect(c.inputs).toEqual([expect.objectContaining({ name: 'note', required: false }), expect.objectContaining({ name: 'who', required: true })]);
    });

    it('caches a published version (read once), not a draft', async () => {
        await version_content(V1); await version_content(V1);
        expect(state.reads).toBe(1);
        await version_content(DRAFT); await version_content(DRAFT);
        expect(state.reads).toBe(3);
    });

    it('null for a version without files; refuses bytes that do not match their sha256', async () => {
        expect(await version_content('ffffffff-6666-4666-8666-666666666666')).toBeNull();
        await storage().write(state.rows.find((r) => r.version_id === V2)!.storage_key as string, Buffer.from('tampered'));
        await expect(version_content(V2)).rejects.toThrow(/don't match/);
    });

    it('latest_version_content is the highest semver (1.10.0 over 1.9.0), never a draft', async () => {
        const latest = (await latest_version_content(TEAM))!;
        expect(latest).toMatchObject({ version_id: V1, version: '1.10.0' });
        expect(await latest_version_content('bbbbbbbb-2222-4222-8222-222222222222')).toBeNull();
    });

    it('version_contents reads several, leaving out versions without files', async () => {
        const all = await version_contents([V1, V2, V1, 'ffffffff-6666-4666-8666-666666666666']);
        expect([...all.keys()].sort()).toEqual([V1, V2].sort());
    });
});
