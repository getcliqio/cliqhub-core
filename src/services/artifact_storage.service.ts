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

import { object_store_from_env, type ObjectStore } from '../lib/local_object_store.js';
import { StoredArtifactRepository } from '../repositories/stored_artifact_repository.js';
import { RunArtifactRepository } from '../repositories/run_artifact_repository.js';
import type { StoredArtifactAttributes } from '../models/stored_artifact.model.js';
import { ApiError } from '../errors/api_error.js';
import type { ArtifactData } from '../schemas/artifacts_schemas.js';
import { get_logger } from '../lib/log.js';
import { public_a2a_base_url } from '../mesh/settings_util.js';

const log = get_logger('svc.artifact_storage');

export class ArtifactStorageService {
    /** R2 in production; local disk on a CliqHub without it (the dev stack, PLAN-team-bundle S6). */
    private readonly _r2: ObjectStore;
    private readonly _repo: StoredArtifactRepository;
    private readonly _records: RunArtifactRepository;
    private readonly _max_size_mb: number;

    constructor(opts?: { r2?: ObjectStore; repo?: StoredArtifactRepository; records?: RunArtifactRepository; max_size_mb?: number }) {
        this._r2 = opts?.r2 ?? object_store_from_env();
        this._repo = opts?.repo ?? new StoredArtifactRepository();
        this._records = opts?.records ?? new RunArtifactRepository();
        this._max_size_mb = opts?.max_size_mb ?? parseInt(process.env.CLIQ_ARTIFACT_MAX_MB || '50', 10);
    }

    /**
     * Stream one file in and store it in R2 (PLAN-hug-requests §6.6.3) — the daemon's run artifacts, and the files
     * people send in getHugs answers (`hug_answer`, PLAN-gethugs-step5-files.md).
     *
     * The body is hashed and counted while it is written to a temp file; it is refused (413) the
     * moment it passes the limit, or if it doesn't match its declared length.
     */
    async upload(input: UploadInput): Promise<UploadOutput> {
        if (!this._r2.is_configured) throw new ApiError('ARTIFACT_STORAGE_UNAVAILABLE', 'File storage is not configured', 503);
        const target = input.target;
        const limit = this._max_size_mb * 1024 * 1024;
        if (!Number.isFinite(input.content_length) || input.content_length < 0) {
            throw new ApiError('ARTIFACT_LENGTH_REQUIRED', 'Content-Length is required', 411);
        }
        if (input.content_length > limit) throw too_large(limit);

        const tmp = await spool_to_temp(input.stream, Math.min(limit, input.content_length));
        try {
            if (tmp.size !== input.content_length) {
                throw new ApiError('invalid_request', `Body was ${tmp.size} bytes, not the declared ${input.content_length}`, 400);
            }
            const mime_type = input.content_type || 'application/octet-stream';

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
                source: target.kind === 'run' ? 'daemon' : 'hug',
                hug_id: target.kind === 'run' ? null : target.hug_id,
                hug_requested_input: target.kind === 'run' ? null : target.requested_input,
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
                download_url: download_url_for(artifact_id),
            };
        } finally {
            await fs.promises.rm(tmp.path, { force: true });
        }
    }

    /**
     * Stream one stored file out of R2 (§6.6.4). Throws 404 when there is no such file.
     */
    async download(artifact_id: string, range?: string): Promise<DownloadOutput> {
        const row = /^[0-9a-f-]{36}$/i.test(artifact_id) ? await this._repo.find_by_id(artifact_id) : null;
        if (!row) {
            throw new ApiError('not_found', `Artifact '${artifact_id}' not found`, 404);
        }
        if (!this._r2.is_configured) throw new ApiError('ARTIFACT_STORAGE_UNAVAILABLE', 'File storage is not configured', 503);
        const object = await this._r2.get_object_stream(row.storage_key, range ? { range } : {});
        if (!object) throw new ApiError('not_found', `Artifact '${artifact_id}' not found`, 404);
        return { ...object, name: row.name, mime_type: row.mime_type };
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

/** Where upload bodies are spooled before they go to R2. */
const TEMP_DIR = path.join(os.tmpdir(), 'cliq-uploads');

/** Where an upload belongs: a run artifact (daemon) or a file sent in a getHugs answer. */
export type UploadTarget =
    | { kind: 'run'; run_id: string; phase: string }
    /**
     * A file someone sent in an answer through getHugs (PLAN-gethugs-step5-files.md): getHugs checked it against the
     * slot; it is stored ready, as a `hug` file of the Hug and slot.
     */
    | { kind: 'hug_answer'; run_id: string; phase: string; hug_id: string; requested_input: string };

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
async function spool_to_temp(stream: Readable, max: number): Promise<{ path: string; size: number; sha256: string }> {
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    const file = path.join(TEMP_DIR, `${uuid_v4()}.part`);
    const out = fs.createWriteStream(file);
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
        for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += buf.length;
            if (size > max) {
                stream.destroy();
                throw too_large(max);
            }
            hash.update(buf);
            if (!out.write(buf)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
        return { path: file, size, sha256: hash.digest('hex') };
    } catch (err) {
        out.destroy();
        await fs.promises.rm(file, { force: true });
        throw err;
    }
}
