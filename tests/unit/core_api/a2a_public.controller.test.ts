import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/services/agent_card.service.js', () => ({
    AgentCardService: {
        build_for_slug: vi.fn(),
    },
}));

import { A2aPublicController } from '../../../src/controllers/a2a_public_controller.js';
import { AgentCardService } from '../../../src/services/agent_card.service.js';

function mock_req(slug: string): Request {
    return { params: { slug } } as unknown as Request;
}

function mock_res() {
    const res = {
        status_code: 200,
        body: null as unknown,
        headers: {} as Record<string, string>,
        setHeader(key: string, value: string) {
            this.headers[key] = value;
            return this;
        },
        json(body: unknown) {
            this.body = body;
            return this;
        },
    };
    return res as unknown as Response & {
        body: unknown;
        headers: Record<string, string>;
    };
}

describe('A2aPublicController.agent_card', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns card JSON without auth', async () => {
        const card = { name: 'Acme', skills: [], url: 'https://api.cliqhub.io/a2a/r/acme' };
        vi.mocked(AgentCardService.build_for_slug).mockResolvedValue(card as any);
        const res = mock_res();
        const next = vi.fn() as NextFunction;

        await A2aPublicController.agent_card(mock_req('acme'), res, next);

        expect(AgentCardService.build_for_slug).toHaveBeenCalledWith('acme', { org_id: undefined });
        expect(res.body).toEqual(card);
        expect(res.headers['Cache-Control']).toBe('public, max-age=60');
        expect(next).not.toHaveBeenCalled();
    });

    it('forwards errors to next', async () => {
        const err = Object.assign(new Error('missing'), { status_code: 404 });
        vi.mocked(AgentCardService.build_for_slug).mockRejectedValue(err);
        const res = mock_res();
        const next = vi.fn() as NextFunction;

        await A2aPublicController.agent_card(mock_req('nope'), res, next);

        expect(next).toHaveBeenCalledWith(err);
    });
});
