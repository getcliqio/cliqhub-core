/**
 * Route policy of the two password routes that serve two callers each, told
 * apart by the body (`by_body`): users/reset_password (site admin with
 * `user_id`, or public with `email`) and users/change_password (signed in, or
 * public with `reset_token`).
 */
import { describe, it, expect } from 'vitest';

import { decide, type AccessStore } from '../../../src/auth/route_policy/engine.js';
import { by_body, public_, site_admin } from '../../../src/auth/route_policy/policy.js';
import { caller_auth, org_role_store, policy_status, type TestCaller } from '../../helpers/policy_decision.js';

const SITE: TestCaller = { id: 'sam', role: 'admin' };
const USER: TestCaller = { id: 'nora' };
const DAEMON: TestCaller = { id: 'sam', role: 'admin', daemon: { realm_id: 'R1' } };
const st = (route: string, caller: TestCaller | null, body: Record<string, unknown>) => policy_status(`POST ${route}`, caller, body);

describe('users/reset_password: site admin, or public with email', () => {
    const route = '/internal/users/reset_password';

    it('{ user_id }: site admin only', async () => {
        expect(await st(route, SITE, { user_id: 'u-2' })).toBe(200);
        expect(await st(route, USER, { user_id: 'u-2' })).toBe(403);
        expect(await st(route, DAEMON, { user_id: 'u-2' })).toBe(403);
        expect(await st(route, null, { user_id: 'u-2' })).toBe(401);
    });

    it('{ email }: anyone, signed in or not', async () => {
        for (const caller of [null, USER, SITE]) {
            expect(await st(route, caller, { email: 'priya@example.com' })).toBe(200);
        }
    });

    it('a blank email does not open the public rule', async () => {
        expect(await st(route, null, { email: '   ' })).toBe(401);
    });
});

describe('users/change_password: signed in, or public with reset_token', () => {
    const route = '/internal/users/change_password';

    it('{ current_password }: a signed-in user, never a daemon token', async () => {
        expect(await st(route, USER, { current_password: 'x', new_password: 'y' })).toBe(200);
        expect(await st(route, null, { current_password: 'x', new_password: 'y' })).toBe(401);
        expect(await st(route, DAEMON, { current_password: 'x', new_password: 'y' })).toBe(403);
    });

    it('{ reset_token }: public (the handler validates the token)', async () => {
        expect(await st(route, null, { reset_token: 'tok', new_password: 'y' })).toBe(200);
    });
});

describe('by_body', () => {
    const store: AccessStore = org_role_store();
    const policy = by_body('body.email', public_(), site_admin());
    const run = (body: Record<string, unknown>, caller: TestCaller | null) =>
        decide(policy, { method: 'POST', path: '/x', body, query: {}, params: {}, auth: caller_auth(caller) }, store, { allow_pat_daemon_writes: true });

    it('applies when_present when the field is there, otherwise the other policy', async () => {
        expect((await run({ email: 'a@b.c' }, null)).allow).toBe(true);
        expect(await run({}, null)).toMatchObject({ allow: false, status: 401 });
        expect(await run({}, USER)).toMatchObject({ allow: false, status: 403, reason: 'not_site_admin' });
        expect((await run({}, SITE)).allow).toBe(true);
    });
});
