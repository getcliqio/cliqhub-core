/** runs/get input: which filters bound tenancy without an org_id. */
import { describe, it, expect } from 'vitest';
import { RunsGetInput } from '../../../src/schemas/run_types.js';

describe('RunsGetInput', () => {
    it('a team filter (by id or by name) needs no org_id', () => {
        expect(RunsGetInput.safeParse({ team: { scope: 'measureone', slug: 'qa' } }).success).toBe(true);
        expect(RunsGetInput.safeParse({ team_id: '6f5d7e65-f5bf-47dd-bc7c-33422d4ba971' }).success).toBe(true);
    });

    it('an unkeyed list still needs org_id', () => {
        const r = RunsGetInput.safeParse({});
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toContain('org_id is required');
    });
});
