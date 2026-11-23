/**
 * Stored Artifacts API — Zod request/response schemas.
 *
 * All endpoints are POST, single verb:
 *   /v1/artifacts/upload     — stream a file in
 *   /v1/artifacts/download   — stream a file out
 *   /v1/artifacts/get        — list artifacts for a run
 *   /v1/artifacts/get_by_id  — single artifact metadata + download URL
 *   /v1/artifacts/delete     — remove artifact (R2 + metadata)
 */

import { z } from 'zod';

// ── Inputs ───────────────────────────────────────────────────────────

/**
 * POST /v1/artifacts/upload — query (the body is the raw file). Exactly one target: a run artifact
 * (`run_id` + `phase`, the daemon) or a Hug's file input (`hug_id` + `requested_input`, a responder).
 */
export const ArtifactsUploadQuery = z.object({
    run_id: z.string().min(1).describe('Run the artifact belongs to'),
    phase: z.string().min(1).describe('Phase that produced it'),
    name: z.string().min(1).max(255).describe('File name'),
    description: z.string().max(2_000).optional().describe('Human-readable description shown in UI'),
});
export type ArtifactsUploadQuery = z.infer<typeof ArtifactsUploadQuery>;

/** POST|GET /v1/artifacts/download — one stored file's bytes. */
export const ArtifactsDownloadInput = z.object({
    artifact_id: z.string().min(1).describe('Artifact UUID'),
});
export type ArtifactsDownloadInput = z.infer<typeof ArtifactsDownloadInput>;

/** POST /v1/artifacts/get — list artifacts for a run. */
export const ArtifactsGetInput = z.object({
    run_id: z.string().min(1).describe('Run to list artifacts for'),
    phase: z.string().optional().describe('Filter to a specific phase'),
    include_records: z.boolean().optional()
        .describe('Also list the run records (phase outputs, transcripts, attached docs) — the run page and review packet'),
});
export type ArtifactsGetInput = z.infer<typeof ArtifactsGetInput>;

/** POST /v1/artifacts/get_by_id — single artifact lookup. */
export const ArtifactsGetByIdInput = z.object({
    artifact_id: z.string().min(1).describe('Artifact UUID'),
});
export type ArtifactsGetByIdInput = z.infer<typeof ArtifactsGetByIdInput>;

/** POST /v1/artifacts/delete — remove an artifact. */
export const ArtifactsDeleteInput = z.object({
    artifact_id: z.string().min(1).describe('Artifact UUID to delete'),
});
export type ArtifactsDeleteInput = z.infer<typeof ArtifactsDeleteInput>;

// ── Outputs ──────────────────────────────────────────────────────────

/** Single artifact metadata returned by all endpoints. */
export const ArtifactData = z.object({
    artifact_id: z.string().describe('Artifact UUID; a run record is `rec:<id>`'),
    source: z.enum(['file', 'record']).describe('A stored file (R2) or a run record (text)'),
    kind: z.string().describe("'file' for stored files; the record kind otherwise (output, chat_transcript, review, …)"),
    run_id: z.string().describe('Owning run'),
    phase: z.string().describe('Phase that produced the artifact'),
    name: z.string().describe('Display name / filename'),
    description: z.string().nullable().describe('Human-readable description'),
    mime_type: z.string().describe('MIME type'),
    size_bytes: z.number().describe('File size in bytes'),
    download_url: z.string().nullable().describe('Hub URL that streams the file (/v1/artifacts/download — needs Hub authentication); null for a run record'),
    content_preview: z.string().nullable().describe('First ~2 KB of a run record; null for a stored file'),
    content: z.string().optional().describe('Full text of a run record (get_by_id only)'),
    created_at: z.number().describe('Unix timestamp ms'),
});
export type ArtifactData = z.infer<typeof ArtifactData>;

