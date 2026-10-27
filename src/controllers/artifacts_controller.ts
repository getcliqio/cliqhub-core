/**
 * Stored Artifacts controller — durable file storage for run outputs.
 *
 * Routes (1:1 with this controller):
 *   POST /v1/artifacts/upload     — stream a file in (daemon run artifact, or a Hug responder's file)
 *   POST|GET /v1/artifacts/download — stream a file out
 *   POST /v1/artifacts/get        — list artifacts for a run
 *   POST /v1/artifacts/get_by_id  — one artifact's metadata
 *   POST /v1/artifacts/delete     — remove artifact (R2 + metadata)
 *
 * Every byte goes through Core; only Core talks to R2 (PLAN-hug-requests §6.6).
 *
 * Instance methods per implementation-standards.mdc.
 */

import { BaseController } from './base_controller.js';
import { ArtifactStorageService } from '../services/artifact_storage.service.js';
import type { ApiOkResponse, ApiRequest, BooleanData } from '../types/api_response.js';
import type { ArtifactData } from '../schemas/artifacts_schemas.js';
import {
    ArtifactsDownloadInput,
    ArtifactsGetInput,
    ArtifactsGetByIdInput,
    ArtifactsDeleteInput,
    ArtifactsUploadQuery,
} from '../schemas/artifacts_schemas.js';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { RequestedInput } from '@getcliqio/cliq-sdk';
import { ApiError } from '../errors/api_error.js';
import { Hug, StoredArtifact } from '../models/index.js';
import { assert_answerable, HugsService } from '../services/hugs.service.js';
import type { UploadTarget } from '../services/artifact_storage.service.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('ctrl.artifacts');

export class ArtifactsController extends BaseController {
    private readonly _storage: ArtifactStorageService;

    constructor(storage?: ArtifactStorageService) {
        super();
        this._storage = storage ?? new ArtifactStorageService();
    }

    /**
     * POST /v1/artifacts/upload?… — stream one file in (§6.6.3). The body is the raw file
     * (`Content-Type` and `Content-Length` are the file's); metadata is in the query so the route
     * policy authorizes before the body is read. The daemon names `run_id` + `phase`; a responder
     * names `hug_id` + `requested_input` (a `file` input of an open Hug that reached them).
     *
     * @param req - Query: {@link ArtifactsUploadQuery}; body: the file
     * @param res - 201 `{ ok: true, data: UploadOutput }`
     */
    async upload(req: Request, res: Response): Promise<void> {
        const query = this.parse_query(ArtifactsUploadQuery, req);
        const content_length = Number(req.headers['content-length']);
        if (req.headers['content-length'] === undefined || !Number.isFinite(content_length)) {
            throw new ApiError('ARTIFACT_LENGTH_REQUIRED', 'Content-Length is required', 411);
        }
        const user_id = req.auth?.auth_via === 'daemon_token' ? null : (req.auth?.user?.id ?? null);
        const target = query.hug_id
            ? await hug_upload_target(query.hug_id, query.requested_input, user_id)
            : { kind: 'run' as const, run_id: query.run_id!, phase: query.phase! };
        const data = await this._storage.upload({
            stream: req,
            content_length,
            content_type: String(req.headers['content-type'] ?? 'application/octet-stream'),
            name: query.name,
            description: query.description,
            target,
            uploaded_by: user_id,
        });
        this.ok(res, data, 201);
    }

    /**
     * POST|GET /v1/artifacts/download — stream one stored file out (§6.6.4). Range requests pass
     * through (206). Sent as an attachment, never sniffed or cached by the browser.
     *
     * @param req - Body or query: {@link ArtifactsDownloadInput}
     * @param res - the file bytes
     */
    async download(req: Request, res: Response): Promise<void> {
        const { artifact_id } = req.method === 'GET' ? this.parse_query(ArtifactsDownloadInput, req) : this.parse_body(ArtifactsDownloadInput, req);
        const user_id = req.auth?.auth_via === 'daemon_token' ? null : (req.auth?.user?.id ?? null);
        const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
        const file = await this._storage.download(artifact_id, user_id, range);
        res.status(file.status);
        res.setHeader('Content-Type', file.mime_type || file.content_type);
        if (file.content_length !== null) res.setHeader('Content-Length', String(file.content_length));
        res.setHeader('Content-Disposition', content_disposition(file.name));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Accept-Ranges', 'bytes');
        if (file.content_range) res.setHeader('Content-Range', file.content_range);
        await pipeline(Readable.fromWeb(file.body as unknown as WebReadableStream<Uint8Array>), res);
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
        const artifacts = await this._storage.get(body.run_id, body.phase, body.include_records ?? false);
        this.ok(res, artifacts);
    }

    /**
     * Fetch a single artifact's metadata (its `download_url` is a Hub URL).
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

// ─── Helpers ─────────────────────────────────────────────────────────

/** The upload target for a responder's file: the Hug must be open, reach them, and have this `file` input. */
async function hug_upload_target(hug_id: string, requested_input: string | undefined, user_id: string | null): Promise<UploadTarget> {
    if (!user_id) throw new ApiError('forbidden', 'Only a person can upload a file for a Hug', 403);
    if (!requested_input) throw new ApiError('invalid_request', 'requested_input is required with hug_id', 400);
    const hug = await Hug.findByPk(hug_id);
    if (!hug) throw new ApiError('not_found', 'Hug not found', 404);
    assert_answerable(hug);
    if ((await HugsService.channels_reaching(hug, user_id)).length === 0) throw new ApiError('forbidden', 'This Hug was not sent to you', 403);
    const input = (hug.requested_inputs as RequestedInput[]).find((i) => i.name === requested_input);
    if (!input || input.type !== 'file') {
        throw new ApiError('HUG_FILE_INVALID', `'${requested_input}' is not a file input of this Hug`, 422);
    }
    const pending_count = await StoredArtifact.count({ where: { hug_id, uploaded_by: user_id, status: 'pending' } });
    return {
        kind: 'hug', run_id: hug.run_id, phase: hug.phase, hug_id, requested_input,
        accept: input.accept, max_bytes: input.max_bytes, pending_count,
    };
}

/** `attachment` with an ASCII fallback name and the exact UTF-8 one (RFC 6266). */
function content_disposition(name: string): string {
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
