/**
 * Work a request starts but does not wait for (for example the public
 * "Forgot password" email, so the answer's timing tells nothing). Every such
 * task is tracked: its failure is logged, and shutdown waits for the tasks
 * still running before closing the database.
 */

import { get_logger } from './log.js';

const log = get_logger('background');

const running = new Set<Promise<void>>();

/**
 * Starts `work` without waiting for it. A failure is logged as `<name>_failed`.
 *
 * @param name - What the task does (log key).
 */
export function run_in_background(name: string, work: () => Promise<unknown>): void {
    const task: Promise<void> = work().then(
        () => undefined,
        (err: unknown) => { log.error(`${name}_failed`, { error: err instanceof Error ? err.message : String(err) }); },
    ).finally(() => { running.delete(task); });
    running.add(task);
}

/** Waits until every background task started so far has finished. */
export async function settle_background(): Promise<void> {
    while (running.size) await Promise.all([...running]);
}
