import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SLUG_PATTERN } from '../config/env.js';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

export interface StorageConfig {
    packages_path: string;
    storage_backend: 'local' | 'r2';
    s3_endpoint: string;
    s3_teams_bucket: string;
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

/* A team in storage is a folder keyed by its id (PLAN-team-bundle §2.2):
 *   teams/<team_id>/files/<file_id>            one uploaded file's bytes (its row is in cliq.team_files)
 *   teams/<team_id>/versions/<version_id>.zip  a published version's zip, built on first download */

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assert_id(kind: string, id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid ${kind} id: ${id}`);
}

/** `teams/<team_id>/` — everything stored for one team. */
export function team_prefix(team_id: string): string {
    assert_id('team', team_id);
    return `teams/${team_id}/`;
}

/** `teams/<team_id>/files/<file_id>` — one uploaded file's bytes, named by its id (never overwritten). */
export function team_file_key(team_id: string, file_id: string): string {
    assert_id('file', file_id);
    return `${team_prefix(team_id)}files/${file_id}`;
}

/** `teams/<team_id>/versions/<version_id>.zip` — one published version. */
export function version_zip_key(team_id: string, version_id: string): string {
    assert_id('version', version_id);
    return `${team_prefix(team_id)}versions/${version_id}.zip`;
}

/**
 * The storage key a version row points at: `teams/<team_id>/versions/<version_id>.zip`. The startup move
 * (S1.2) put every existing zip there; anything else (a version that never had a zip) has none.
 */
export function stored_key(package_path: string): string | null {
    return package_path.startsWith('teams/') ? package_path : null;
}

/** A key or relative path that stays inside its folder (no `..`, no leading `/`, no backslash). */
function assert_safe_key(key: string): void {
    if (!key || key.startsWith('/') || key.includes('\\') || key.split('/').some((part) => part === '..' || part === '')) {
        throw new Error(`Invalid storage key: ${key}`);
    }
}

function ensure_dir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function local_write(packages_path: string, key: string, data: Buffer): void {
    const file = path.resolve(packages_path, key);
    ensure_dir(path.dirname(file));
    fs.writeFileSync(file, data);
}

/** Every key under `prefix` (a folder ending in `/`), sorted. */
function local_list(packages_path: string, prefix: string): string[] {
    const root = path.resolve(packages_path, prefix);
    if (!fs.existsSync(root)) return [];
    const keys: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else keys.push(path.relative(path.resolve(packages_path), full).split(path.sep).join('/'));
        }
    };
    walk(root);
    return keys.sort();
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

/** A key as a URL path: each segment percent-encoded (`/` kept). Plain keys (`a-1.0.0.zip`) are unchanged. */
function encode_key(key: string): string {
    return key.split('/').map(encodeURIComponent).join('/');
}

/** A sorted, percent-encoded query string, as SigV4 signs it. */
function canonical_query(query: Record<string, string>): string {
    return Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
}

function s3_headers(cfg: StorageConfig, method: string, key: string, content_hash: string, extra: Record<string, string> = {}, query: Record<string, string> = {}): Record<string, string> {
    const now = new Date();
    const date_stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
    const short_date = date_stamp.slice(0, 8);
    const region = 'auto';
    const service = 's3';
    const scope = `${short_date}/${region}/${service}/aws4_request`;

    const url = new URL(s3_url(cfg, key));
    const host = url.host;

    const headers: Record<string, string> = { host, 'x-amz-date': date_stamp, 'x-amz-content-sha256': content_hash, ...extra };
    const signed_header_keys = Object.keys(headers).sort();
    const signed_headers = signed_header_keys.join(';');
    const canonical_headers = signed_header_keys.map(k => `${k}:${headers[k]}\n`).join('');

    const canonical = [method, `/${cfg.s3_teams_bucket}/${encode_key(key)}`, canonical_query(query), canonical_headers, signed_headers, content_hash].join('\n');
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

function s3_url(cfg: StorageConfig, key: string, query: Record<string, string> = {}): string {
    const q = canonical_query(query);
    return `${cfg.s3_endpoint}/${cfg.s3_teams_bucket}/${encode_key(key)}${q ? `?${q}` : ''}`;
}

/** The text of every `<tag>…</tag>` in an S3 XML reply (entities decoded). */
function xml_values(xml: string, tag: string): string[] {
    const out: string[] = [];
    const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g');
    for (let m = re.exec(xml); m; m = re.exec(xml)) {
        out.push(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
    }
    return out;
}

export function create_package_storage(cfg: StorageConfig) {
    async function write(key: string, data: Buffer, content_type = 'application/zip'): Promise<void> {
        if (cfg.storage_backend === 'r2') {
            const content_hash = crypto.createHash('sha256').update(data).digest('hex');
            const headers = s3_headers(cfg, 'PUT', key, content_hash, {
                'content-type': content_type,
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

    /** Every key under `prefix` (a folder ending in `/`), sorted. */
    async function list(prefix: string): Promise<string[]> {
        assert_safe_key(prefix.replace(/\/$/, ''));
        if (cfg.storage_backend !== 'r2') return local_list(cfg.packages_path, prefix);
        const keys: string[] = [];
        let token: string | undefined;
        do {
            const query: Record<string, string> = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
            const headers = s3_headers(cfg, 'GET', '', 'UNSIGNED-PAYLOAD', {}, query);
            const res = await fetch(s3_url(cfg, '', query), { method: 'GET', headers });
            if (!res.ok) throw new Error(`R2 LIST failed: ${res.status}`);
            const xml = await res.text();
            keys.push(...xml_values(xml, 'Key'));
            token = xml_values(xml, 'IsTruncated')[0] === 'true' ? xml_values(xml, 'NextContinuationToken')[0] : undefined;
        } while (token);
        return keys.sort();
    }

    /** Remove every file under `prefix`. */
    async function delete_prefix(prefix: string): Promise<void> {
        for (const key of await list(prefix)) await del(key);
    }

    return { write, read, delete: del, list, delete_prefix };
}

export type PackageStorage = ReturnType<typeof create_package_storage>;
