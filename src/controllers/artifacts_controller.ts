/**
 * Stored Artifacts controller — durable file storage for run outputs.
 *
 * Routes (1:1 with this controller):
 *   POST /v1/artifacts/submit     — daemon uploads artifact to R2
 *   POST /v1/artifacts/get        — list artifacts for a run
 *   POST /v1/artifacts/get_by_id  — single artifact + presigned URL
 *   POST /v1/artifacts/delete     — remove artifact (R2 + metadata)
 *
 * The submit endpoint accepts both JSON (base64 content) and
 * multipart/form-data (raw file) transports. The daemon chooses
 * multipart for files > 1 MB to avoid base64 bloat.
 *
 * Instance methods per implementation-standards.mdc.
 */

import { BaseController } from './base_controller.js';
import { ArtifactStorageService } from '../services/artifact_storage.service.js';
import type { ApiOkResponse, ApiRequest, BooleanData } from '../types/api_response.js';
import type {
    ArtifactData,
    ArtifactsSubmitOutput,
} from '../schemas/artifacts_schemas.js';
import {
    ArtifactsSubmitInput,
    ArtifactsGetInput,
    ArtifactsGetByIdInput,
    ArtifactsDeleteInput,
} from '../schemas/artifacts_schemas.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('ctrl.artifacts');

export class ArtifactsController extends BaseController {
    private readonly _storage: ArtifactStorageService;

    constructor(storage?: ArtifactStorageService) {
        super();
        this._storage = storage ?? new ArtifactStorageService();
    }

    /**
     * Upload an artifact from a daemon/agent and persist to R2.
     *
     * Accepts two content types:
     *   - `application/json` — base64-encoded content in the JSON body (≤ 1 MB)
     *   - `multipart/form-data` — raw file + metadata fields (> 1 MB)
     *
     * @param req - Body: {@link ArtifactsSubmitInput} (JSON) or multipart fields
     * @param res - `{ ok: true, data: ArtifactsSubmitOutput }`
     */
    async submit(
        req: ApiRequest<ArtifactsSubmitInput, ArtifactsSubmitOutput>,
        res: ApiOkResponse<ArtifactsSubmitOutput>,
    ): Promise<void> {
        log.debug('submit', { user_id: req.auth?.user?.id });
        const content_type = req.headers['content-type'] ?? '';

        let body: ArtifactsSubmitInput;

        if (content_type.includes('multipart/form-data')) {
            body = await _parse_multipart_submit(req);
        } else {
            body = this.parse_body(ArtifactsSubmitInput, req);
        }

        const uploaded_by = req.auth?.user?.id ?? undefined;
        const result = await this._storage.submit(body, uploaded_by);
        log.info('artifact_submitted', { run_id: body.run_id });
        this.ok(res, result, 201);
    }

    /**
     * List artifacts for a run, optionally filtered by phase.
     *
     * @param req - Body: {@link ArtifactsGetInput}
     * @param res - `{ ok: true, data: ArtifactData[] }`
     */
    async get(
        req: ApiRequest<ArtifactsGetInput, ArtifactData[]>,
        res: ApiOkResponse<ArtifactData[]>,
    ): Promise<void> {
        const body = this.parse_body(ArtifactsGetInput, req);
        log.debug('get', { run_id: body.run_id });
        const artifacts = await this._storage.get(body.run_id, body.phase);
        this.ok(res, artifacts);
    }

    /**
     * Fetch a single artifact's metadata and a fresh presigned download URL.
     *
     * @param req - Body: {@link ArtifactsGetByIdInput}
     * @param res - `{ ok: true, data: ArtifactData }`
     */
    async get_by_id(
        req: ApiRequest<ArtifactsGetByIdInput, ArtifactData>,
        res: ApiOkResponse<ArtifactData>,
    ): Promise<void> {
        const body = this.parse_body(ArtifactsGetByIdInput, req);
        log.debug('get_by_id', { artifact_id: body.artifact_id });
        const artifact = await this._storage.get_by_id(body.artifact_id);
        this.ok(res, artifact);
    }

    /**
     * Delete an artifact — removes the R2 object and metadata row.
     *
     * @param req - Body: {@link ArtifactsDeleteInput}
     * @param res - `{ ok: true, data: boolean }`
     */
    async delete(
        req: ApiRequest<ArtifactsDeleteInput, BooleanData>,
        res: ApiOkResponse<BooleanData>,
    ): Promise<void> {
        const body = this.parse_body(ArtifactsDeleteInput, req);
        log.debug('delete', { artifact_id: body.artifact_id });
        const deleted = await this._storage.delete(body.artifact_id);
        log.info('artifact_deleted', { artifact_id: body.artifact_id });
        this.ok(res, deleted);
    }
}

// ─── Multipart parser ────────────────────────────────────────────────

import type { Request } from 'express';
import { ApiError } from '../errors/api_error.js';
import type { ArtifactsSubmitInput as SubmitInputType } from '../schemas/artifacts_schemas.js';

/**
 * Parse a multipart/form-data request into ArtifactsSubmitInput.
 *
 * Minimal parser — no external deps. Reads the raw body, splits on the
 * boundary, and extracts text fields + one file part. The file content
 * is base64-encoded into the standard input shape so the service layer
 * handles both transports uniformly.
 */
async function _parse_multipart_submit(req: Request): Promise<SubmitInputType> {
    const content_type = req.headers['content-type'] ?? '';
    const boundary_match = content_type.match(/boundary=([^\s;]+)/);
    if (!boundary_match) throw new ApiError('invalid_request', 'Missing multipart boundary');

    const boundary = boundary_match[1];
    const raw = await _read_raw_body(req);
    const parts = _split_multipart(raw, boundary);

    const fields: Record<string, string> = {};
    let file_content: Buffer | null = null;

    for (const part of parts) {
        const header_end = part.indexOf('\r\n\r\n');
        if (header_end === -1) continue;

        const header_str = part.subarray(0, header_end).toString('utf8');
        const body_buf = part.subarray(header_end + 4);

        const name_match = header_str.match(/name="([^"]+)"/);
        if (!name_match) continue;
        const name = name_match[1];

        // File part has a filename attribute.
        if (header_str.includes('filename=')) {
            file_content = body_buf;
            continue;
        }

        // Text field.
        fields[name] = body_buf.toString('utf8').trimEnd();
    }

    if (!fields.run_id) throw new ApiError('invalid_request', 'Missing run_id in multipart');
    if (!fields.phase) throw new ApiError('invalid_request', 'Missing phase in multipart');
    if (!fields.name) throw new ApiError('invalid_request', 'Missing name in multipart');
    if (!file_content) throw new ApiError('invalid_request', 'Missing file part in multipart');

    return {
        run_id: fields.run_id,
        phase: fields.phase,
        name: fields.name,
        content: file_content.toString('base64'),
        encoding: 'base64',
        mime_type: fields.mime_type,
        description: fields.description,
    };
}

/** Max raw body size for multipart uploads (55 MB — 50 MB file + overhead). */
const MAX_MULTIPART_BYTES = 55 * 1024 * 1024;

/** Read the raw request body into a Buffer, enforcing a size limit. */
function _read_raw_body(req: Request): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_MULTIPART_BYTES) {
                req.destroy();
                reject(new ApiError('invalid_request', `Multipart body exceeds ${MAX_MULTIPART_BYTES} bytes`));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** Split a multipart body into individual part buffers. */
function _split_multipart(raw: Buffer, boundary: string): Buffer[] {
    const delim = Buffer.from(`--${boundary}`);
    const parts: Buffer[] = [];
    let start = 0;

    while (true) {
        const idx = raw.indexOf(delim, start);
        if (idx === -1) break;

        if (start > 0) {
            // Strip leading \r\n from the part body.
            let part_start = start;
            if (raw[part_start] === 0x0d && raw[part_start + 1] === 0x0a) part_start += 2;
            // Strip trailing \r\n before the next boundary.
            let part_end = idx;
            if (raw[part_end - 2] === 0x0d && raw[part_end - 1] === 0x0a) part_end -= 2;
            if (part_end > part_start) {
                parts.push(raw.subarray(part_start, part_end));
            }
        }

        start = idx + delim.length;
        // Check for closing `--` after the boundary.
        if (raw[start] === 0x2d && raw[start + 1] === 0x2d) break;
    }

    return parts;
}
