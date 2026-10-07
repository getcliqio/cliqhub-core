/** run_history.service — who resumed a run, and a run's lifecycle for the run page. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
    HubEvent: { findAll: vi.fn() },
    Run: { findByPk: vi.fn() },
    User: { findAll: vi.fn() },
    submit: vi.fn(),
}));
vi.mock('../../../src/models/index.js', () => ({ HubEvent: m.HubEvent, Run: m.Run, User: m.User }));
vi.mock('../../../src/services/events_service.js', () => ({ EventSubmitService: { submit: m.submit } }));

import { RunHistoryService } from '../../../src/services/run_history.service.js';

beforeEach(() => vi.clearAllMocks());

describe('RunHistoryService', () => {
    it('records a resume request with the person who asked', async () => {
        m.Run.findByPk.mockResolvedValue({ run_id: 'r1', realm_id: 'A1', daemon_id: 'd1', run_name: 'kind-fern', team_id: 't1' });
        await RunHistoryService.record_resume_request('r1', 'design', 'u-sapan');
        expect(m.submit).toHaveBeenCalledWith(expect.objectContaining({
            type: 'run.resume_requested', run_id: 'r1', realm_id: 'A1', daemon_id: 'd1', phase: 'design', actor_id: 'u-sapan',
            payload: expect.objectContaining({ from_phase: 'design' }),
        }));
    });

    it('never fails the resume: no daemon → skipped; submit error → swallowed', async () => {
        m.Run.findByPk.mockResolvedValue({ run_id: 'r1', realm_id: 'A1', daemon_id: null });
        await RunHistoryService.record_resume_request('r1', 'design', 'u');
        expect(m.submit).not.toHaveBeenCalled();
        m.Run.findByPk.mockResolvedValue({ run_id: 'r1', realm_id: 'A1', daemon_id: 'd1' });
        m.submit.mockRejectedValue(new Error('db down'));
        await expect(RunHistoryService.record_resume_request('r1', 'design', 'u')).resolves.toBeUndefined();
    });

    it('history: oldest first, payload fields, actor names', async () => {
        m.HubEvent.findAll.mockResolvedValue([
            { type: 'run.started', created_at: '1000', payload_json: '{"phase":"fetch"}', actor_id: null },
            { type: 'run.failed', created_at: 2000, payload_json: '{"phase":"design","error":"Sub-team failed"}', actor_id: null },
            { type: 'run.resume_requested', created_at: 3000, payload_json: '{"from_phase":"design"}', actor_id: 'u-sapan' },
            { type: 'run.completed', created_at: 4000, payload_json: 'not json', actor_id: null },
        ]);
        m.User.findAll.mockResolvedValue([{ id: 'u-sapan', username: 'sapan', display_name: 'Sapan Shah' }]);
        const h = await RunHistoryService.history('r1');
        expect(h.map((e) => [e.type, e.at])).toEqual([['run.started', 1000], ['run.failed', 2000], ['run.resume_requested', 3000], ['run.completed', 4000]]);
        expect(h[1]).toMatchObject({ phase: 'design', error: 'Sub-team failed', actor: null });
        expect(h[2]).toMatchObject({ from_phase: 'design', actor: { id: 'u-sapan', username: 'sapan', display_name: 'Sapan Shah' } });
        expect(h[3]).toMatchObject({ phase: null, error: null });
    });
});
