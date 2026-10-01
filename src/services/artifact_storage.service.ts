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
import type { StoredArtifactAttributes } from '../models/stored_artifact.model.js';
import { ApiError } from '../errors/api_error.js';
import type { ArtifactsSubmitInput, ArtifactData, ArtifactsSubmitOutput } from '../schemas/artifacts_schemas.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.artifact_storage');

export class ArtifactStorageService {
    private readonly _r2: R2Client;
    private readonly _repo: StoredArtifactRepository;
    private readonly _max_size_mb: number;

    constructor(opts?: { r2?: R2Client; repo?: StoredArtifactRepository; max_size_mb?: number }) {
        this._r2 = opts?.r2 ?? new R2Client(load_r2_config_from_env());
        this._repo = opts?.repo ?? new StoredArtifactRepository();
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
    async get(run_id: string, phase?: string): Promise<ArtifactData[]> {
        log.debug('get', { run_id, phase });
        const rows = await this._repo.find_by_run(run_id, phase);
        return rows.map(r => this._to_artifact_data(r));
    }

    /**
     * Fetch a single artifact by ID with a fresh presigned URL.
     * Throws 404 when not found.
     */
    async get_by_id(artifact_id: string): Promise<ArtifactData> {
        log.debug('get_by_id', { artifact_id });
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
        };
    }
}
