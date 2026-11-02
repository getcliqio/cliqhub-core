/**
 * The old-zip cleanup (PLAN-team-bundle S1.5c): every published version gets its zip by id, and a pre-S1.2
 * `<name>-<version>.zip` is deleted only when its files are exactly a version's files; anything else is kept and
 * reported, and the pass is recorded only when nothing is left.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pack_bundle, unpack_bundle } from '@getcliqio/cliq-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drop_old_zip_keys, OLD_ZIP_KEYS_KEY, OLD_ZIP_KEYS_REPORT_KEY } from '../../../src/models/migrations/old_zip_keys.js';
import type { TeamFileRow } from '../../../src/repositories/team_file_repository.js';
import { team_file_content_type, write_team_file_objects } from '../../../src/services/team_file_objects.js';
import { create_package_storage, version_zip_key } from '../../../src/storage/package_storage.js';

const TEAM_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TEAM_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const V1 = 'cccccccc-3333-4333-8333-333333333333';
const V2 = 'dddddddd-4444-4444-8444-444444444444';

const FILES_A = { 'team.yml': 'name: "@a/leaf"\nphases: []\n', 'README.md': '# a' };
const FILES_B = { 'team.yml': 'name: "@b/leaf"\nphases: []\n' };

type Row = { id: string; team_id: string; version: string; package_path: string; team_name: string };

let dir: string;
let rows: Row[];
let file_rows: Map<string, TeamFileRow[]>;
let settings: Map<string, string>;
const storage = () => create_package_storage({ packages_path: dir, storage_backend: 'local', s3_endpoint: '', s3_teams_bucket: '', s3_access_key_id: '', s3_secret_access_key: '' });
const deps = () => ({
    storage: storage(),
    versions: {
        list_published_packages: async () => rows.map((r) => ({ ...r })),
        update_package_path: async (id: string, p: string) => { rows.find((r) => r.id === id)!.package_path = p; },
    } as never,
    files: { list_by_version: async (id: string) => file_rows.get(id) ?? [] } as never,
    settings: {
        find_by_key: async (k: string) => settings.get(k) ?? null,
        create: async (k: string, v: string) => { settings.set(k, v); },
        update_by_key: async (k: string, v: string) => { settings.set(k, v); },
    } as never,
});

async function give_files(team_id: string, version_id: string, files: Record<string, string>): Promise<void> {
    const out = await write_team_file_objects(storage(), team_id, Object.entries(files).map(([p, text]) => ({
        path: p, content_type: team_file_content_type(p), data: Buffer.from(text, 'utf8'),
    })));
    file_rows.set(version_id, out.map((r) => ({ ...r, version_id })));
}

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliqhub-old-zips-'));
    settings = new Map();
    file_rows = new Map();
    // @a/leaf 1.0.0 was moved to its id key in S1.2; @b/leaf 1.0.0 never had a zip.
    await storage().write(version_zip_key(TEAM_A, V1), await pack_bundle({ files: FILES_A }));
    rows = [
        { id: V1, team_id: TEAM_A, version: '1.0.0', package_path: version_zip_key(TEAM_A, V1), team_name: 'leaf' },
        { id: V2, team_id: TEAM_B, version: '2.0.0', package_path: '', team_name: 'leaf' },
    ];
    await give_files(TEAM_A, V1, FILES_A);
    await give_files(TEAM_B, V2, FILES_B);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('drop_old_zip_keys', () => {
    it("builds the zip of a version that has none, from its files, and points the row at it", async () => {
        await storage().write('leaf-1.0.0.zip', await pack_bundle({ files: FILES_A }));
        const result = await drop_old_zip_keys(deps());
        expect(result.built).toEqual([`${TEAM_B}@2.0.0`]);
        expect(rows[1].package_path).toBe(version_zip_key(TEAM_B, V2));
        expect((await unpack_bundle((await storage().read(version_zip_key(TEAM_B, V2)))!)).files).toEqual(FILES_B);
    });

    it('deletes an old zip whose files are exactly a version\'s, and records the pass', async () => {
        await storage().write('leaf-1.0.0.zip', await pack_bundle({ files: FILES_A }));
        const result = await drop_old_zip_keys(deps());
        expect(result).toMatchObject({ deleted: ['leaf-1.0.0.zip'], kept: [] });
        expect(await storage().read('leaf-1.0.0.zip')).toBeNull();
        expect(settings.has(OLD_ZIP_KEYS_KEY)).toBe(true);
        expect((await drop_old_zip_keys(deps())).already).toBe(true);
    });

    it('moves an old zip no published version uses to attic/, and records the pass', async () => {
        const data = Buffer.from('{"team.yml":"name: gone"}');
        await storage().write('gone-1.0.0.zip', data);
        const result = await drop_old_zip_keys(deps());
        expect(result).toMatchObject({ attic: ['gone-1.0.0.zip'], deleted: [], kept: [] });
        expect(await storage().read('gone-1.0.0.zip')).toBeNull();
        expect(await storage().read('attic/gone-1.0.0.zip')).toEqual(data);
        expect(settings.has(OLD_ZIP_KEYS_KEY)).toBe(true);
    });

    it('moves an old zip with different text, an extra path, or that is not a zip to attic/, and records the pass', async () => {
        await storage().write('leaf-1.0.0.zip', await pack_bundle({ files: { ...FILES_A, 'README.md': '# other' } }));
        await storage().write('leaf-2.0.0.zip', await pack_bundle({ files: { ...FILES_B, 'README.md': '# only in the zip' } }));
        rows[1].version = '2.0.0';
        const json = Buffer.from('{"team.yml":"name: leaf"}');
        await storage().write('leaf-3.0.0.zip', json);
        rows.push({ id: 'eeeeeeee-5555-4555-8555-555555555555', team_id: TEAM_B, version: '3.0.0', package_path: '', team_name: 'leaf' });
        await give_files(TEAM_B, 'eeeeeeee-5555-4555-8555-555555555555', FILES_B);
        const result = await drop_old_zip_keys(deps());
        expect(result.deleted).toEqual([]);
        expect(result.attic).toEqual(['leaf-1.0.0.zip', 'leaf-2.0.0.zip', 'leaf-3.0.0.zip']);
        expect(result.kept).toEqual([]);
        for (const k of ['leaf-1.0.0.zip', 'leaf-2.0.0.zip', 'leaf-3.0.0.zip']) expect(await storage().read(k)).toBeNull();
        expect(await storage().read('attic/leaf-3.0.0.zip')).toEqual(json);
        expect(settings.has(OLD_ZIP_KEYS_KEY)).toBe(true);
    });

    it('rebuilds a version whose stored zip is not a zip (an early JSON blob)', async () => {
        await storage().write(version_zip_key(TEAM_A, V1), Buffer.from('{"team.yml":"name: leaf"}'));
        const result = await drop_old_zip_keys(deps());
        expect(result.built).toContain(`${TEAM_A}@1.0.0`);
        expect((await unpack_bundle((await storage().read(version_zip_key(TEAM_A, V1)))!)).files).toEqual(FILES_A);
    });

    it('an old zip shared by same-named teams goes when it matches one of them', async () => {
        rows[1].version = '1.0.0';
        await storage().write('leaf-1.0.0.zip', await pack_bundle({ files: FILES_B }));
        expect((await drop_old_zip_keys(deps())).deleted).toEqual(['leaf-1.0.0.zip']);
    });

    it('leaves files that are not zips and keys in folders alone', async () => {
        await storage().write('notes.txt', Buffer.from('x'));
        const result = await drop_old_zip_keys(deps());
        expect(result.kept).toEqual([]);
        expect(await storage().read('notes.txt')).not.toBeNull();
        expect(await storage().read(version_zip_key(TEAM_A, V1))).not.toBeNull();
    });
});
