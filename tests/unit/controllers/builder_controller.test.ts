import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { TeamsController } from '../../../src/controllers/teams_controller.js';

function make_builder_service() {
    return {
        start_generate: vi.fn().mockReturnValue({ job_id: 'j1', status: 'pending', stage: 'queued' }),
        get_generate_job: vi.fn().mockReturnValue({ job_id: 'j1', status: 'done', stage: 'done' }),
        improve_role: vi.fn().mockResolvedValue({ improved_content: 'better' }),
        suggest: vi.fn().mockResolvedValue({ suggestions: [] }),
        validate: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
        chat: vi.fn().mockResolvedValue({ reply: 'ok', actions: [] }),
    };
}

function make_req(body: any = {}): Request {
    return { body, auth: { user: { id: hub_legacy_uuid(1) }, org_slugs: [], org_ids: [], scopes: [] } } as unknown as Request;
}

function make_res(): Response {
    return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
}

describe('TeamsController.build', () => {
    let controller: TeamsController;
    let builder: ReturnType<typeof make_builder_service>;

    beforeEach(() => {
        vi.clearAllMocks();
        builder = make_builder_service();
        controller = new TeamsController({} as any, builder as any);
    });

    /** Call build through wrap so errors propagate to next() */
    function call_build(body: any, next: NextFunction) {
        const req = make_req(body);
        const res = make_res();
        return controller.wrap(controller.build)(req, res, next) as Promise<void>;
    }

    it('generate rejects missing intent', async () => {
        const next = vi.fn() as unknown as NextFunction;
        await call_build({ action: 'generate' }, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('status rejects missing job_id', async () => {
        const next = vi.fn() as unknown as NextFunction;
        await call_build({ action: 'status' }, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('improve_role rejects missing role_name', async () => {
        const next = vi.fn() as unknown as NextFunction;
        await call_build({ action: 'improve_role', role_content: 'x' }, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('suggest rejects missing team_name', async () => {
        const next = vi.fn() as unknown as NextFunction;
        await call_build({ action: 'suggest' }, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('validate rejects missing team', async () => {
        const next = vi.fn() as unknown as NextFunction;
        await call_build({ action: 'validate' }, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('chat rejects missing message', async () => {
        const next = vi.fn() as unknown as NextFunction;
        await call_build({ action: 'chat', team: { name: 'x', phases: [], roles: [] } }, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('rejects missing action', async () => {
        const next = vi.fn() as unknown as NextFunction;
        await call_build({ intent: 'build a team' }, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });
});
