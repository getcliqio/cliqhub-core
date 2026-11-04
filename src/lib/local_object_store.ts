/**
 * Artifact objects on local disk, for a CliqHub with no R2 (the local dev stack, `STORAGE_BACKEND=local`): the same
 * four operations artifact storage uses on R2 — put a stream, get it (with a byte range), delete it — so Hug
 * attachments work end to end without object storage (PLAN-team-bundle S6). Wherever R2 is configured it is used
 * instead (see `object_store_from_env`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { R2Client, load_r2_config_from_env } from './r2_client.js';

/** What artifact storage needs from an object store (R2Client has exactly these). */
export interface ObjectStore {
    readonly is_configured: boolean;
    put_object_stream(key: string, body: Readable, opts: { content_length: number; content_type: string; sha256_hex: string }): Promise<void>;
    delete_object(key: string): Promise<void>;
    get_object_stream(key: string, opts?: { range?: string }): Promise<{
        body: ReadableStream<Uint8Array>;
        status: 200 | 206;
        content_length: number | null;
        content_type: string;
        content_range?: string;
    } | null>;
}

/** An object key that is safe as one file name. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/** Objects as files under one folder; each object's content type is kept beside it (`<key>.type`). */
export class LocalObjectStore implements ObjectStore {
    readonly is_configured = true;

    constructor(private readonly _root: string) {}

    private _file(key: string): string {
        if (!SAFE_KEY.test(key)) throw new Error(`Not an object key: '${key}'`);
        return path.join(this._root, key);
    }

    async put_object_stream(key: string, body: Readable, opts: { content_length: number; content_type: string; sha256_hex: string }): Promise<void> {
        const file = this._file(key);
        await fs.promises.mkdir(this._root, { recursive: true });
        await pipeline(body, fs.createWriteStream(file));
        await fs.promises.writeFile(`${file}.type`, opts.content_type);
    }

    async delete_object(key: string): Promise<void> {
        const file = this._file(key);
        await fs.promises.rm(file, { force: true });
        await fs.promises.rm(`${file}.type`, { force: true });
    }

    async get_object_stream(key: string, opts: { range?: string } = {}): ReturnType<ObjectStore['get_object_stream']> {
        const file = this._file(key);
        let size: number;
        try {
            size = (await fs.promises.stat(file)).size;
        } catch {
            return null; // no such object
        }
        const content_type = await fs.promises.readFile(`${file}.type`, 'utf8').catch(() => 'application/octet-stream');
        const range = opts.range ? /^bytes=(\d*)-(\d*)$/.exec(opts.range) : null;
        if (range && size > 0) {
            const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
            const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            return {
                body: Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>,
                status: 206,
                content_length: end - start + 1,
                content_type,
                content_range: `bytes ${start}-${end}/${size}`,
            };
        }
        return { body: Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>, status: 200, content_length: size, content_type };
    }
}

/**
 * The artifact object store: R2 when it is configured (production); otherwise, on a CliqHub that keeps its files
 * locally (`STORAGE_BACKEND=local`, the dev stack), files on disk beside the team packages
 * (`ARTIFACTS_LOCAL_DIR`, default `<PACKAGES_PATH>/../artifacts`). Anything else stays unconfigured (uploads 503).
 */
export function object_store_from_env(): ObjectStore {
    const r2 = new R2Client(load_r2_config_from_env());
    if (r2.is_configured || process.env.STORAGE_BACKEND !== 'local') return r2;
    const root = process.env.ARTIFACTS_LOCAL_DIR?.trim() || path.resolve(process.env.PACKAGES_PATH || './data/packages', '..', 'artifacts');
    return new LocalObjectStore(root);
}
