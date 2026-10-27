/**
 * Hug timing rules (PLAN-hug-requests §6.2, §6.7): when the next reminder is due, and when a Hug can
 * still take an answer — the clock counts, not just the stored status.
 */
import { describe, it, expect } from 'vitest';

import { assert_answerable, next_remind_at } from '../../../src/services/hugs.service.js';

const T0 = new Date('2026-10-26T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const DAY = at(24 * 60);

describe('next_remind_at', () => {
    it('no reminders → none', () => {
        expect(next_remind_at(T0, null, null, DAY)).toBeNull();
        expect(next_remind_at(T0, {}, null, DAY)).toBeNull();
    });

    it('every_min repeats from the opening, then from the last reminder', () => {
        expect(next_remind_at(T0, { every_min: 30 }, null, DAY)).toEqual(at(30));
        expect(next_remind_at(T0, { every_min: 30 }, at(31), DAY)).toEqual(at(61));
    });

    it('at_min nudges come in order, mixed with every_min ticks', () => {
        const r = { every_min: 60, at_min: [10, 90] };
        expect(next_remind_at(T0, r, null, DAY)).toEqual(at(10));
        expect(next_remind_at(T0, r, at(10), DAY)).toEqual(at(70));
        expect(next_remind_at(T0, r, at(70), DAY)).toEqual(at(90));
        expect(next_remind_at(T0, { at_min: [10] }, at(10), DAY)).toBeNull();
    });

    it('nothing at or after expiry', () => {
        expect(next_remind_at(T0, { every_min: 30 }, null, at(30))).toBeNull();
        expect(next_remind_at(T0, { at_min: [45] }, null, at(40))).toBeNull();
    });
});

describe('assert_answerable', () => {
    it('open and before expiry → fine', () => {
        expect(() => assert_answerable({ status: 'open', expires_at: at(1) }, T0)).not.toThrow();
    });
    it('past expires_at → 410 even while still open (the sweep may be behind)', () => {
        expect(() => assert_answerable({ status: 'open', expires_at: T0 }, T0)).toThrow(expect.objectContaining({ status_code: 410, code: 'HUG_EXPIRED' }));
        expect(() => assert_answerable({ status: 'expired', expires_at: at(5) }, T0)).toThrow(expect.objectContaining({ status_code: 410 }));
    });
    it('closed or cancelled → 409', () => {
        expect(() => assert_answerable({ status: 'closed', expires_at: at(5) }, T0)).toThrow(expect.objectContaining({ status_code: 409, code: 'HUG_CLOSED' }));
        expect(() => assert_answerable({ status: 'cancelled', expires_at: at(5) }, T0)).toThrow(expect.objectContaining({ status_code: 409 }));
    });
});
