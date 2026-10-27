/**
 * The Hug sweep (PLAN-hug-requests §6.7): every minute, expire open Hugs past `expires_at`
 * (telling each requester) and send due reminders to the people who haven't responded. Also
 * removes responder uploads never used in a response (24h, §6.6.8) and, hourly, the events of Hugs
 * that ended more than 7 days ago (§9.3). At start it deletes upload temp files a crash left (§6.6.3).
 */

import { get_logger } from '../lib/log.js';
import { HugsService } from './hugs.service.js';

const log = get_logger('svc.hug_sweep');

const SWEEP_INTERVAL_MS = parseInt(process.env.HUG_SWEEP_MS ?? '60000', 10);
/** Old Hug events are looked for at most this often. */
const EVENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let _timer: ReturnType<typeof setInterval> | null = null;
let _last_event_cleanup = 0;

async function sweep(): Promise<void> {
    const now = new Date();
    await HugsService.expire_due(now);
    await HugsService.remind_due(now);
    const { ArtifactStorageService } = await import('./artifact_storage.service.js');
    await new ArtifactStorageService().delete_stale_pending(now);
    if (now.getTime() - _last_event_cleanup >= EVENT_CLEANUP_INTERVAL_MS) {
        _last_event_cleanup = now.getTime();
        await HugsService.delete_old_events(now);
    }
}

function run_logged(): void {
    sweep().catch((err) => {
        log.error('sweep_failed', { error: err instanceof Error ? err.message : String(err) });
    });
}

/** Start the periodic Hug sweep. */
export function start_hug_sweep(): void {
    if (_timer) return;
    import('./artifact_storage.service.js')
        .then(({ remove_stale_upload_files }) => remove_stale_upload_files())
        .catch((err) => log.error('stale_upload_files_failed', { error: err instanceof Error ? err.message : String(err) }));
    run_logged();
    _timer = setInterval(run_logged, SWEEP_INTERVAL_MS);
    _timer.unref();
}

/** Stop the sweep (graceful shutdown). */
export function stop_hug_sweep(): void {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}

/** Test hook — run one sweep cycle. */
export async function run_hug_sweep_once(): Promise<void> {
    await sweep();
}
