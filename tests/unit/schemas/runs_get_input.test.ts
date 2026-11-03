/** runs/get input: which filters bound tenancy without an org_id. */
import { describe, it, expect } from 'vitest';
import { RunsEnqueueInput, RunsGetInput } from '../../../src/schemas/run_types.js';

describe('RunsGetInput', () => {
    it('a team filter (by id) needs no org_id', () => {
        expect(RunsGetInput.safeParse({ team_id: '6f5d7e65-f5bf-47dd-bc7c-33422d4ba971' }).success).toBe(true);
    });

    it('the old team filter by name is refused, not ignored (S4.3)', () => {
        const r = RunsGetInput.safeParse({ team: { scope: 'measureone', slug: 'qa' } });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toContain('replaced by team_id');
    });

    it('an unkeyed list still needs org_id', () => {
        const r = RunsGetInput.safeParse({});
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toContain('org_id is required');
    });
});

describe('RunsEnqueueInput', () => {
    it('manifest_yaml is refused: a run uses the team installed on its daemon (S5.6)', () => {
        const team_id = '6f5d7e65-f5bf-47dd-bc7c-33422d4ba971';
        const realm_id = '5b0c3a7e-2f4d-4b8e-9a51-7c1d2e3f4a5b';
        const r = RunsEnqueueInput.safeParse({ realm_id, team_id, manifest_yaml: 'name: x\nphases: []\n' });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toContain('no longer accepted');
        expect(RunsEnqueueInput.safeParse({ realm_id, team_id }).success).toBe(true);
    });
});
