import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hashed'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

import express from 'express';
import request from 'supertest';
import { BuilderService } from '../../src/services/builder_service.js';
import { TeamsController } from '../../src/controllers/teams_controller.js';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { create_route_policy_middleware } from '../../src/middleware/enforce_route_policy.js';
import type { AccessStore } from '../../src/auth/route_policy/engine.js';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import * as pw from '../../src/auth/password.js';

const ALICE_USER = {
    id: hub_legacy_uuid(1),
    username: 'alice',
    role: 'user',
    email: 'alice@test.com',
    display_name: 'Alice',
    suspended_at: null,
    suspended_reason: '',
    created_at: '2025-01-01',
};

const auth_repos = {
    user_repo: { find_profile_by_id: vi.fn() },
    token_repo: { find_by_prefix: vi.fn(), update_last_used: vi.fn() },
    scope_repo: {
        find_owned_by_user: vi.fn().mockResolvedValue([]),
        find_by_org_ids: vi.fn().mockResolvedValue([]),
        find_member_scopes: vi.fn().mockResolvedValue([]),
        find_default_scopes: vi.fn().mockResolvedValue([]),
    },
    org_member_repo: { find_orgs_by_user: vi.fn().mockResolvedValue([]) },
};

function make_mock_llm() {
    return { complete: vi.fn().mockResolvedValue({ text: '{}', usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
}

const mock_llm = make_mock_llm();
const builder_service = new BuilderService(mock_llm as any);
const teams_controller = new TeamsController({} as any, builder_service);

const app = express();
app.use(express.json());
app.use(create_auth_middleware({
    user_repo: auth_repos.user_repo as any,
    token_repo: auth_repos.token_repo as any,
    scope_repo: auth_repos.scope_repo as any,
    org_member_repo: auth_repos.org_member_repo as any,
}));
app.use(create_route_policy_middleware({ store: {} as AccessStore })); // teams/build: signed_in
app.post('/v1/teams/build', teams_controller.wrap(teams_controller.build));
app.use(error_handler);

function auth_header(): string {
    vi.mocked(pw.verify_password).mockResolvedValueOnce(true);
    return stub_pat_auth(auth_repos as any, ALICE_USER);
}

const valid_team_response = JSON.stringify({
    name: 'test-team',
    description: 'Test',
    phases: [{ name: 'dev', type: 'standard', depends_on: [] }],
    roles: [{ name: 'dev', content: 'You are a developer who writes clean code, tests, and documentation.' }],
});

const valid_improve_response = JSON.stringify({
    name: 'dev',
    original_content: 'old',
    improved_content: 'better role content',
    changes_summary: 'made it better',
});

const valid_suggest_response = JSON.stringify([
    { type: 'workflow_improvement', title: 'Add gate', description: 'Add a quality gate' },
]);

const valid_chat_response = JSON.stringify({
    reply: 'I added the phase.',
    actions: [{ type: 'ADD_PHASE', phase: { name: 'lint', type: 'exec', depends_on: ['dev'], commands: [{ name: 'lint', run: 'npm run lint' }] } }],
});

describe('POST /v1/teams/build', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 with job_id and completes via status poll', async () => {
        mock_llm.complete.mockResolvedValueOnce({ text: valid_team_response, usage: { prompt_tokens: 10, completion_tokens: 20 } });
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ action: 'generate', intent: 'build a code review team' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.job_id).toBeTruthy();

        let done: any = null;
        for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 25));
            const poll = await request(app).post('/v1/teams/build')
                .set('Authorization', auth_header())
                .send({ action: 'status', job_id: res.body.data.job_id });
            expect(poll.status).toBe(200);
            if (poll.body.data.status === 'done' || poll.body.data.status === 'error') {
                done = poll.body.data;
                break;
            }
        }
        expect(done?.status).toBe('done');
        expect(done.team.name).toBe('test-team');
    });

    it('returns 422 for empty intent on generate', async () => {
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ action: 'generate' });
        expect(res.status).toBe(422);
    });

    it('returns 422 for missing action', async () => {
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ intent: 'build a team' });
        expect(res.status).toBe(422);
    });

    it('returns 401 for unauthenticated request', async () => {
        const res = await request(app).post('/v1/teams/build')
            .send({ action: 'generate', intent: 'test' });
        expect(res.status).toBe(401);
    });

    it('improve_role returns 200 with improved role', async () => {
        mock_llm.complete.mockResolvedValueOnce({ text: valid_improve_response, usage: { prompt_tokens: 5, completion_tokens: 15 } });
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ action: 'improve_role', role_name: 'dev', role_content: 'You are a developer.' });
        expect(res.status).toBe(200);
        expect(res.body.data.improved_content).toBe('better role content');
    });

    it('improve_role returns 422 for missing fields', async () => {
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ action: 'improve_role', role_content: 'content only' });
        expect(res.status).toBe(422);
    });

    it('suggest returns 200 with suggestions', async () => {
        mock_llm.complete.mockResolvedValueOnce({ text: valid_suggest_response, usage: { prompt_tokens: 5, completion_tokens: 10 } });
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ action: 'suggest', team_name: 'my-team', description: 'A team' });
        expect(res.status).toBe(200);
        expect(res.body.data.suggestions).toHaveLength(1);
    });

    it('suggest returns 422 for missing team_name', async () => {
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ action: 'suggest' });
        expect(res.status).toBe(422);
    });

    it('validate returns 200 with valid result', async () => {
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({
                action: 'validate',
                team: {
                    name: 'good-team',
                    description: 'A well-formed team',
                    phases: [{ name: 'dev', type: 'standard', depends_on: [] }],
                    roles: [{ name: 'dev', content: 'You are a developer who writes clean, tested, well-documented code for production.' }],
                },
            });
        expect(res.status).toBe(200);
        expect(res.body.data.valid).toBe(true);
        expect(res.body.data.errors).toEqual([]);
    });

    it('validate returns 200 with errors for invalid team', async () => {
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({
                action: 'validate',
                team: {
                    name: '',
                    description: '',
                    phases: [],
                    roles: [],
                },
            });
        expect(res.status).toBe(200);
        expect(res.body.data.valid).toBe(false);
        expect(res.body.data.errors.length).toBeGreaterThan(0);
    });

    it('validate returns 422 for missing team', async () => {
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ action: 'validate' });
        expect(res.status).toBe(422);
    });

    it('chat returns 200 with reply', async () => {
        mock_llm.complete.mockResolvedValueOnce({ text: valid_chat_response, usage: { prompt_tokens: 10, completion_tokens: 20 } });
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({
                action: 'chat',
                team: { name: 'my-team', phases: [{ name: 'dev', type: 'standard', depends_on: [] }], roles: [] },
                message: 'Add a lint phase',
            });
        expect(res.status).toBe(200);
        expect(res.body.data.reply).toBe('I added the phase.');
        expect(res.body.data.actions).toHaveLength(1);
    });

    it('chat returns 422 for missing message', async () => {
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ action: 'chat', team: { name: 'x', phases: [], roles: [] } });
        expect(res.status).toBe(422);
    });

    it('chat returns 422 for missing team', async () => {
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({ action: 'chat', message: 'hello' });
        expect(res.status).toBe(422);
    });

    it('chat returns 200 with history forwarded', async () => {
        mock_llm.complete.mockResolvedValueOnce({ text: valid_chat_response, usage: { prompt_tokens: 15, completion_tokens: 25 } });
        const res = await request(app).post('/v1/teams/build')
            .set('Authorization', auth_header())
            .send({
                action: 'chat',
                team: { name: 'my-team', phases: [], roles: [] },
                message: 'Now add tests',
                history: [
                    { role: 'user', content: 'Add a dev phase' },
                    { role: 'assistant', content: '{"reply":"Done","actions":[]}' },
                ],
            });
        expect(res.status).toBe(200);
        expect(res.body.data.reply).toBeDefined();
        expect(mock_llm.complete).toHaveBeenCalledOnce();
        const messages = mock_llm.complete.mock.calls[0][0];
        const user_messages = messages.filter((m: any) => m.role === 'user');
        expect(user_messages.length).toBeGreaterThanOrEqual(3);
    });
});
