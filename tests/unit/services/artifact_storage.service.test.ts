/**
 * Unit tests for ArtifactStorageService — stored artifact CRUD + R2 operations.
 *
 * R2Client and StoredArtifactRepository are injected as fakes so tests
 * verify orchestration logic without real R2 or Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ArtifactStorageService } from '../../../src/services/artifact_storage.service.js';
import type { R2Client } from '../../../src/lib/r2_client.js';
import type { StoredArtifactRepository } from '../../../src/repositories/stored_artifact_repository.js';

// ── Fake R2Client ────────────────────────────────────────────────────

function fake_r2(): R2Client {
    return {
        is_configured: true,
        put_object: vi.fn().mockResolvedValue(undefined),
        delete_object: vi.fn().mockResolvedValue(undefined),
        presigned_get_url: vi.fn().mockReturnValue('https://r2.example.com/signed?token=abc'),
    } as unknown as R2Client;
}

// ── Fake Repository ──────────────────────────────────────────────────

function fake_repo(): StoredArtifactRepository {
    return {
        create: vi.fn().mockResolvedValue(undefined),
        find_by_id: vi.fn().mockResolvedValue(null),
        find_by_run: vi.fn().mockResolvedValue([]),
        delete_by_id: vi.fn().mockResolvedValue(true),
    } as unknown as StoredArtifactRepository;
}

/** Fake DB row shape matching StoredArtifactAttributes. */
function fake_row(overrides: Record<string, unknown> = {}) {
    return {
        id: 'art-001',
        run_id: 'run-1',
        phase: 'analyst',
        name: 'report.md',
        description: null,
        mime_type: 'text/markdown',
        size_bytes: 42,
        storage_key: 'art-001',
        uploaded_by: 'user-1',
        created_at: 1700000000000,
        ...overrides,
    };
}

describe('ArtifactStorageService', () => {
    let r2: ReturnType<typeof fake_r2>;
    let repo: ReturnType<typeof fake_repo>;
    let service: ArtifactStorageService;

    beforeEach(() => {
        r2 = fake_r2();
        repo = fake_repo();
        service = new ArtifactStorageService({ r2: r2 as R2Client, repo: repo as StoredArtifactRepository, max_size_mb: 1 });
    });

    // ── submit ───────────────────────────────────────────────────────

    describe('submit', () => {
        it('uploads utf8 content to R2 and creates a DB row', async () => {
            const result = await service.submit({
                run_id: 'run-1',
                phase: 'analyst',
                name: 'output.md',
                content: 'hello world',
            }, 'user-1');

            expect(r2.put_object).toHaveBeenCalledTimes(1);
            const [key, buf, mime] = (r2.put_object as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(typeof key).toBe('string');
            expect(Buffer.isBuffer(buf)).toBe(true);
            expect(mime).toBe('application/octet-stream');

            expect(repo.create).toHaveBeenCalledTimes(1);
            const row = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(row.run_id).toBe('run-1');
            expect(row.phase).toBe('analyst');
            expect(row.name).toBe('output.md');
            expect(row.size_bytes).toBe(Buffer.byteLength('hello world'));

            expect(result.artifact_id).toBe(row.id);
            expect(result.name).toBe('output.md');
            expect(result.download_url).toContain('r2.example.com');
        });

        it('decodes base64 content', async () => {
            const b64 = Buffer.from('binary data').toString('base64');
            const result = await service.submit({
                run_id: 'run-1',
                phase: 'builder',
                name: 'data.bin',
                content: b64,
                encoding: 'base64',
                mime_type: 'application/octet-stream',
            });

            expect(result.size_bytes).toBe(Buffer.from(b64, 'base64').length);
        });

        it('rejects content exceeding max size', async () => {
            const big_content = 'x'.repeat(2 * 1024 * 1024);

            await expect(service.submit({
                run_id: 'run-1',
                phase: 'analyst',
                name: 'huge.txt',
                content: big_content,
            })).rejects.toThrow(/too large/);

            expect(r2.put_object).not.toHaveBeenCalled();
            expect(repo.create).not.toHaveBeenCalled();
        });

        it('throws when R2 PUT fails', async () => {
            (r2.put_object as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('R2 PUT failed: 500'));

            await expect(service.submit({
                run_id: 'run-1',
                phase: 'analyst',
                name: 'fail.txt',
                content: 'data',
            })).rejects.toThrow(/R2 PUT failed/);
        });
    });

    // ── get ──────────────────────────────────────────────────────────

    describe('get', () => {
        it('lists artifacts for a run', async () => {
            (repo.find_by_run as ReturnType<typeof vi.fn>).mockResolvedValue([
                fake_row(),
                fake_row({ id: 'art-002', name: 'second.md', storage_key: 'art-002' }),
            ]);

            const results = await service.get('run-1');
            expect(results).toHaveLength(2);
            expect(results[0].artifact_id).toBe('art-001');
            expect(results[1].artifact_id).toBe('art-002');
            expect(results[0].download_url).toBeTruthy();
        });

        it('passes phase filter to the repository', async () => {
            await service.get('run-1', 'builder');
            expect(repo.find_by_run).toHaveBeenCalledWith('run-1', 'builder');
        });
    });

    // ── get_by_id ────────────────────────────────────────────────────

    describe('get_by_id', () => {
        it('returns artifact with presigned URL', async () => {
            (repo.find_by_id as ReturnType<typeof vi.fn>).mockResolvedValue(fake_row());
            const result = await service.get_by_id('art-001');
            expect(result.artifact_id).toBe('art-001');
            expect(result.download_url).toContain('r2.example.com');
        });

        it('throws 404 for missing artifact', async () => {
            await expect(service.get_by_id('missing')).rejects.toThrow(/not found/);
        });
    });

    // ── delete ───────────────────────────────────────────────────────

    describe('delete', () => {
        it('deletes R2 object and DB row', async () => {
            (repo.find_by_id as ReturnType<typeof vi.fn>).mockResolvedValue(fake_row());

            const result = await service.delete('art-001');
            expect(result).toBe(true);
            expect(r2.delete_object).toHaveBeenCalledWith('art-001');
            expect(repo.delete_by_id).toHaveBeenCalledWith('art-001');
        });

        it('returns false for missing artifact', async () => {
            const result = await service.delete('missing');
            expect(result).toBe(false);
            expect(r2.delete_object).not.toHaveBeenCalled();
        });
    });
});
