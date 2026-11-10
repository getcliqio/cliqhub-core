/**
 * Hug bundles — a hug's built frontend, stored once by its hash (PLAN-hug-widgets §11.1).
 *
 * A daemon opens a Hug naming its hug and the bundle's sha256. Core keeps each bundle once: when it
 * doesn't hold the hash, `hugs/create` answers 409 `BUNDLE_MISSING` and the daemon retries with the
 * bundle's files, which Core checks (hash, cliq-sdk's bundle rules) and stores in package storage under
 * `hug-bundles/<sha256>/`. Built-ins (`form`, `approval`) are ordinary hugs that ship in cliqd: they arrive
 * the same way. Bundles nothing uses any more are swept daily.
 */

import { check_hug_bundle, hug_bundle_hash } from '@getcliqio/cliq-sdk';

import { ApiError as DetailedApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import { get_sequelize } from '../db/sequelize.js';
import { HugBundle } from '../models/index.js';
import type { PackageStorage } from '../storage/package_storage.js';

const log = get_logger('svc.hug_bundles');

/** How long a closed Hug keeps its bundle (§11.1 item 9). */
export const BUNDLE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** A bundle stored this recently is never swept (its Hug may still be opening). */
const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

const CONTENT_TYPES: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    map: 'application/json; charset=utf-8',
    svg: 'image/svg+xml; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
};

let storage: PackageStorage | null = null;

/** Set the storage bundles live in (container startup; tests). */
export function init_hug_bundle_storage(s: PackageStorage): void {
    storage = s;
}

function store(): PackageStorage {
    if (!storage) throw new Error('hug_bundles: no storage (init_hug_bundle_storage was not called)');
    return storage;
}

/** The storage folder of a bundle. */
export function bundle_prefix(sha256: string): string {
    return `hug-bundles/${sha256}/`;
}

/** The content type a bundle file is served with. */
export function bundle_content_type(path: string): string {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return CONTENT_TYPES[ext] ?? 'text/plain; charset=utf-8';
}

/** A bundle path Core will store: relative, no `..`, no backslashes. */
function safe_path(path: string): boolean {
    return !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((s) => s === '' || s === '.' || s === '..');
}

/** What a Hug's envelope names. */
export interface HugRef {
    name: string;
    sha256: string;
}

/** Bundles kept by hash. */
export class HugBundlesService {
    /**
     * The sha256 a Hug opened with `hug` is stored under — uploading `bundle` first when Core doesn't
     * hold it yet.
     *
     * @throws 409 `BUNDLE_MISSING` `{ sha256 }` — Core doesn't hold it and no bundle came
     * @throws 403 `BUNDLE_REJECTED` — a bundle from a caller that may not upload one
     * @throws 422 `BUNDLE_INVALID` `{ problems }` — the bundle breaks the rules or doesn't hash to `sha256`
     */
    static async resolve(hug: HugRef, opts: { bundle?: Record<string, string>; may_upload: boolean; realm_id: string }): Promise<string> {
        const row = await HugBundle.findByPk(hug.sha256, { attributes: ['sha256', 'name'], raw: true });
        if (row) {
            await HugBundle.update({ last_used_at: new Date() }, { where: { sha256: hug.sha256 } });
            return hug.sha256;
        }
        if (!opts.bundle) {
            throw new DetailedApiError('BUNDLE_MISSING', `CliqHub doesn't have the bundle of hug '${hug.name}' yet — send it`, 409, { sha256: hug.sha256 });
        }
        if (!opts.may_upload) throw new DetailedApiError('BUNDLE_REJECTED', "Only a daemon of the Hug's realm can upload a hug's bundle", 403);
        await HugBundlesService._store(hug, opts.bundle, opts.realm_id);
        return hug.sha256;
    }

    /**
     * Check and store a bundle (idempotent by hash).
     *
     * @throws 422 `BUNDLE_INVALID` `{ problems }`
     */
    static async store(files: Record<string, string>, realm_id: string | null): Promise<{ sha256: string; name: string }> {
        const sha256 = hug_bundle_hash(files);
        const name = HugBundlesService._check(files, sha256, null);
        await HugBundlesService._store({ name, sha256 }, files, realm_id);
        return { sha256, name };
    }

    /** One file of a stored bundle, or null. */
    static async get_file(sha256: string, path: string): Promise<{ body: Buffer; content_type: string } | null> {
        if (!safe_path(path)) return null;
        const row = await HugBundle.findByPk(sha256, { attributes: ['sha256'], raw: true });
        if (!row) return null;
        const body = await store().read(`${bundle_prefix(sha256)}${path}`);
        return body ? { body, content_type: bundle_content_type(path) } : null;
    }

    /**
     * Delete bundles no Hug needs: none open and none closed within {@link BUNDLE_RETENTION_MS}. Bundles
     * stored in the last day stay. Returns how many went.
     */
    static async sweep_unused(now = new Date()): Promise<number> {
        const [rows] = await get_sequelize().query(`SELECT b."sha256" FROM cliq."hug_bundles" b
            WHERE b."created_at" < :grace
              AND NOT EXISTS (SELECT 1 FROM cliq."hugs" h WHERE h."hug_sha256" = b."sha256"
                  AND (h."status" = 'open' OR COALESCE(h."closed_at", h."created_at") > :keep_after))`, {
            replacements: { grace: new Date(now.getTime() - SWEEP_GRACE_MS), keep_after: new Date(now.getTime() - BUNDLE_RETENTION_MS) },
        }) as [Array<{ sha256: string }>, unknown];
        for (const { sha256 } of rows) {
            await store().delete_prefix(bundle_prefix(sha256));
            await HugBundle.destroy({ where: { sha256 } });
        }
        if (rows.length > 0) log.info('hug_bundles_swept', { count: rows.length });
        return rows.length;
    }

    /** The bundle's name (from hug.json) when it hashes to `sha256`, follows the rules and (if given) is `name`. */
    private static _check(files: Record<string, string>, sha256: string, name: string | null): string {
        const bad_paths = Object.keys(files).filter((p) => !safe_path(p));
        if (bad_paths.length > 0) throw invalid([`paths must be relative, without '..': ${bad_paths.slice(0, 5).join(', ')}`]);
        if (hug_bundle_hash(files) !== sha256) throw invalid([`the bundle doesn't hash to ${sha256}`]);
        const checked = check_hug_bundle(files);
        if (!checked.ok) throw invalid(checked.problems);
        if (name !== null && checked.manifest.name !== name) throw invalid([`hug.json names '${checked.manifest.name}', not '${name}'`]);
        return checked.manifest.name;
    }

    private static async _store(hug: HugRef, files: Record<string, string>, realm_id: string | null): Promise<void> {
        HugBundlesService._check(files, hug.sha256, hug.name);
        if (await HugBundle.findByPk(hug.sha256, { attributes: ['sha256'], raw: true })) return;
        const prefix = bundle_prefix(hug.sha256);
        let size = 0;
        for (const [path, text] of Object.entries(files)) {
            const body = Buffer.from(text, 'utf8');
            size += body.length;
            await store().write(`${prefix}${path}`, body, bundle_content_type(path));
        }
        const now = new Date();
        await HugBundle.findOrCreate({
            where: { sha256: hug.sha256 },
            defaults: { sha256: hug.sha256, name: hug.name, size_bytes: size, file_count: Object.keys(files).length, realm_id, created_at: now, last_used_at: now } as never,
        });
        log.info('hug_bundle_stored', { sha256: hug.sha256, name: hug.name, files: Object.keys(files).length, size, realm_id });
    }
}

function invalid(problems: string[]): DetailedApiError {
    return new DetailedApiError('BUNDLE_INVALID', `Invalid hug bundle: ${problems.slice(0, 5).join('; ')}`, 422, { problems });
}

