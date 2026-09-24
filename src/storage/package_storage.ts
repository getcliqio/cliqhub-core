import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SLUG_PATTERN } from '../config/env.js';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

export interface StorageConfig {
    packages_path: string;
    storage_backend: 'local' | 'r2';
    s3_endpoint: string;
    s3_bucket: string;
    s3_access_key_id: string;
    s3_secret_access_key: string;
}

export function package_key(team_name: string, version: string): string {
    if (!SLUG_PATTERN.test(team_name)) throw new Error(`Invalid team name: ${team_name}`);
    if (!SEMVER_PATTERN.test(version)) throw new Error(`Invalid version: ${version}`);
    return `${team_name}-${version}.zip`;
}

export function package_path(packages_path: string, team_name: string, version: string): string {
    return path.resolve(packages_path, package_key(team_name, version));
}

function ensure_dir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function local_write(packages_path: string, key: string, data: Buffer): void {
    ensure_dir(packages_path);
    fs.writeFileSync(path.resolve(packages_path, key), data);
}

function local_read(packages_path: string, key: string): Buffer | null {
    try {
        return fs.readFileSync(path.resolve(packages_path, key));
    } catch {
        return null;
    }
}

function local_delete(packages_path: string, key: string): void {
    try {
        fs.unlinkSync(path.resolve(packages_path, key));
    } catch { /* may not exist */ }
}

function s3_headers(cfg: StorageConfig, method: string, key: string, content_hash: string, extra: Record<string, string> = {}): Record<string, string> {
    const now = new Date();
    const date_stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
    const short_date = date_stamp.slice(0, 8);
    const region = 'auto';
    const service = 's3';
    const scope = `${short_date}/${region}/${service}/aws4_request`;

    const url = new URL(`${cfg.s3_endpoint}/${cfg.s3_bucket}/${key}`);
    const host = url.host;

    const headers: Record<string, string> = { host, 'x-amz-date': date_stamp, 'x-amz-content-sha256': content_hash, ...extra };
    const signed_header_keys = Object.keys(headers).sort();
    const signed_headers = signed_header_keys.join(';');
    const canonical_headers = signed_header_keys.map(k => `${k}:${headers[k]}\n`).join('');

    const canonical = [method, `/${cfg.s3_bucket}/${key}`, '', canonical_headers, signed_headers, content_hash].join('\n');
    const canonical_hash = crypto.createHash('sha256').update(canonical).digest('hex');
    const string_to_sign = ['AWS4-HMAC-SHA256', date_stamp, scope, canonical_hash].join('\n');

    function hmac(k: Buffer | string, data: string): Buffer {
        return crypto.createHmac('sha256', k).update(data).digest();
    }

    const k_date = hmac(`AWS4${cfg.s3_secret_access_key}`, short_date);
    const k_region = hmac(k_date, region);
    const k_service = hmac(k_region, service);
    const k_signing = hmac(k_service, 'aws4_request');
    const signature = crypto.createHmac('sha256', k_signing).update(string_to_sign).digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${cfg.s3_access_key_id}/${scope}, SignedHeaders=${signed_headers}, Signature=${signature}`;
    return headers;
}

function s3_url(cfg: StorageConfig, key: string): string {
    return `${cfg.s3_endpoint}/${cfg.s3_bucket}/${key}`;
}

export function create_package_storage(cfg: StorageConfig) {
    async function write(key: string, data: Buffer): Promise<void> {
        if (cfg.storage_backend === 'r2') {
            const content_hash = crypto.createHash('sha256').update(data).digest('hex');
            const headers = s3_headers(cfg, 'PUT', key, content_hash, {
                'content-type': 'application/zip',
                'content-length': String(data.length),
            });
            const res = await fetch(s3_url(cfg, key), { method: 'PUT', headers, body: new Uint8Array(data) });
            if (!res.ok) throw new Error(`R2 PUT failed: ${res.status}`);
            return;
        }
        local_write(cfg.packages_path, key, data);
    }

    async function read(key: string): Promise<Buffer | null> {
        if (cfg.storage_backend === 'r2') {
            const content_hash = 'UNSIGNED-PAYLOAD';
            const headers = s3_headers(cfg, 'GET', key, content_hash);
            const res = await fetch(s3_url(cfg, key), { method: 'GET', headers });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`R2 GET failed: ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        }
        return local_read(cfg.packages_path, key);
    }

    async function del(key: string): Promise<void> {
        if (cfg.storage_backend === 'r2') {
            const content_hash = 'UNSIGNED-PAYLOAD';
            const headers = s3_headers(cfg, 'DELETE', key, content_hash);
            const res = await fetch(s3_url(cfg, key), { method: 'DELETE', headers });
            if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE failed: ${res.status}`);
            return;
        }
        local_delete(cfg.packages_path, key);
    }

    return { write, read, delete: del };
}

export type PackageStorage = ReturnType<typeof create_package_storage>;
