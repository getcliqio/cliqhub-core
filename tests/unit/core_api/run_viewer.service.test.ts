/**
 * RunViewerService — tracks active SSE viewers per run and signals
 * daemons via the command outbox.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: vi.fn(() => ({
        query: vi.fn(async () => [{ daemon_id: 'daemon-1' }]),
    })),
}));

vi.mock('../../../src/services/command_outbox.service.js', () => ({
    command_outbox_enqueue: vi.fn(async () => ({ tx_id: 'tx-mock' })),
}));

import { command_outbox_enqueue } from '../../../src/services/command_outbox.service.js';
import {
    add_viewer,
    remove_viewer,
    has_viewers,
    viewer_count,
    _test_reset,
} from '../../../src/services/run_viewer.service.js';

describe('RunViewerService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _test_reset();
    });

    afterEach(() => {
        _test_reset();
    });

    it('add_viewer for first viewer enqueues stream_subscribe', async () => {
        await add_viewer('run-1', 'viewer-a');

        expect(command_outbox_enqueue).toHaveBeenCalledTimes(1);
        expect(command_outbox_enqueue).toHaveBeenCalledWith(
            'daemon-1',
            '/v1/runs/events/subscribe',
            { run_id: 'run-1', viewer_id: 'viewer-a' },
            { max_attempts: 1 },
        );
    });

    it('add_viewer for second viewer on same run does NOT enqueue again', async () => {
        await add_viewer('run-1', 'viewer-a');
        await add_viewer('run-1', 'viewer-b');

        // Only one subscribe command for the first viewer.
        expect(command_outbox_enqueue).toHaveBeenCalledTimes(1);
    });

    it('remove_viewer with remaining viewers does not unsubscribe', async () => {
        await add_viewer('run-1', 'viewer-a');
        await add_viewer('run-1', 'viewer-b');
        vi.mocked(command_outbox_enqueue).mockClear();

        await remove_viewer('run-1', 'viewer-a');

        expect(command_outbox_enqueue).not.toHaveBeenCalled();
        expect(has_viewers('run-1')).toBe(true);
    });

    it('remove_viewer for last viewer enqueues stream_unsubscribe', async () => {
        await add_viewer('run-1', 'viewer-a');
        vi.mocked(command_outbox_enqueue).mockClear();

        await remove_viewer('run-1', 'viewer-a');

        expect(command_outbox_enqueue).toHaveBeenCalledTimes(1);
        expect(command_outbox_enqueue).toHaveBeenCalledWith(
            'daemon-1',
            '/v1/runs/events/unsubscribe',
            { run_id: 'run-1', viewer_id: 'viewer-a' },
            { max_attempts: 1 },
        );
        expect(has_viewers('run-1')).toBe(false);
    });

    it('remove_viewer for unknown viewer_id is a no-op', async () => {
        await remove_viewer('run-1', 'unknown-viewer');

        expect(command_outbox_enqueue).not.toHaveBeenCalled();
    });

    it('has_viewers returns correct boolean', async () => {
        expect(has_viewers('run-1')).toBe(false);

        await add_viewer('run-1', 'viewer-a');
        expect(has_viewers('run-1')).toBe(true);

        await remove_viewer('run-1', 'viewer-a');
        expect(has_viewers('run-1')).toBe(false);
    });

    it('viewer_count tracks active viewers', async () => {
        expect(viewer_count('run-1')).toBe(0);

        await add_viewer('run-1', 'viewer-a');
        expect(viewer_count('run-1')).toBe(1);

        await add_viewer('run-1', 'viewer-b');
        expect(viewer_count('run-1')).toBe(2);

        await remove_viewer('run-1', 'viewer-a');
        expect(viewer_count('run-1')).toBe(1);
    });
});
