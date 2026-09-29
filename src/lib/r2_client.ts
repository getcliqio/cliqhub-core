/**
 * R2Client — reusable S3-compatible storage client for Cloudflare R2.
 *
 * Provides `put_object`, `delete_object`, and `presigned_get_url` with
 * AWS Signature V4 signing. No external dependencies — uses Node crypto
 * and global fetch.
 */

import crypto from 'node:crypto';

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
     * PUT an object to R2.
     * Throws on non-2xx response.
     */
    async put_object(key: string, data: Buffer, content_type: string): Promise<void> {
        const content_hash = crypto.createHash('sha256').update(data).digest('hex');
        const headers = this._s3_headers('PUT', key, content_hash, {
            'content-type': content_type,
            'content-length': String(data.length),
        });
        const url = this._s3_url(key);
        const res = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(data) });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`R2 PUT failed: ${res.status} ${body}`);
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
     * Generate a presigned GET URL for an R2 object.
     * Uses query-string auth (AWS Signature V4) with configurable TTL.
     */
    presigned_get_url(key: string, ttl_seconds = 300): string {
        const now = new Date();
        const date_stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
        const short_date = date_stamp.slice(0, 8);
        const region = 'auto';
        const scope = `${short_date}/${region}/s3/aws4_request`;

        const url = new URL(this._s3_url(key));
        const host = url.host;

        const params = new URLSearchParams({
            'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
            'X-Amz-Credential': `${this._cfg.access_key_id}/${scope}`,
            'X-Amz-Date': date_stamp,
            'X-Amz-Expires': String(ttl_seconds),
            'X-Amz-SignedHeaders': 'host',
        });
        params.sort();

        const canonical = [
            'GET',
            url.pathname,
            params.toString(),
            `host:${host}\n`,
            'host',
            'UNSIGNED-PAYLOAD',
        ].join('\n');

        const canonical_hash = crypto.createHash('sha256').update(canonical).digest('hex');
        const string_to_sign = ['AWS4-HMAC-SHA256', date_stamp, scope, canonical_hash].join('\n');
        const signature = this._sign(short_date, string_to_sign);

        params.set('X-Amz-Signature', signature);
        return `${url.origin}${url.pathname}?${params.toString()}`;
    }

    // ── S3 signing helpers ───────────────────────────────────────────

    /** Build SigV4 headers for a standard (non-presigned) request. */
    private _s3_headers(
        method: string,
        key: string,
        content_hash: string,
        extra: Record<string, string> = {},
    ): Record<string, string> {
        const now = new Date();
        const date_stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
        const short_date = date_stamp.slice(0, 8);
        const region = 'auto';
        const scope = `${short_date}/${region}/s3/aws4_request`;

        const url = new URL(this._s3_url(key));
        const host = url.host;

        const headers: Record<string, string> = {
            host,
            'x-amz-date': date_stamp,
            'x-amz-content-sha256': content_hash,
            ...extra,
        };
        const signed_keys = Object.keys(headers).sort();
        const signed_headers = signed_keys.join(';');
        const canonical_headers = signed_keys.map(k => `${k}:${headers[k]}\n`).join('');

        const canonical = [method, `/${this._cfg.bucket}/${key}`, '', canonical_headers, signed_headers, content_hash].join('\n');
        const canonical_hash = crypto.createHash('sha256').update(canonical).digest('hex');
        const string_to_sign = ['AWS4-HMAC-SHA256', date_stamp, scope, canonical_hash].join('\n');

        headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${this._cfg.access_key_id}/${scope}, SignedHeaders=${signed_headers}, Signature=${this._sign(short_date, string_to_sign)}`;
        return headers;
    }

    /** Derive SigV4 signing key and sign the string. */
    private _sign(short_date: string, string_to_sign: string): string {
        const hmac = (k: Buffer | string, data: string): Buffer =>
            crypto.createHmac('sha256', k).update(data).digest();

        const k_date = hmac(`AWS4${this._cfg.secret_access_key}`, short_date);
        const k_region = hmac(k_date, 'auto');
        const k_service = hmac(k_region, 's3');
        const k_signing = hmac(k_service, 'aws4_request');
        return crypto.createHmac('sha256', k_signing).update(string_to_sign).digest('hex');
    }

    /** Full S3-compatible URL for an object key. */
    private _s3_url(key: string): string {
        return `${this._cfg.endpoint}/${this._cfg.bucket}/${key}`;
    }
}
