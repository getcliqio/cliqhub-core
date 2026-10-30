/**
 * One-time move of version zips to id keys (PLAN-team-bundle S1.2): each zip is copied to
 * teams/<team_id>/versions/<version_id>.zip, read back, and its row repointed; old keys stay; versions with
 * no zip are listed; the pass is recorded and not repeated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate_team_zips_by_id, TEAM_ZIPS_BY_ID_MIGRATION_KEY } from '../../../src/models/migrations/migrate_team_zips_by_id.js';
import { create_package_storage, version_zip_key } from '../../../src/storage/package_storage.js';

const TEAM_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TEAM_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const V1 = 'cccccccc-3333-4333-8333-333333333333';
const V2 = 'dddddddd-4444-4444-8444-444444444444';
const V3 = 'eeeeeeee-5555-4555-8555-555555555555';

type Row = { id: string; team_id: string; version: string; package_path: string };

let dir: string;
let rows: Row[];
let settings: Map<string, string>;
const storage = () => create_package_storage({ packages_path: dir, storage_backend: 'local', s3_endpoint: '', s3_teams_bucket: '', s3_access_key_id: '', s3_secret_access_key: '' });
const deps = () => ({
    storage: storage(),
    versions: {
        list_all_packages: async () => rows.map((r) => ({ ...r })),
        update_package_path: async (id: string, p: string) => { rows.find((r) => r.id === id)!.package_path = p; },
    } as never,
    settings: {
        find_by_key: async (k: string) => settings.get(k) ?? null,
        create: async (k: string, v: string) => { settings.set(k, v); },
    } as never,
});

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliqhub-zips-'));
    settings = new Map();
    await storage().write('leaf-1.0.0.zip', Buffer.from('zip of @a/leaf'));
    rows = [
        { id: V1, team_id: TEAM_A, version: '1.0.0', package_path: path.join(dir, 'leaf-1.0.0.zip') },
        { id: V2, team_id: TEAM_B, version: '2.0.0', package_path: 'draft://b/2.0.0' },
        { id: V3, team_id: TEAM_B, version: '3.0.0', package_path: version_zip_key(TEAM_B, V3) },
    ];
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('migrate_team_zips_by_id', () => {
    it('copies each zip to its id key, repoints the row, keeps the old key, lists versions with no zip', async () => {
        const result = await migrate_team_zips_by_id(deps());
        expect(result).toEqual({ moved: 1, missing: [`${TEAM_B}@2.0.0`], skipped: false });
        expect(rows[0].package_path).toBe(version_zip_key(TEAM_A, V1));
        expect(await storage().read(version_zip_key(TEAM_A, V1))).toEqual(Buffer.from('zip of @a/leaf'));
        expect(await storage().read('leaf-1.0.0.zip')).not.toBeNull();
        expect(rows[1].package_path).toBe('draft://b/2.0.0');
        expect(rows[2].package_path).toBe(version_zip_key(TEAM_B, V3));
    });

    it('records the pass and does nothing the second time', async () => {
        await migrate_team_zips_by_id(deps());
        expect(JSON.parse(settings.get(TEAM_ZIPS_BY_ID_MIGRATION_KEY)!)).toMatchObject({ moved: 1 });
        rows[0].package_path = 'leaf-1.0.0.zip';
        expect(await migrate_team_zips_by_id(deps())).toEqual({ moved: 0, missing: [], skipped: true });
        expect(rows[0].package_path).toBe('leaf-1.0.0.zip');
    });

    it('a zip missing from storage is listed, not moved, and the rest still move', async () => {
        rows[0].package_path = 'gone-1.0.0.zip';
        const result = await migrate_team_zips_by_id(deps());
        expect(result.missing).toEqual([`${TEAM_A}@1.0.0`, `${TEAM_B}@2.0.0`]);
        expect(rows[0].package_path).toBe('gone-1.0.0.zip');
    });
});
