/** in_parallel: every item is worked once, never more than `limit` at a time, and the first error is thrown. */
import { describe, expect, it } from 'vitest';
import { in_parallel } from '../../../src/lib/in_parallel.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('in_parallel', () => {
    it('works every item once, at most limit at a time', async () => {
        let running = 0;
        let most = 0;
        const seen: number[] = [];
        await in_parallel([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            running += 1;
            most = Math.max(most, running);
            await tick();
            seen.push(n);
            running -= 1;
        });
        expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(most).toBe(3);
    });

    it('nothing to do', async () => {
        await expect(in_parallel([], 4, async () => { throw new Error('no'); })).resolves.toBeUndefined();
    });

    it('throws the first error and starts nothing after it', async () => {
        const started: number[] = [];
        await expect(in_parallel([1, 2, 3, 4], 1, async (n) => {
            started.push(n);
            if (n === 2) throw new Error('two');
        })).rejects.toThrow('two');
        expect(started).toEqual([1, 2]);
    });
});
