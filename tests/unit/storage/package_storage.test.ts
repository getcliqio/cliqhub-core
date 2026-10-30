import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    package_key,
    package_path,
    create_package_storage,
    stored_key,
    team_file_key,
    team_prefix,
    version_zip_key,
} from '../../../src/storage/package_storage.js';

const TEAM = '11111111-2222-4333-8444-555555555555';
const VERSION = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const FILE = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const R2 = {
    packages_path: '/tmp',
    storage_backend: 'r2' as const,
    s3_endpoint: 'https://s3.example',
    s3_teams_bucket: 'bucket',
    s3_access_key_id: 'akid',
    s3_secret_access_key: 'secret',
};

describe('package_key / package_path', () => {
    it('builds a safe zip key and absolute path', () => {
        expect(package_key('hello-world', '1.2.3')).toBe('hello-world-1.2.3.zip');
        const resolved = package_path('/tmp/packages', 'hello-world', '1.2.3');
        expect(resolved).toBe(path.resolve('/tmp/packages', 'hello-world-1.2.3.zip'));
    });

    it('rejects invalid team names and versions', () => {
        expect(() => package_key('Bad_Name', '1.0.0')).toThrow('Invalid team name');
        expect(() => package_key('hello', 'v1')).toThrow('Invalid version');
    });
});

describe('create_package_storage local', () => {
    let packages_path: string;

    beforeEach(() => {
        packages_path = fs.mkdtempSync(path.join(os.tmpdir(), 'cliqhub-pkgs-'));
    });

    afterEach(() => {
        fs.rmSync(packages_path, { recursive: true, force: true });
    });

    it('writes reads and deletes local packages', async () => {
        const storage = create_package_storage({
            packages_path,
            storage_backend: 'local',
            s3_endpoint: '',
            s3_teams_bucket: '',
            s3_access_key_id: '',
            s3_secret_access_key: '',
        });

        const key = package_key('demo', '1.0.0');
        const data = Buffer.from('zip-bytes');
        await storage.write(key, data);
        expect(await storage.read(key)).toEqual(data);
        await storage.delete(key);
        expect(await storage.read(key)).toBeNull();
        await storage.delete(key);
    });
});

describe('create_package_storage r2', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('puts gets and deletes via signed fetch', async () => {
        const calls: { method: string; url: string }[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ method: String(init?.method), url });
            if (init?.method === 'GET') {
                return {
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
                };
            }
            return { ok: true, status: 200 };
        }));

        const storage = create_package_storage({
            packages_path: '/tmp',
            storage_backend: 'r2',
            s3_endpoint: 'https://s3.example',
            s3_teams_bucket: 'bucket',
            s3_access_key_id: 'akid',
            s3_secret_access_key: 'secret',
        });

        await storage.write('demo-1.0.0.zip', Buffer.from('abc'));
        expect(await storage.read('demo-1.0.0.zip')).toEqual(Buffer.from([1, 2, 3]));
        await storage.delete('demo-1.0.0.zip');
        expect(calls.map(c => c.method)).toEqual(['PUT', 'GET', 'DELETE']);
        expect(calls[0].url).toContain('/bucket/demo-1.0.0.zip');
    });

    it('maps r2 404 on read to null and ignores delete 404', async () => {
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === 'GET') return { ok: false, status: 404 };
            if (init?.method === 'DELETE') return { ok: false, status: 404 };
            return { ok: false, status: 500 };
        }));

        const storage = create_package_storage({
            packages_path: '/tmp',
            storage_backend: 'r2',
            s3_endpoint: 'https://s3.example',
            s3_teams_bucket: 'bucket',
            s3_access_key_id: 'akid',
            s3_secret_access_key: 'secret',
        });

        expect(await storage.read('missing.zip')).toBeNull();
        await expect(storage.delete('missing.zip')).resolves.toBeUndefined();
        await expect(storage.write('x.zip', Buffer.from('a'))).rejects.toThrow('R2 PUT failed');
    });
});

describe('team keys (PLAN-team-bundle §2.2)', () => {
    it('keys a team by id: file objects by file id, version zips by version id', () => {
        expect(team_prefix(TEAM)).toBe(`teams/${TEAM}/`);
        expect(team_file_key(TEAM, FILE)).toBe(`teams/${TEAM}/files/${FILE}`);
        expect(version_zip_key(TEAM, VERSION)).toBe(`teams/${TEAM}/versions/${VERSION}.zip`);
    });

    it('refuses ids that are not uuids (a name, a path, a hash)', () => {
        expect(() => team_prefix('leaf')).toThrow('Invalid team id');
        expect(() => team_prefix('../x')).toThrow('Invalid team id');
        expect(() => version_zip_key(TEAM, '1.0.0')).toThrow('Invalid version id');
        expect(() => team_file_key(TEAM, 'a'.repeat(64))).toThrow('Invalid file id');
    });

    it('stored_key reads id keys only', () => {
        expect(stored_key(version_zip_key(TEAM, VERSION))).toBe(version_zip_key(TEAM, VERSION));
        expect(stored_key('leaf-1.0.0.zip')).toBeNull();
        expect(stored_key('')).toBeNull();
    });
});

describe('team prefixes: local', () => {
    let packages_path: string;
    const storage = () => create_package_storage({ ...R2, packages_path, storage_backend: 'local' });

    beforeEach(() => { packages_path = fs.mkdtempSync(path.join(os.tmpdir(), 'cliqhub-teams-')); });
    afterEach(() => { fs.rmSync(packages_path, { recursive: true, force: true }); });

    it('lists a team\'s objects; delete_prefix clears one team only', async () => {
        const OTHER = '99999999-2222-4333-8444-555555555555';
        await storage().write(team_file_key(TEAM, FILE), Buffer.from('a'));
        await storage().write(version_zip_key(TEAM, VERSION), Buffer.from('zip'));
        await storage().write(team_file_key(OTHER, FILE), Buffer.from('b'));
        expect(await storage().list(team_prefix(TEAM))).toEqual([team_file_key(TEAM, FILE), version_zip_key(TEAM, VERSION)]);
        await storage().delete_prefix(team_prefix(TEAM));
        expect(await storage().list(team_prefix(TEAM))).toEqual([]);
        expect(await storage().read(team_file_key(OTHER, FILE))).toEqual(Buffer.from('b'));
    });

    it('a missing prefix lists as empty', async () => {
        expect(await storage().list(team_prefix(TEAM))).toEqual([]);
    });
});

describe('team prefixes: r2', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    it('lists with ListObjectsV2, following continuation tokens', async () => {
        const prefix = team_prefix(TEAM);
        const urls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            urls.push(url);
            if (!url.includes('continuation-token')) {
                return { ok: true, status: 200, text: async () => `<ListBucketResult><Key>${prefix}files/a</Key><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;1</NextContinuationToken></ListBucketResult>` };
            }
            return { ok: true, status: 200, text: async () => `<ListBucketResult><Key>${prefix}files/b</Key><IsTruncated>false</IsTruncated></ListBucketResult>` };
        }));
        expect(await create_package_storage(R2).list(prefix)).toEqual([`${prefix}files/a`, `${prefix}files/b`]);
        expect(urls[0]).toBe(`https://s3.example/bucket/?list-type=2&prefix=${encodeURIComponent(prefix)}`);
        expect(urls[1]).toContain('continuation-token=t%261');
    });

    it('a plain key signs exactly as SigV4 with no query (existing packages are unaffected)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
        let auth = '';
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            auth = (init?.headers as Record<string, string>).Authorization;
            return { ok: true, status: 200 };
        }));
        await create_package_storage(R2).write('demo-1.0.0.zip', Buffer.from('abc'));

        // Independent SigV4 for PUT /bucket/demo-1.0.0.zip, empty query.
        const hash = crypto.createHash('sha256').update('abc').digest('hex');
        const date = '20261030T120000Z';
        const headers: Record<string, string> = { 'content-length': '3', 'content-type': 'application/zip', host: 's3.example', 'x-amz-content-sha256': hash, 'x-amz-date': date };
        const keys = Object.keys(headers).sort();
        const canonical = ['PUT', '/bucket/demo-1.0.0.zip', '', keys.map((k) => `${k}:${headers[k]}\n`).join(''), keys.join(';'), hash].join('\n');
        const to_sign = ['AWS4-HMAC-SHA256', date, '20261030/auto/s3/aws4_request', crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
        const h = (k: Buffer | string, d: string) => crypto.createHmac('sha256', k).update(d).digest();
        const signing = h(h(h(h('AWS4secret', '20261030'), 'auto'), 's3'), 'aws4_request');
        const signature = crypto.createHmac('sha256', signing).update(to_sign).digest('hex');
        expect(auth).toBe(`AWS4-HMAC-SHA256 Credential=akid/20261030/auto/s3/aws4_request, SignedHeaders=${keys.join(';')}, Signature=${signature}`);
    });
});
