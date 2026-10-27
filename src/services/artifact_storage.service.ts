/**
 * ArtifactStorageService — stores and retrieves deliverable artifacts
 * in R2 (S3-compatible) and manages metadata in the stored_artifacts table.
 *
 * Delegates R2 operations to R2Client and DB operations to
 * StoredArtifactRepository.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { v4 as uuid_v4 } from 'uuid';
import { FILE_SNIFF_BYTES, file_accept_problem } from '@getcliqio/cliq-sdk';

import { R2Client, load_r2_config_from_env } from '../lib/r2_client.js';
import { StoredArtifactRepository } from '../repositories/stored_artifact_repository.js';
import { RunArtifactRepository } from '../repositories/run_artifact_repository.js';
import type { StoredArtifactAttributes } from '../models/stored_artifact.model.js';
import { ApiError } from '../errors/api_error.js';
import type { ArtifactData } from '../schemas/artifacts_schemas.js';
import { get_logger } from '../lib/log.js';
import { public_a2a_base_url } from '../mesh/settings_util.js';

const log = get_logger('svc.artifact_storage');

export class ArtifactStorageService {
    private readonly _r2: R2Client;
    private readonly _repo: StoredArtifactRepository;
    private readonly _records: RunArtifactRepository;
    private readonly _max_size_mb: number;

    constructor(opts?: { r2?: R2Client; repo?: StoredArtifactRepository; records?: RunArtifactRepository; max_size_mb?: number }) {
        this._r2 = opts?.r2 ?? new R2Client(load_r2_config_from_env());
        this._repo = opts?.repo ?? new StoredArtifactRepository();
        this._records = opts?.records ?? new RunArtifactRepository();
        this._max_size_mb = opts?.max_size_mb ?? parseInt(process.env.CLIQ_ARTIFACT_MAX_MB || '50', 10);
    }

    /**
     * Stream one file in and store it in R2 (PLAN-hug-requests §6.6.3) — the only upload path, for
     * the daemon's run artifacts and for a Hug responder's `file` input alike.
     *
     * The body is hashed and counted while it is written to a temp file; it is refused (413) the
     * moment it passes the limit, or if it doesn't match its declared length. A Hug upload is
     * checked against its input's `accept` (declared type, extension and leading bytes) and stored
     * `pending` until a response uses it.
     */
    async upload(input: UploadInput): Promise<UploadOutput> {
        if (!this._r2.is_configured) throw new ApiError('ARTIFACT_STORAGE_UNAVAILABLE', 'File storage is not configured', 503);
        const target = input.target;
        const limit = Math.min(this._max_size_mb * 1024 * 1024, target.kind === 'hug' ? (target.max_bytes ?? Infinity) : Infinity);
        if (!Number.isFinite(input.content_length) || input.content_length < 0) {
            throw new ApiError('ARTIFACT_LENGTH_REQUIRED', 'Content-Length is required', 411);
        }
        if (input.content_length > limit) throw too_large(limit);
        if (target.kind === 'hug' && target.pending_count >= MAX_PENDING_PER_RESPONDER) {
            throw new ApiError('HUG_FILE_INVALID', `At most ${MAX_PENDING_PER_RESPONDER} files may wait for a response`, 422);
        }

        const tmp = await spool_to_temp(input.stream, Math.min(limit, input.content_length));
        try {
            if (tmp.size !== input.content_length) {
                throw new ApiError('invalid_request', `Body was ${tmp.size} bytes, not the declared ${input.content_length}`, 400);
            }
            const mime_type = input.content_type || 'application/octet-stream';
            if (target.kind === 'hug' && target.accept?.length) {
                const problem = accept_problem(target.accept, input.name, mime_type, tmp.head);
                if (problem) throw new ApiError('HUG_FILE_INVALID', `${target.requested_input}: ${problem}`, 422);
            }

            const artifact_id = uuid_v4();
            await this._repo.create({
                id: artifact_id,
                run_id: target.run_id,
                phase: target.phase,
                name: input.name,
                description: input.description ?? null,
                mime_type,
                size_bytes: tmp.size,
                storage_key: artifact_id,
                uploaded_by: input.uploaded_by,
                created_at: Date.now(),
                status: target.kind === 'hug' ? 'pending' : 'ready',
                source: target.kind === 'hug' ? 'hug' : 'daemon',
                hug_id: target.kind === 'hug' ? target.hug_id : null,
                hug_requested_input: target.kind === 'hug' ? target.requested_input : null,
                sha256: tmp.sha256,
            });
            try {
                await this._r2.put_object_stream(artifact_id, fs.createReadStream(tmp.path), {
                    content_length: tmp.size, content_type: mime_type, sha256_hex: tmp.sha256,
                });
            } catch (err) {
                await this._repo.delete_by_id(artifact_id);
                log.error('artifact_store_failed', { artifact_id, error: err instanceof Error ? err.message : String(err) });
                throw new ApiError('ARTIFACT_STORE_FAILED', 'Storing the file failed — try again', 502);
            }
            log.info('artifact_uploaded', { artifact_id, run_id: target.run_id, source: target.kind, size_bytes: tmp.size });
            return {
                artifact_id,
                name: input.name,
                size: tmp.size,
                content_type: mime_type,
                sha256: tmp.sha256,
                status: target.kind === 'hug' ? 'pending' : 'ready',
                download_url: download_url_for(artifact_id),
            };
        } finally {
            await fs.promises.rm(tmp.path, { force: true });
        }
    }

    /**
     * Stream one stored file out of R2 (§6.6.4). A pending upload is visible only to its uploader.
     * Throws 404 when there is no such file (or the caller may not see a pending one).
     */
    async download(artifact_id: string, caller_user_id: string | null, range?: string): Promise<DownloadOutput> {
        const row = /^[0-9a-f-]{36}$/i.test(artifact_id) ? await this._repo.find_by_id(artifact_id) : null;
        if (!row || (row.status === 'pending' && row.uploaded_by !== caller_user_id)) {
            throw new ApiError('not_found', `Artifact '${artifact_id}' not found`, 404);
        }
        if (!this._r2.is_configured) throw new ApiError('ARTIFACT_STORAGE_UNAVAILABLE', 'File storage is not configured', 503);
        const object = await this._r2.get_object_stream(row.storage_key, range ? { range } : {});
        if (!object) throw new ApiError('not_found', `Artifact '${artifact_id}' not found`, 404);
        return { ...object, name: row.name, mime_type: row.mime_type };
    }

    /** Remove responder uploads never used in a response (older than 24h): the R2 object and the row (§6.6.8). */
    async delete_stale_pending(now = new Date()): Promise<number> {
        const stale = await this._repo.find_stale_pending(now.getTime() - PENDING_TTL_MS);
        for (const row of stale) {
            try {
                if (this._r2.is_configured) await this._r2.delete_object(row.storage_key);
                await this._repo.delete_by_id(row.id);
            } catch (err) {
                log.error('stale_pending_delete_failed', { artifact_id: row.id, error: err instanceof Error ? err.message : String(err) });
            }
        }
        if (stale.length > 0) log.info('stale_pending_deleted', { count: stale.length });
        return stale.length;
    }

    /**
     * List artifacts for a run, optionally filtered by phase.
     */
    async get(run_id: string, phase?: string, include_records = false): Promise<ArtifactData[]> {
        log.debug('get', { run_id, phase, include_records });
        const files = (await this._repo.find_by_run(run_id, phase)).map((r) => this._to_artifact_data(r));
        if (!include_records) return files;
        const records = await this._records.find_all_q({
            where: { run_id, ...(phase ? { phase } : {}) },
            order: [['created_at', 'ASC']],
        });
        // One list in the order things were produced; the UI groups it by phase.
        return [...files, ...records.map((r) => record_to_artifact_data(r, false))]
            .sort((a, b) => a.created_at - b.created_at);
    }

    /**
     * Fetch a single artifact's metadata by ID.
     * Throws 404 when not found.
     */
    async get_by_id(artifact_id: string): Promise<ArtifactData> {
        log.debug('get_by_id', { artifact_id });
        if (artifact_id.startsWith('rec:')) {
            const id = artifact_id.slice(4);
            const rec = /^[0-9a-f-]{36}$/i.test(id) ? await this._records.find_one_q({ where: { id } }) : null;
            if (!rec) throw new ApiError('not_found', `Artifact '${artifact_id}' not found`);
            return record_to_artifact_data(rec, true);
        }
        const row = await this._repo.find_by_id(artifact_id);
        if (!row) throw new ApiError('not_found', `Artifact '${artifact_id}' not found`);

        return this._to_artifact_data(row);
    }

    /**
     * Delete an artifact — removes R2 object and metadata row.
     * No-ops silently when the artifact doesn't exist.
     */
    async delete(artifact_id: string): Promise<boolean> {
        log.debug('delete', { artifact_id });
        const row = await this._repo.find_by_id(artifact_id);
        if (!row) return false;

        if (this._r2.is_configured) {
            await this._r2.delete_object(row.storage_key);
        }
        await this._repo.delete_by_id(artifact_id);
        log.info('artifact_deleted', { artifact_id });
        return true;
    }

    /** Map a DB row to the API response shape (a Hub download URL — never an R2 one). */
    private _to_artifact_data(row: StoredArtifactAttributes): ArtifactData {
        return {
            artifact_id: row.id,
            run_id: row.run_id,
            phase: row.phase,
            name: row.name,
            description: row.description,
            mime_type: row.mime_type,
            size_bytes: Number(row.size_bytes),
            download_url: download_url_for(row.id),
            created_at: Number(row.created_at),
            source: 'file',
            kind: 'file',
            content_preview: null,
        };
    }
}

/** Characters of a record's text shown in a list. */
const RECORD_PREVIEW_CHARS = 2000;

/** A run record (`cliq.run_artifacts`) as an artifact; `full` adds its whole text. */
function record_to_artifact_data(
    row: { id: string; run_id: string; phase: string; kind: string; name: string; content: string | null; mime_type: string | null; created_at: number | string | Date },
    full: boolean,
): ArtifactData {
    const content = row.content ?? '';
    const created_at = row.created_at instanceof Date ? row.created_at.getTime() : Number(row.created_at);
    return {
        artifact_id: `rec:${row.id}`,
        source: 'record',
        kind: row.kind,
        run_id: row.run_id,
        phase: row.phase,
        name: row.name,
        description: null,
        mime_type: row.mime_type ?? 'text/plain',
        size_bytes: Buffer.byteLength(content, 'utf8'),
        download_url: null,
        content_preview: content.length > RECORD_PREVIEW_CHARS ? `${content.slice(0, RECORD_PREVIEW_CHARS)}\n…` : content,
        ...(full ? { content } : {}),
        created_at,
    };
}

/** Responder uploads not used in a response are removed after this long. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Most pending uploads one responder may have on one Hug. */
const MAX_PENDING_PER_RESPONDER = 20;
/** Where upload bodies are spooled before they go to R2. */
const TEMP_DIR = path.join(os.tmpdir(), 'cliq-uploads');

/** Where an upload belongs: a run artifact (daemon) or a Hug's `file` input (responder). */
export type UploadTarget =
    | { kind: 'run'; run_id: string; phase: string }
    | {
        kind: 'hug';
        run_id: string;
        phase: string;
        hug_id: string;
        requested_input: string;
        accept?: string[];
        max_bytes?: number;
        /** This responder's pending uploads on the Hug so far. */
        pending_count: number;
    };

/** Input to {@link ArtifactStorageService.upload}. */
export interface UploadInput {
    stream: Readable;
    content_length: number;
    content_type: string;
    name: string;
    description?: string;
    target: UploadTarget;
    uploaded_by: string | null;
}

/** What an upload returns. */
export interface UploadOutput {
    artifact_id: string;
    name: string;
    size: number;
    content_type: string;
    sha256: string;
    status: 'pending' | 'ready';
    download_url: string;
}

/** A stored file being streamed out. */
export interface DownloadOutput {
    body: ReadableStream<Uint8Array>;
    status: 200 | 206;
    /** Null when storage didn't say: the response is then sent without Content-Length. */
    content_length: number | null;
    content_type: string;
    content_range?: string;
    name: string;
    mime_type: string;
}

/**
 * Delete upload temp files older than an hour — left behind when Core stopped mid-upload (§6.6.3).
 * Run once at startup. Best effort.
 *
 * @returns how many were deleted
 */
export async function remove_stale_upload_files(now = Date.now(), dir = TEMP_DIR): Promise<number> {
    let names: string[];
    try {
        names = await fs.promises.readdir(dir);
    } catch {
        // No temp dir yet: nothing was ever spooled.
        return 0;
    }
    let removed = 0;
    for (const name of names) {
        const file = path.join(dir, name);
        try {
            const st = await fs.promises.stat(file);
            if (st.isFile() && now - st.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
                await fs.promises.rm(file, { force: true });
                removed++;
            }
        } catch (err) {
            log.warn('stale_upload_file_delete_failed', { file: name, error: err instanceof Error ? err.message : String(err) });
        }
    }
    if (removed > 0) log.info('stale_upload_files_deleted', { count: removed });
    return removed;
}

/** Upload temp files older than this are leftovers of a crash. */
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;

/** The Hub URL a stored file downloads from (§6.6.9) — R2 is never exposed. */
export function download_url_for(artifact_id: string): string {
    return `${public_a2a_base_url()}/v1/artifacts/download?artifact_id=${encodeURIComponent(artifact_id)}`;
}

function too_large(limit: number): ApiError {
    return new ApiError('ARTIFACT_TOO_LARGE', `File is larger than the ${Math.floor(limit / (1024 * 1024)) || limit} ${limit >= 1024 * 1024 ? 'MB' : 'byte'} limit`, 413);
}

/** Write a body to a temp file, hashing and counting it; abort as soon as it passes `max`. */
async function spool_to_temp(stream: Readable, max: number): Promise<{ path: string; size: number; sha256: string; head: Buffer }> {
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    const file = path.join(TEMP_DIR, `${uuid_v4()}.part`);
    const out = fs.createWriteStream(file);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const head_chunks: Buffer[] = [];
    let head_len = 0;
    try {
        for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += buf.length;
            if (size > max) {
                stream.destroy();
                throw too_large(max);
            }
            hash.update(buf);
            if (head_len < SNIFF_BYTES) {
                head_chunks.push(buf.subarray(0, SNIFF_BYTES - head_len));
                head_len += Math.min(buf.length, SNIFF_BYTES - head_len);
            }
            if (!out.write(buf)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
        return { path: file, size, sha256: hash.digest('hex'), head: Buffer.concat(head_chunks) };
    } catch (err) {
        out.destroy();
        await fs.promises.rm(file, { force: true });
        throw err;
    }
}

/** Bytes read for type sniffing (the SDK's rule looks at this many). */
const SNIFF_BYTES = FILE_SNIFF_BYTES;

/**
 * Why a file fails an input's `accept`, or null — the SDK's one rule for files given to a `file`
 * input (cliqd checks local answers with it too): its declared type or extension must match an
 * entry, an executable is only accepted when an entry names its type, and recognisable leading
 * bytes must agree with an accepted type (so a renamed program isn't taken as a PDF).
 */
export function accept_problem(accept: readonly string[], name: string, declared_type: string, head: Buffer): string | null {
    return file_accept_problem(accept, name, declared_type, head);
}
