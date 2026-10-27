/**
 * R2Client — reusable S3-compatible storage client for Cloudflare R2.
 *
 * Provides `put_object_stream`, `get_object_stream` and `delete_object` with
 * AWS Signature V4 signing. Only Core talks to R2: no presigned URL leaves Core
 * (PLAN-hug-requests §6.6). No external dependencies — uses Node crypto
 * and global fetch.
 */

import crypto from 'node:crypto';
import { Readable } from 'node:stream';

/** R2/S3 connection config. */
export interface R2Config {
    endpoint: string;
    bucket: string;
    access_key_id: string;
    secret_access_key: string;
}

/** Load R2 config from standard env vars. */
export function load_r2_config_from_env(bucket_env = 'S3_ARTIFACTS_BUCKET', default_bucket = 'cliq-artifacts'): R2Config {
    return {
        endpoint: process.env.S3_ENDPOINT || '',
        bucket: process.env[bucket_env] || default_bucket,
        access_key_id: process.env.S3_ACCESS_KEY_ID || '',
        secret_access_key: process.env.S3_SECRET_ACCESS_KEY || '',
    };
}

export class R2Client {
    private readonly _cfg: R2Config;

    constructor(cfg: R2Config) {
        this._cfg = cfg;
    }

    /** Whether the client has a configured endpoint. */
    get is_configured(): boolean {
        return Boolean(this._cfg.endpoint);
    }

    /**
     * PUT an object from a stream of known length. `x-amz-content-sha256` is the real hash (computed
     * by the caller while receiving it), so R2 verifies the body it stores. Throws on non-2xx.
     */
    async put_object_stream(key: string, body: Readable, opts: {
        content_length: number;
        content_type: string;
        sha256_hex: string;
    }): Promise<void> {
        const headers = this._s3_headers('PUT', key, opts.sha256_hex, {
            'content-type': opts.content_type,
            'content-length': String(opts.content_length),
        });
        const res = await fetch(this._s3_url(key), {
            method: 'PUT',
            headers,
            body: Readable.toWeb(body) as unknown as BodyInit,
            duplex: 'half',
        } as RequestInit);
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`R2 PUT failed: ${res.status} ${text}`);
        }
    }

    /**
     * DELETE an object from R2.
     * Ignores 404 (already deleted). Throws on other errors.
     */
    async delete_object(key: string): Promise<void> {
        const headers = this._s3_headers('DELETE', key, 'UNSIGNED-PAYLOAD');
        const url = this._s3_url(key);
        const res = await fetch(url, { method: 'DELETE', headers });
        if (!res.ok && res.status !== 404) {
            throw new Error(`R2 DELETE failed: ${res.status}`);
        }
    }

    /**
     * GET an object as a stream, passing `range` through (206 for a partial body). Null on 404.
     * Only Core talks to R2: callers stream the body on to theirs. Asks for the stored bytes as they
     * are: fetch offers gzip by default, R2 then compresses text and drops `content-length`.
     * `content_length` is null when R2 still doesn't say.
     */
    async get_object_stream(key: string, opts: { range?: string } = {}): Promise<{
        body: ReadableStream<Uint8Array>;
        status: 200 | 206;
        content_length: number | null;
        content_type: string;
        content_range?: string;
    } | null> {
        const headers = this._s3_headers('GET', key, 'UNSIGNED-PAYLOAD');
        if (opts.range) headers['range'] = opts.range;
        headers['accept-encoding'] = 'identity';
        const res = await fetch(this._s3_url(key), { method: 'GET', headers });
        if (res.status === 404) return null;
        if (!(res.status === 200 || res.status === 206) || !res.body) {
            const text = await res.text();
            throw new Error(`R2 GET failed: ${res.status} ${text}`);
        }
        return {
            body: res.body,
            status: res.status as 200 | 206,
            content_length: res.headers.has('content-length') ? Number(res.headers.get('content-length')) : null,
            content_type: res.headers.get('content-type') ?? 'application/octet-stream',
            ...(res.headers.get('content-range') ? { content_range: res.headers.get('content-range')! } : {}),
        };
    }

    // ── S3 signing helpers ───────────────────────────────────────────

    /** Build SigV4 headers for a standard (non-presigned) request. */
    private _s3_headers(
        method: string,
        key: string,
        content_hash: string,
        extra: Record<string, string> = {},
    ): Record<string, string> {
        const date_stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
        const headers: Record<string, string> = {
            host: new URL(this._s3_url(key)).host,
            'x-amz-date': date_stamp,
            'x-amz-content-sha256': content_hash,
            ...extra,
        };
        headers['Authorization'] = sigv4_authorization({
            method,
            canonical_uri: `/${this._cfg.bucket}/${key}`,
            headers,
            payload_hash: content_hash,
            date_stamp,
            region: 'auto',
            service: 's3',
            access_key_id: this._cfg.access_key_id,
            secret_access_key: this._cfg.secret_access_key,
        });
        return headers;
    }

    /** Full S3-compatible URL for an object key. */
    private _s3_url(key: string): string {
        return `${this._cfg.endpoint}/${this._cfg.bucket}/${key}`;
    }
}

/**
 * The SigV4 `Authorization` header for a request (AWS Signature Version 4, header form). Every
 * header in `headers` is signed; `date_stamp` is `YYYYMMDDTHHMMSSZ` and must match `x-amz-date`.
 * Pure, so it is checked against AWS's published examples.
 */
export function sigv4_authorization(input: {
    method: string;
    canonical_uri: string;
    headers: Readonly<Record<string, string>>;
    payload_hash: string;
    date_stamp: string;
    region: string;
    service: string;
    access_key_id: string;
    secret_access_key: string;
}): string {
    const short_date = input.date_stamp.slice(0, 8);
    const scope = `${short_date}/${input.region}/${input.service}/aws4_request`;
    const lower = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
    const signed_keys = Object.keys(lower).sort();
    const signed_headers = signed_keys.join(';');
    const canonical_headers = signed_keys.map((k) => `${k}:${lower[k]}\n`).join('');
    const canonical = [input.method, input.canonical_uri, '', canonical_headers, signed_headers, input.payload_hash].join('\n');
    const canonical_hash = crypto.createHash('sha256').update(canonical).digest('hex');
    const string_to_sign = ['AWS4-HMAC-SHA256', input.date_stamp, scope, canonical_hash].join('\n');

    const hmac = (k: Buffer | string, data: string): Buffer => crypto.createHmac('sha256', k).update(data).digest();
    const k_signing = hmac(hmac(hmac(hmac(`AWS4${input.secret_access_key}`, short_date), input.region), input.service), 'aws4_request');
    const signature = crypto.createHmac('sha256', k_signing).update(string_to_sign).digest('hex');
    return `AWS4-HMAC-SHA256 Credential=${input.access_key_id}/${scope}, SignedHeaders=${signed_headers}, Signature=${signature}`;
}
