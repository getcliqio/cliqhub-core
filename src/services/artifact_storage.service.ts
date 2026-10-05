/**
 * ArtifactStorageService — stores and retrieves deliverable artifacts
 * in R2 (S3-compatible) and manages metadata in the stored_artifacts table.
 *
 * Delegates R2 operations to R2Client and DB operations to
 * StoredArtifactRepository.
 */

import { v4 as uuid_v4 } from 'uuid';

import { R2Client, load_r2_config_from_env } from '../lib/r2_client.js';
import { StoredArtifactRepository } from '../repositories/stored_artifact_repository.js';
import { RunArtifactRepository } from '../repositories/run_artifact_repository.js';
import type { StoredArtifactAttributes } from '../models/stored_artifact.model.js';
import { ApiError } from '../errors/api_error.js';
import type { ArtifactsSubmitInput, ArtifactData, ArtifactsSubmitOutput } from '../schemas/artifacts_schemas.js';
import { get_logger } from '../lib/log.js';

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
     * Upload artifact content to R2 and create a metadata row.
     * Returns the artifact record with a presigned download URL.
     */
    async submit(
        input: ArtifactsSubmitInput,
        uploaded_by?: string,
    ): Promise<ArtifactsSubmitOutput> {
        log.debug('submit', { run_id: input.run_id, name: input.name, uploaded_by });
        // Decode content to a Buffer for size checking and R2 upload.
        const buf = input.encoding === 'base64'
            ? Buffer.from(input.content, 'base64')
            : Buffer.from(input.content, 'utf8');

        const max_bytes = this._max_size_mb * 1024 * 1024;
        if (buf.length > max_bytes) {
            throw new ApiError('artifact_too_large', `Artifact too large: ${buf.length} bytes exceeds ${this._max_size_mb} MB limit`, 413);
        }

        if (!this._r2.is_configured) {
            throw new ApiError('storage_not_configured', 'R2 storage not configured (S3_ENDPOINT missing)');
        }

        const artifact_id = uuid_v4();
        const storage_key = artifact_id;
        const mime_type = input.mime_type || 'application/octet-stream';
        const now = Date.now();

        // Upload to R2.
        await this._r2.put_object(storage_key, buf, mime_type);

        // Create metadata row.
        await this._repo.create({
            id: artifact_id,
            run_id: input.run_id,
            phase: input.phase,
            name: input.name,
            description: input.description ?? null,
            mime_type,
            size_bytes: buf.length,
            storage_key,
            uploaded_by: uploaded_by ?? null,
            created_at: now,
        });

        const download_url = this._r2.presigned_get_url(storage_key);
        log.info('artifact_created', { artifact_id, run_id: input.run_id, name: input.name, size_bytes: buf.length });

        return {
            artifact_id,
            name: input.name,
            download_url,
            size_bytes: buf.length,
        };
    }

    /**
     * List artifacts for a run, optionally filtered by phase.
     * Each entry includes a fresh presigned download URL.
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
     * Fetch a single artifact by ID with a fresh presigned URL.
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

    /** Map a DB row to the API response shape with a fresh presigned URL. */
    private _to_artifact_data(row: StoredArtifactAttributes): ArtifactData {
        return {
            artifact_id: row.id,
            run_id: row.run_id,
            phase: row.phase,
            name: row.name,
            description: row.description,
            mime_type: row.mime_type,
            size_bytes: Number(row.size_bytes),
            download_url: this._r2.is_configured ? this._r2.presigned_get_url(row.storage_key) : '',
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
