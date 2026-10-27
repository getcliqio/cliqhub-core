/**
 * Unit tests for ArtifactStorageService — stored artifact CRUD + R2 operations.
 *
 * R2Client and StoredArtifactRepository are injected as fakes so tests
 * verify orchestration logic without real R2 or Postgres.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { accept_problem, ArtifactStorageService, remove_stale_upload_files } from '../../../src/services/artifact_storage.service.js';
import { R2Client } from '../../../src/lib/r2_client.js';
import type { StoredArtifactRepository } from '../../../src/repositories/stored_artifact_repository.js';

// ── Fake R2Client ────────────────────────────────────────────────────

function fake_r2(): R2Client {
    return {
        is_configured: true,
        // Drain the stream like R2 would, so the temp file is fully read before it is removed.
        put_object_stream: vi.fn(async (_key: string, body: Readable) => { for await (const _ of body) { /* drain */ } }),
        get_object_stream: vi.fn(),
        delete_object: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Client;
}

// ── Fake Repository ──────────────────────────────────────────────────

function fake_repo(): StoredArtifactRepository {
    return {
        create: vi.fn().mockResolvedValue(undefined),
        find_by_id: vi.fn().mockResolvedValue(null),
        find_by_run: vi.fn().mockResolvedValue([]),
        delete_by_id: vi.fn().mockResolvedValue(true),
        find_stale_pending: vi.fn().mockResolvedValue([]),
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
        status: 'ready',
        source: 'daemon',
        hug_id: null,
        hug_requested_input: null,
        sha256: null,
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

    // ── upload ───────────────────────────────────────────────────────

    const body = (text: string | Buffer) => Readable.from([Buffer.isBuffer(text) ? text : Buffer.from(text)]);
    const run_target = { kind: 'run' as const, run_id: 'run-1', phase: 'analyst' };

    describe('upload', () => {
        it('streams a daemon artifact to R2 with its real sha256 and stores it ready', async () => {
            const result = await service.upload({
                stream: body('hello world'), content_length: 11, content_type: 'text/markdown', name: 'output.md',
                target: run_target, uploaded_by: null,
            });
            const [key, , opts] = (r2.put_object_stream as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(opts).toEqual({
                content_length: 11, content_type: 'text/markdown',
                sha256_hex: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
            });
            const row = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(row).toMatchObject({ id: key, run_id: 'run-1', phase: 'analyst', status: 'ready', source: 'daemon', size_bytes: 11, sha256: opts.sha256_hex });
            expect(result).toMatchObject({ artifact_id: key, status: 'ready', size: 11, content_type: 'text/markdown' });
            expect(result.download_url).toMatch(new RegExp(`/v1/artifacts/download\\?artifact_id=${key}$`));
            expect(result.download_url).not.toContain('r2');
        });

        it('stores a responder file pending, linked to its Hug and input', async () => {
            const result = await service.upload({
                stream: body('%PDF-1.7 rest'), content_length: 13, content_type: 'application/pdf', name: 'MSA.pdf',
                target: { kind: 'hug', run_id: 'run-1', phase: 'legal', hug_id: 'h1', requested_input: 'contract', accept: ['application/pdf'], pending_count: 0 },
                uploaded_by: 'user-1',
            });
            const row = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(row).toMatchObject({ status: 'pending', source: 'hug', hug_id: 'h1', hug_requested_input: 'contract', uploaded_by: 'user-1' });
            expect(result.status).toBe('pending');
        });

        it('refuses a declared length over the limit before reading (413)', async () => {
            await expect(service.upload({
                stream: body('x'), content_length: 2 * 1024 * 1024, content_type: 'text/plain', name: 'huge.txt', target: run_target, uploaded_by: null,
            })).rejects.toMatchObject({ status: 413, code: 'ARTIFACT_TOO_LARGE' });
            expect(r2.put_object_stream).not.toHaveBeenCalled();
        });

        it('aborts mid-stream when the body passes its declared length or the limit (413)', async () => {
            await expect(service.upload({
                stream: body('x'.repeat(100)), content_length: 10, content_type: 'text/plain', name: 'lie.txt', target: run_target, uploaded_by: null,
            })).rejects.toMatchObject({ status: 413 });
            expect(repo.create).not.toHaveBeenCalled();
        });

        it("applies a Hug input's lower max_bytes", async () => {
            await expect(service.upload({
                stream: body('12345'), content_length: 5, content_type: 'text/plain', name: 'a.txt',
                target: { kind: 'hug', run_id: 'r', phase: 'p', hug_id: 'h', requested_input: 'f', max_bytes: 4, pending_count: 0 },
                uploaded_by: 'u',
            })).rejects.toMatchObject({ status: 413 });
        });

        it('refuses a short body (400) and a missing length (411)', async () => {
            await expect(service.upload({
                stream: body('abc'), content_length: 10, content_type: 'text/plain', name: 'short.txt', target: run_target, uploaded_by: null,
            })).rejects.toMatchObject({ status: 400 });
            await expect(service.upload({
                stream: body('abc'), content_length: Number.NaN, content_type: 'text/plain', name: 'x.txt', target: run_target, uploaded_by: null,
            })).rejects.toMatchObject({ status: 411 });
        });

        it("refuses a file that fails the input's accept (422), and too many pending uploads", async () => {
            const hug = { kind: 'hug' as const, run_id: 'r', phase: 'p', hug_id: 'h', requested_input: 'contract', accept: ['application/pdf', '.pdf'], pending_count: 0 };
            await expect(service.upload({
                stream: body(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), content_length: 4, content_type: 'application/pdf', name: 'MSA.pdf', target: hug, uploaded_by: 'u',
            })).rejects.toMatchObject({ status: 422, code: 'HUG_FILE_INVALID' });
            await expect(service.upload({
                stream: body('%PDF'), content_length: 4, content_type: 'application/pdf', name: 'MSA.pdf', target: { ...hug, pending_count: 20 }, uploaded_by: 'u',
            })).rejects.toMatchObject({ status: 422 });
        });

        it('removes the row and answers 502 when R2 refuses the file', async () => {
            (r2.put_object_stream as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('R2 PUT failed: 500'));
            await expect(service.upload({
                stream: body('data'), content_length: 4, content_type: 'text/plain', name: 'fail.txt', target: run_target, uploaded_by: null,
            })).rejects.toMatchObject({ status: 502, code: 'ARTIFACT_STORE_FAILED' });
            const row = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(repo.delete_by_id).toHaveBeenCalledWith(row.id);
        });

        it('answers 503 when storage is not configured', async () => {
            const service2 = new ArtifactStorageService({ r2: { ...r2, is_configured: false } as unknown as R2Client, repo, max_size_mb: 1 });
            await expect(service2.upload({
                stream: body('a'), content_length: 1, content_type: 'text/plain', name: 'a.txt', target: run_target, uploaded_by: null,
            })).rejects.toMatchObject({ status: 503 });
        });
    });

    // ── download ─────────────────────────────────────────────────────

    describe('download', () => {
        const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
        it('streams the stored object, passing Range through', async () => {
            (repo.find_by_id as ReturnType<typeof vi.fn>).mockResolvedValue(fake_row({ id: ID, storage_key: ID }));
            (r2.get_object_stream as ReturnType<typeof vi.fn>).mockResolvedValue({ body: 'BODY', status: 206, content_length: 5, content_type: 'text/markdown', content_range: 'bytes 0-4/42' });
            const out = await service.download(ID, 'user-1', 'bytes=0-4');
            expect(r2.get_object_stream).toHaveBeenCalledWith(ID, { range: 'bytes=0-4' });
            expect(out).toMatchObject({ status: 206, name: 'report.md', content_range: 'bytes 0-4/42' });
        });

        it('hides a pending upload from everyone but its uploader (404)', async () => {
            (repo.find_by_id as ReturnType<typeof vi.fn>).mockResolvedValue(fake_row({ id: ID, status: 'pending', uploaded_by: 'user-1' }));
            await expect(service.download(ID, 'someone-else')).rejects.toMatchObject({ status: 404 });
            await expect(service.download(ID, null)).rejects.toMatchObject({ status: 404 });
            (r2.get_object_stream as ReturnType<typeof vi.fn>).mockResolvedValue({ body: 'B', status: 200, content_length: 1, content_type: 'x' });
            await expect(service.download(ID, 'user-1')).resolves.toMatchObject({ status: 200 });
        });

        it('404 for a bad id or a missing object', async () => {
            await expect(service.download('not-a-uuid', 'u')).rejects.toMatchObject({ status: 404 });
        });
    });

    // ── pending cleanup ──────────────────────────────────────────────

    it('delete_stale_pending removes the R2 object and the row of each unused upload older than 24h', async () => {
        (repo.find_stale_pending as ReturnType<typeof vi.fn>).mockResolvedValue([fake_row({ id: 'p1', storage_key: 'p1', status: 'pending' })]);
        const now = new Date('2026-10-26T12:00:00Z');
        expect(await service.delete_stale_pending(now)).toBe(1);
        expect(repo.find_stale_pending).toHaveBeenCalledWith(now.getTime() - 24 * 60 * 60 * 1000);
        expect(r2.delete_object).toHaveBeenCalledWith('p1');
        expect(repo.delete_by_id).toHaveBeenCalledWith('p1');
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
        it('returns the artifact with its Hub download URL (never an R2 one)', async () => {
            (repo.find_by_id as ReturnType<typeof vi.fn>).mockResolvedValue(fake_row());
            const result = await service.get_by_id('art-001');
            expect(result.artifact_id).toBe('art-001');
            expect(result.download_url).toMatch(/\/v1\/artifacts\/download\?artifact_id=art-001$/);
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

describe('ArtifactStorageService — R2 never leaves Core (§6.6)', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('no upload, list or metadata response carries an R2 host, bucket, signature or presigned link', async () => {
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            for await (const _ of init.body as unknown as AsyncIterable<Uint8Array>) { /* drain */ }
            return new Response(null, { status: 200 });
        }));
        const r2 = new R2Client({ endpoint: 'https://acct123.r2.cloudflarestorage.com', bucket: 'secret-bucket', access_key_id: 'AKID', secret_access_key: 'SECRET' });
        const repo = fake_repo();
        (repo.find_by_run as ReturnType<typeof vi.fn>).mockResolvedValue([fake_row()]);
        (repo.find_by_id as ReturnType<typeof vi.fn>).mockResolvedValue(fake_row());
        const service = new ArtifactStorageService({ r2, repo, max_size_mb: 1 });
        const responses = [
            await service.upload({
                stream: Readable.from([Buffer.from('hello')]), content_length: 5, content_type: 'text/plain', name: 'a.txt',
                target: { kind: 'run', run_id: 'run-1', phase: 'p' }, uploaded_by: null,
            }),
            await service.get('run-1'),
            await service.get_by_id('art-001'),
        ];
        const text = JSON.stringify(responses);
        for (const leak of ['r2.cloudflarestorage.com', 'acct123', 'secret-bucket', 'X-Amz', 'x-amz', 'Signature', 'presign', 'AKID']) {
            expect(text).not.toContain(leak);
        }
    });
});

describe('remove_stale_upload_files', () => {
    it('deletes upload temp files older than an hour and keeps newer ones', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliq-uploads-test-'));
        const old_file = path.join(dir, 'old.part');
        const new_file = path.join(dir, 'new.part');
        fs.writeFileSync(old_file, 'x');
        fs.writeFileSync(new_file, 'y');
        const two_hours_ago = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
        fs.utimesSync(old_file, two_hours_ago, two_hours_ago);
        expect(await remove_stale_upload_files(Date.now(), dir)).toBe(1);
        expect(fs.existsSync(old_file)).toBe(false);
        expect(fs.existsSync(new_file)).toBe(true);
        expect(await remove_stale_upload_files(Date.now(), path.join(dir, 'missing'))).toBe(0);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('ArtifactStorageService — one list per run (files + run records)', () => {
    const REC_ID = '7f1c2a9e-1111-4222-8333-444455556666';
    const record = (over: Record<string, unknown> = {}) => ({
        id: REC_ID, run_id: 'run-1', phase: 'build', kind: 'output', name: 'phase_output',
        content: 'x'.repeat(2500), mime_type: null, created_at: 1700000000500, ...over,
    });
    const make = () => {
        const r2 = fake_r2();
        const repo = fake_repo();
        (repo.find_by_run as ReturnType<typeof vi.fn>).mockResolvedValue([fake_row()]);
        const records = {
            find_all_q: vi.fn().mockResolvedValue([record()]),
            find_one_q: vi.fn().mockResolvedValue(record()),
        };
        return { service: new ArtifactStorageService({ r2, repo, records: records as never, max_size_mb: 50 }), records };
    };

    it('without include_records: the stored files only, as before (daemons in the field)', async () => {
        const { service, records } = make();
        const list = await service.get('run-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ artifact_id: 'art-001', source: 'file', kind: 'file', content_preview: null });
        expect(list[0]!.download_url).toMatch(/\/v1\/artifacts\/download\?artifact_id=art-001$/);
        expect(records.find_all_q).not.toHaveBeenCalled();
    });

    it('with include_records: files and records in the order produced; records preview, no link', async () => {
        const { service, records } = make();
        const list = await service.get('run-1', 'build', true);
        expect(records.find_all_q).toHaveBeenCalledWith({ where: { run_id: 'run-1', phase: 'build' }, order: [['created_at', 'ASC']] });
        expect(list.map((a) => a.artifact_id)).toEqual(['art-001', `rec:${REC_ID}`]);
        expect(list[1]).toMatchObject({ source: 'record', kind: 'output', phase: 'build', mime_type: 'text/plain', download_url: null, size_bytes: 2500 });
        expect(list[1]!.content_preview!.length).toBeLessThan(2500);
        expect(list[1]).not.toHaveProperty('content');
    });

    it('get_by_id("rec:<id>") returns the whole record; a bad or unknown id is 404', async () => {
        const { service, records } = make();
        const full = await service.get_by_id(`rec:${REC_ID}`);
        expect(full).toMatchObject({ source: 'record', content: 'x'.repeat(2500) });
        await expect(service.get_by_id('rec:not-a-uuid')).rejects.toMatchObject({ status: 404 });
        records.find_one_q.mockResolvedValue(null);
        await expect(service.get_by_id(`rec:${REC_ID}`)).rejects.toMatchObject({ status: 404 });
    });
});

describe('accept_problem', () => {
    const pdf = Buffer.from('%PDF-1.7');
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
    it('accepts by declared type or extension, with wildcards', () => {
        expect(accept_problem(['application/pdf'], 'MSA.pdf', 'application/pdf', pdf)).toBeNull();
        expect(accept_problem(['.pdf'], 'MSA.PDF', 'application/octet-stream', pdf)).toBeNull();
        expect(accept_problem(['image/*'], 'a.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
        expect(accept_problem(['text/plain'], 'notes.txt', 'text/plain; charset=utf-8', Buffer.from('hello'))).toBeNull();
    });
    it('refuses another type, a renamed program, and content that disagrees with the type', () => {
        expect(accept_problem(['application/pdf'], 'a.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toMatch(/not an accepted type/);
        expect(accept_problem(['application/pdf', '.pdf'], 'MSA.pdf', 'application/pdf', exe)).toMatch(/is a program/);
        expect(accept_problem(['image/*'], 'pic.png', 'image/png', pdf)).toMatch(/content is application\/pdf/);
    });
});
