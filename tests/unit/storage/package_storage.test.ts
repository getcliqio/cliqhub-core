import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    package_key,
    package_path,
    create_package_storage,
} from '../../../src/storage/package_storage.js';

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
            s3_bucket: '',
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
            s3_bucket: 'bucket',
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
            s3_bucket: 'bucket',
            s3_access_key_id: 'akid',
            s3_secret_access_key: 'secret',
        });

        expect(await storage.read('missing.zip')).toBeNull();
        await expect(storage.delete('missing.zip')).resolves.toBeUndefined();
        await expect(storage.write('x.zip', Buffer.from('a'))).rejects.toThrow('R2 PUT failed');
    });
});
