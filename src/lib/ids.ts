/**
 * IdFactory — UUID and monotonic-millisecond generation.
 *
 * `new_id()` produces a random UUID v4 for entity primary keys.
 * `now_ms()` returns the current wall-clock timestamp in milliseconds.
 * `next_ms()` returns a strictly-increasing millisecond value — useful for
 * ordering events or log lines that arrive within the same clock tick.
 */

import { randomUUID } from 'node:crypto';

export class IdFactory {
    /** Generate a new random UUID v4 suitable for use as a primary key. */
    static new_id(): string {
        return randomUUID();
    }

    /** Return the current wall-clock time as a Unix millisecond timestamp. */
    static now_ms(): number {
        return Date.now();
    }

    private static _monotonic_ms = 0;

    /**
     * Return a strictly-increasing millisecond timestamp.
     *
     * Useful for ordering run-log lines or events that arrive within the same
     * clock tick. Advances the internal counter by 1 when `Date.now()` has not
     * moved forward since the last call.
     */
    static next_ms(): number {
        const t = Date.now();
        IdFactory._monotonic_ms = t <= IdFactory._monotonic_ms
            ? IdFactory._monotonic_ms + 1
            : t;
        return IdFactory._monotonic_ms;
    }
}
