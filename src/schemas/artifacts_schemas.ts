/**
 * Stored Artifacts API — Zod request/response schemas.
 *
 * All endpoints are POST, single verb:
 *   /v1/artifacts/submit     — daemon uploads a file
 *   /v1/artifacts/get        — list artifacts for a run
 *   /v1/artifacts/get_by_id  — single artifact metadata + download URL
 *   /v1/artifacts/delete     — remove artifact (R2 + metadata)
 */

import { z } from 'zod';

// ── Inputs ───────────────────────────────────────────────────────────

/** POST /v1/artifacts/submit — daemon uploads artifact content. */
export const ArtifactsSubmitInput = z.object({
    run_id: z.string().min(1).describe('Run that produced this artifact'),
    phase: z.string().min(1).describe('Phase that produced this artifact'),
    name: z.string().min(1).describe('Display name / filename'),
    content: z.string().min(1).describe('File content (raw string or base64)'),
    mime_type: z.string().optional().describe('MIME type; defaults to application/octet-stream'),
    description: z.string().optional().describe('Human-readable description shown in UI'),
    encoding: z.enum(['utf8', 'base64']).optional().describe('Content encoding; defaults to utf8'),
});
export type ArtifactsSubmitInput = z.infer<typeof ArtifactsSubmitInput>;

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
    download_url: z.string().nullable().describe('Presigned R2 GET URL (5-min TTL); null for a run record'),
    content_preview: z.string().nullable().describe('First ~2 KB of a run record; null for a stored file'),
    content: z.string().optional().describe('Full text of a run record (get_by_id only)'),
    created_at: z.number().describe('Unix timestamp ms'),
});
export type ArtifactData = z.infer<typeof ArtifactData>;

/** POST /v1/artifacts/submit response. */
export const ArtifactsSubmitOutput = z.object({
    artifact_id: z.string().describe('Created artifact UUID'),
    name: z.string().describe('Display name'),
    download_url: z.string().describe('Presigned download URL'),
    size_bytes: z.number().describe('Stored file size'),
});
export type ArtifactsSubmitOutput = z.infer<typeof ArtifactsSubmitOutput>;
