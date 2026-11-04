/**
 * LocalObjectStore (PLAN-team-bundle S6): artifact objects on disk for a CliqHub without R2 — put, get (with a byte
 * range) and delete; and object_store_from_env picks R2 whenever it is configured.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalObjectStore, object_store_from_env } from '../../../src/lib/local_object_store.js';
import { R2Client } from '../../../src/lib/r2_client.js';

const text_of = async (body: ReadableStream<Uint8Array>) => Buffer.from(await new Response(body).arrayBuffer()).toString();
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe('LocalObjectStore', () => {
    const store = () => new LocalObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cliqhub-objects-')));

    it('puts an object and gets it back with its type; a byte range is a 206 slice', async () => {
        const s = store();
        await s.put_object_stream('a-1', Readable.from([Buffer.from('hello world')]), { content_length: 11, content_type: 'text/plain', sha256_hex: 'x' });
        const whole = (await s.get_object_stream('a-1'))!;
        expect(whole).toMatchObject({ status: 200, content_length: 11, content_type: 'text/plain' });
        expect(await text_of(whole.body)).toBe('hello world');
        const part = (await s.get_object_stream('a-1', { range: 'bytes=6-10' }))!;
        expect(part).toMatchObject({ status: 206, content_length: 5, content_range: 'bytes 6-10/11' });
        expect(await text_of(part.body)).toBe('world');
    });

    it('a missing object is null; delete removes it; a key that is not one file name is refused', async () => {
        const s = store();
        expect(await s.get_object_stream('nope')).toBeNull();
        await s.put_object_stream('a-2', Readable.from([Buffer.from('x')]), { content_length: 1, content_type: 'text/plain', sha256_hex: 'x' });
        await s.delete_object('a-2');
        expect(await s.get_object_stream('a-2')).toBeNull();
        await expect(s.get_object_stream('../etc/passwd')).rejects.toThrow(/Not an object key/);
    });
});

describe('object_store_from_env', () => {
    it('R2 when it is configured, whatever the storage backend', () => {
        process.env.S3_ENDPOINT = 'https://r2.example';
        process.env.STORAGE_BACKEND = 'local';
        expect(object_store_from_env()).toBeInstanceOf(R2Client);
    });

    it('local disk only on a local-storage CliqHub without R2; otherwise unconfigured', () => {
        delete process.env.S3_ENDPOINT;
        process.env.STORAGE_BACKEND = 'local';
        expect(object_store_from_env()).toBeInstanceOf(LocalObjectStore);
        process.env.STORAGE_BACKEND = 'r2';
        expect(object_store_from_env().is_configured).toBe(false);
    });
});
