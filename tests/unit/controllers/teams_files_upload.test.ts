/**
 * teams/files/upload (PLAN-team-bundle S1.3b): a multipart body — a JSON payload part and the files as
 * attachments, each filename its path in the team — reaches the service as { team_id, version_id, files }
 * with every byte intact; anything else is refused before the service is called.
 */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TeamsController } from '../../../src/controllers/teams_controller.js';

const TEAM = '11111111-2222-4333-8444-555555555555';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

/** A real multipart body and its content type, as a browser or cliqd would send it. */
async function multipart(payload: unknown, files: Array<[string, Blob]>): Promise<{ body: Buffer; type: string }> {
    const form = new FormData();
    form.append('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    for (const [path, blob] of files) form.append('files', blob, path);
    const req = new Request('http://x/', { method: 'POST', body: form });
    return { body: Buffer.from(await req.arrayBuffer()), type: req.headers.get('content-type')! };
}

function call(body: Buffer, type: string) {
    const upload_files = vi.fn().mockResolvedValue({ version_id: 'v', files: [] });
    const ctrl = new TeamsController({ upload_files } as never);
    const req = Object.assign(Readable.from([body]), { headers: { 'content-type': type, 'content-length': String(body.length) }, auth: { user: { id: 'u' } } });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    return { run: () => ctrl.upload_files(req as never, res as never), upload_files, res };
}

describe('POST /v1/teams/files/upload', () => {
    it('passes the payload and each attachment (path = filename, type, exact bytes) to the service', async () => {
        const { body, type } = await multipart({ team_id: TEAM }, [
            ['team.yml', new Blob(['name: x\n'], { type: 'text/yaml' })],
            ['roles/brief.md', new Blob(['# Brief'], { type: 'text/markdown' })],
            ['assets/logo.png', new Blob([PNG], { type: 'image/png' })],
        ]);
        const { run, upload_files, res } = call(body, type);
        await run();
        const [, params] = upload_files.mock.calls[0];
        expect(params.team_id).toBe(TEAM);
        expect(params.version_id).toBeUndefined();
        expect(params.files.map((f: { path: string; content_type: string }) => [f.path, f.content_type])).toEqual([
            ['team.yml', 'text/yaml'], ['roles/brief.md', 'text/markdown'], ['assets/logo.png', 'image/png'],
        ]);
        expect(Buffer.compare(params.files[2].data, Buffer.from(PNG))).toBe(0);
        expect(res.status).toHaveBeenCalledWith(201);
    });

    it('refuses a body that is not multipart, a payload that is not JSON or lacks team_id, and an oversized body', async () => {
        await expect(call(Buffer.from('{}'), 'application/json').run()).rejects.toMatchObject({ status: 415 });
        const bad = await multipart('not json', []);
        await expect(call(Buffer.from(bad.body.toString().replace('"not json"', 'not json')), bad.type).run()).rejects.toMatchObject({ status: 422 });
        const no_team = await multipart({ version_id: TEAM }, []);
        await expect(call(no_team.body, no_team.type).run()).rejects.toMatchObject({ status: 422 });
        const ctrl = new TeamsController({ upload_files: vi.fn() } as never);
        const req = Object.assign(Readable.from([Buffer.from('x')]), { headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(12 * 1024 * 1024) } });
        await expect(ctrl.upload_files(req as never, {} as never)).rejects.toMatchObject({ status: 413 });
    });
});
