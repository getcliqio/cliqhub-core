/**
 * Authorization matrix — every route × every kind of caller, on live Postgres.
 *
 * The app here is the real token middleware + the real route policy middleware
 * (enforce mode, real Sequelize store) + a stub that answers 200 "reached". So a
 * cell tests exactly one thing: does the policy let this caller through to the
 * handler for this route and this record. Handler-level rules are covered by
 * the flow tests.
 *
 * Codes, one per caller in CALLERS order:
 *   Y = reaches the handler   1 = 401   3 = 403   4 = 404 (hidden)   0 = 400
 * Callers: anon sam olivia adam omar mia nora ben dA dB sdA  (see authz_seed.ts)
 *
 * Every route in the policy table must have a row here, or the suite fails.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, CALLERS, type Seed, type Caller } from '../helpers/authz_seed.js';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { create_route_policy_middleware } from '../../src/middleware/enforce_route_policy.js';
import { SequelizeAccessStore } from '../../src/auth/route_policy/store.js';
import { ROUTE_POLICY } from '../../src/auth/route_policy/table.js';

const has_postgres = await postgres_reachable();

type Body = (s: Seed) => Record<string, unknown>;
interface Row { expect: string; body?: Body }

// Common rows (see header for codes).
const ALL = 'YYYYYYYYYYY';
const SIGNED_IN = '1YYYYYYY333';
const SITE_ADMIN = '1Y333333333';
const SITE_ADMIN_DAEMON_READ = '1Y333333YYY';
const A1_VIEW = '1YYYYY44333';
const A1_OPERATE = '1YYYY344333';
const A1_ADMIN = '1YYY3344333';
const A1_DAEMON_WRITE = '1YYYY344Y4Y';
const ACME_MEMBER = '1YYYYYY4333';
const ACME_ADMIN_PERM = '1YYY3334333';
const ACME_OWNER_ONLY = '1YY33334333';
const TEAM_PRIVATE = '4Y444Y44444';
const DAEMON_SELF = '1YYYYYYYYYY'; // users allowed while ALLOW_PAT_DAEMON_WRITES is on
const DAEMON_ONLY = '13333333YYY'; // daemon lifecycle: daemon tokens only
const NO_REALM: Body = () => ({ realm_id: undefined }); // org branch of a realm-or-org route

const id = (k: keyof Seed): Body => (s) => ({ id: s[k] });

const MATRIX: Record<string, Row> = {
    // public / BFF-only
    'GET /v1/health': { expect: ALL },
    'GET /a2a/o/:org/r/:slug/.well-known/agent-card.json': { expect: ALL },
    'POST /a2a/o/:org/r/:slug/send': { expect: ALL },
    'POST /internal/auth/authenticate_user': { expect: ALL },
    'POST /internal/auth/signup': { expect: ALL },
    'POST /internal/auth/revoke_session_token': { expect: ALL },
    'POST /v1/invitations/get_by_token': { expect: ALL },
    'POST /v1/teams/get': { expect: ALL },
    'POST /v1/integrations/jira/get_workspaces': { expect: ALL },
    'POST /v1/integrations/jira/register_workspace': { expect: ALL },
    'POST /v1/integrations/jira/rotate_secret': { expect: ALL },
    'POST /v1/integrations/jira/disconnect_workspace': { expect: ALL },
    'POST /v1/teams/get_by_id': { expect: TEAM_PRIVATE },
    'POST /internal/auth/issue_session_token': { expect: SITE_ADMIN },

    // site admin
    'POST /v1/settings/set': { expect: SITE_ADMIN },
    'POST /v1/settings/remove': { expect: SITE_ADMIN },
    'POST /v1/settings/get': { expect: SITE_ADMIN_DAEMON_READ },
    'POST /v1/settings/get_by_key': { expect: SITE_ADMIN_DAEMON_READ },
    'POST /v1/system/seed': { expect: SITE_ADMIN },
    'POST /internal/users/new': { expect: SITE_ADMIN },
    'POST /internal/users/delete': { expect: SITE_ADMIN },
    'POST /internal/users/suspend': { expect: SITE_ADMIN },
    'POST /internal/users/unsuspend': { expect: SITE_ADMIN },
    'POST /internal/users/reset_password': { expect: SITE_ADMIN },
    'POST /internal/users/set_role': { expect: SITE_ADMIN },
    'POST /internal/orgs/new': { expect: SITE_ADMIN },
    'POST /internal/orgs/delete': { expect: SITE_ADMIN },
    'POST /internal/reports/audit': { expect: SITE_ADMIN },

    // signed in
    'POST /v1/account/mesh/get': { expect: SIGNED_IN },
    'POST /v1/account/mesh/update': { expect: SIGNED_IN },
    'POST /v1/auth/generate_token': { expect: SIGNED_IN },
    'POST /v1/auth/get_tokens': { expect: SIGNED_IN },
    'POST /v1/auth/validate_token': { expect: SIGNED_IN },
    'POST /v1/auth/revoke_token': { expect: SIGNED_IN },
    'POST /v1/auth/rotate_token': { expect: SIGNED_IN },
    'POST /v1/users/get': { expect: SIGNED_IN },
    'POST /v1/users/get_by_id': { expect: SIGNED_IN },
    'POST /v1/users/update': { expect: SIGNED_IN },
    'POST /internal/users/change_password': { expect: SIGNED_IN },
    'POST /v1/notifications/get': { expect: ACME_MEMBER },
    'POST /v1/permissions/list': { expect: SIGNED_IN },
    'POST /v1/mesh/adapters/list': { expect: SIGNED_IN },
    'POST /v1/events/types/list': { expect: SIGNED_IN },
    'POST /v1/orgs/get': { expect: SIGNED_IN },
    'POST /v1/orgs/new': { expect: SITE_ADMIN },
    'POST /v1/invitations/accept': { expect: ALL },
    'POST /v1/teams/create': { expect: SIGNED_IN },
    'POST /v1/teams/build': { expect: SIGNED_IN },
    'POST /v1/teams/publish': { expect: SIGNED_IN },

    // lists with a realm or org filter (default body names realm A1)
    'POST /internal/dashboard/summary': { expect: ACME_MEMBER },
    'POST /internal/dashboard/realms': { expect: ACME_MEMBER },
    'POST /v1/realms/get': { expect: ACME_MEMBER },
    'POST /v1/daemons/get': { expect: A1_VIEW },
    'POST /v1/reviews/get': { expect: A1_VIEW },
    'POST /v1/runs/get': { expect: A1_VIEW },
    'POST /v1/runs/get_logs': { expect: A1_VIEW },
    'POST /v1/workspaces/get': { expect: A1_VIEW },
    'POST /v1/notification_channels/get': { expect: A1_VIEW },
    'POST /v1/events/custom/list': { expect: A1_VIEW },
    'POST /v1/agents/get': { expect: ACME_MEMBER },

    // org
    'POST /v1/orgs/get_by_id': { expect: ACME_MEMBER },
    'POST /v1/orgs/get_reviewable_targets': { expect: ACME_MEMBER },
    'POST /v1/orgs/list_roles': { expect: ACME_MEMBER },
    'POST /v1/orgs/get_role': { expect: ACME_MEMBER },
    'POST /v1/orgs/get_scopes': { expect: ACME_MEMBER },
    'POST /v1/orgs/leave': { expect: ACME_MEMBER },
    'POST /v1/orgs/mesh/get': { expect: ACME_MEMBER },
    'POST /v1/orgs/get_notification_rules': { expect: ACME_MEMBER, body: NO_REALM },
    'POST /v1/orgs/update': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/mesh/update': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/delete': { expect: ACME_OWNER_ONLY },
    'POST /v1/orgs/remove_member': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/create_role': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/update_role': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/delete_role': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/new_scope': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/update_scope': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/delete_scope': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/assign_scope_member': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/unassign_scope_member': { expect: ACME_ADMIN_PERM },
    'POST /v1/orgs/set_notification_rules': { expect: ACME_OWNER_ONLY, body: NO_REALM },
    'POST /v1/orgs/remove_notification_rules': { expect: ACME_OWNER_ONLY, body: id('rule_acme') },
    'POST /v1/invitations/create': { expect: A1_ADMIN },
    'POST /v1/invitations/get': { expect: A1_ADMIN },
    'POST /v1/invitations/get_by_id': { expect: ACME_ADMIN_PERM },
    'POST /v1/invitations/revoke': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/update': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/remove_member': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/get_role': { expect: ACME_MEMBER },
    'POST /internal/orgs/create_role': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/update_role': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/delete_role': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/leave': { expect: ACME_MEMBER },
    'POST /internal/orgs/new_scope': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/update_scope': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/delete_scope': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/assign_scope_member': { expect: ACME_ADMIN_PERM },
    'POST /internal/orgs/unassign_scope_member': { expect: ACME_ADMIN_PERM },
    'POST /internal/users/update_role': { expect: ACME_ADMIN_PERM },
    'POST /v1/realms/create': { expect: ACME_ADMIN_PERM },

    // realm
    'POST /v1/realms/get_by_id': { expect: A1_VIEW },
    'POST /v1/realms/get_members': { expect: A1_VIEW },
    'POST /v1/realms/get_notification_rules': { expect: A1_VIEW },
    'POST /v1/realms/a2a': { expect: A1_ADMIN },
    'POST /v1/realms/update': { expect: A1_ADMIN },
    'POST /v1/realms/delete': { expect: A1_ADMIN },
    'POST /v1/realms/add_member': { expect: A1_ADMIN },
    'POST /v1/realms/remove_member': { expect: A1_ADMIN },
    'POST /v1/realms/add_team': { expect: A1_OPERATE },
    'POST /v1/realms/remove_team': { expect: A1_OPERATE },
    'POST /v1/realms/set_notification_rules': { expect: A1_OPERATE },
    'POST /v1/realms/remove_notification_rules': { expect: A1_OPERATE, body: id('rule_a1') },
    'POST /v1/notification_channels/create': { expect: A1_OPERATE },
    'POST /v1/notification_channels/update': { expect: A1_OPERATE, body: id('channel_a1') },
    'POST /v1/notification_channels/remove': { expect: A1_OPERATE, body: id('channel_a1') },
    'POST /v1/notification_channels/test': { expect: A1_ADMIN, body: id('channel_a1') },
    'POST /v1/agents/get_details': { expect: ACME_MEMBER },
    'POST /v1/agents/get_settings': { expect: A1_VIEW },
    'POST /v1/agents/update_settings': { expect: A1_OPERATE },
    'POST /v1/agents/register': { expect: ACME_ADMIN_PERM },
    'POST /v1/agents/deregister': { expect: ACME_ADMIN_PERM },
    'POST /v1/workspaces/get_by_id': { expect: A1_VIEW },
    'POST /v1/workspaces/remove': { expect: A1_ADMIN, body: id('workspace_a1') },
    'POST /v1/events/custom/create': { expect: A1_OPERATE },
    'POST /v1/events/custom/remove': { expect: A1_OPERATE, body: id('custom_event_a1') },
    'POST /v1/events/get_by_id': { expect: A1_VIEW, body: id('event_a1') },
    'POST /v1/events/submit': { expect: A1_DAEMON_WRITE },
    'POST /v1/auth/get_dispatch_public_key': { expect: A1_VIEW },
    'POST /v1/auth/rotate_dispatch_key': { expect: A1_ADMIN },

    // daemons
    'POST /v1/daemons/register': { expect: DAEMON_ONLY },
    'POST /v1/daemons/heartbeat': { expect: DAEMON_ONLY },
    'POST /v1/daemons/deregister': { expect: DAEMON_ONLY },
    'POST /v1/daemons/ack_command': { expect: DAEMON_ONLY },
    'POST /v1/auth/acl': { expect: DAEMON_ONLY },
    'POST /v1/runs/claim': { expect: DAEMON_SELF },
    'POST /v1/daemons/get_by_id': { expect: A1_VIEW },
    'POST /v1/daemons/remove': { expect: A1_ADMIN },

    // runs
    'POST /v1/runs/get_by_id': { expect: A1_VIEW },
    'POST /v1/runs/get_status': { expect: A1_VIEW },
    'POST /v1/runs/get_telemetry': { expect: A1_VIEW },
    'GET /v1/runs/stream': { expect: A1_VIEW },
    'POST /v1/runs/create': { expect: DAEMON_SELF },
    'POST /v1/runs/complete': { expect: A1_DAEMON_WRITE },
    'POST /v1/runs/resume': { expect: A1_DAEMON_WRITE },
    'POST /v1/runs/update_status': { expect: A1_DAEMON_WRITE },
    'POST /v1/runs/report_activity': { expect: A1_DAEMON_WRITE },
    'POST /v1/runs/append_logs': { expect: A1_DAEMON_WRITE },
    'POST /v1/runs/report_telemetry': { expect: A1_DAEMON_WRITE },
    'POST /v1/runs/cancel': { expect: A1_OPERATE },
    'POST /v1/runs/supply_inputs': { expect: A1_OPERATE },
    'POST /v1/runs/enqueue': { expect: A1_OPERATE },
    'POST /v1/runs/create_rdr': { expect: A1_OPERATE },
    'POST /v1/artifacts/get': { expect: A1_VIEW },
    'POST /v1/artifacts/get_by_id': { expect: A1_VIEW },
    'POST /v1/artifacts/submit': { expect: A1_DAEMON_WRITE },
    'POST /v1/artifacts/delete': { expect: A1_ADMIN },

    // reviews
    'POST /v1/reviews/create': { expect: A1_DAEMON_WRITE },
    'POST /v1/reviews/get_by_id': { expect: '1YYYYY44Y4Y' },
    'POST /v1/reviews/get_messages': { expect: A1_VIEW },
    'GET /v1/reviews/stream_messages': { expect: A1_VIEW },
    'POST /v1/reviews/verdict': { expect: A1_OPERATE },
    'POST /v1/reviews/send_message': { expect: A1_DAEMON_WRITE },
    'POST /v1/reviews/ack': { expect: A1_DAEMON_WRITE },

    // teams (default team = Mia's private team)
    'POST /v1/teams/get_phases': { expect: TEAM_PRIVATE },
    'POST /v1/teams/get_versions': { expect: TEAM_PRIVATE },
    'POST /v1/teams/download': { expect: TEAM_PRIVATE },
    'POST /v1/teams/update': { expect: TEAM_PRIVATE },
    'POST /v1/teams/rename': { expect: TEAM_PRIVATE },
    'POST /v1/teams/unpublish': { expect: TEAM_PRIVATE },
    'POST /v1/teams/delete': { expect: TEAM_PRIVATE },
    'POST /v1/teams/delete_version': { expect: TEAM_PRIVATE },
    'POST /v1/teams/install': { expect: A1_OPERATE },
    'POST /v1/teams/uninstall': { expect: A1_OPERATE },
};

/** Default request body: every id points at the Acme / A1 record of its kind. */
function default_body(s: Seed): Record<string, unknown> {
    return {
        realm_id: s.A1, org_id: s.acme, run_id: s.run_a1, review_id: s.review_a1,
        artifact_id: s.artifact_a1, daemon_id: s.daemon_a1, workspace_id: s.workspace_a1,
        invite_id: s.invite_acme, team_id: s.team_private,
    };
}

const CODE: Record<number, string> = { 200: 'Y', 401: '1', 403: '3', 404: '4', 400: '0' };

function concrete_path(key: string, s: Seed): [string, string] {
    const [method, path] = key.split(' ');
    return [method, path.replace(':org', 'acme').replace(':slug', s.A1)];
}

describe.skipIf(!has_postgres)('authorization matrix (route policy, enforce mode)', () => {
    let seed: Seed;
    let app: Express;
    let pat_off_app: Express;

    beforeAll(async () => {
        const live = await open_live_hub_app();
        seed = await seed_authz(live.app);

        const build = (allow_pat_daemon_writes: boolean): Express => {
            const a = express();
            a.use(express.json());
            a.use(create_auth_middleware({
                user_repo: live.container.user_repo,
                token_repo: live.container.token_repo,
                scope_repo: live.container.scope_repo,
                org_member_repo: live.container.org_member_repo,
            }));
            a.use(create_route_policy_middleware({ store: new SequelizeAccessStore(), mode: 'enforce', allow_pat_daemon_writes }));
            a.use((_req, res) => { res.status(200).json({ ok: true, reached: true }); });
            return a;
        };
        app = build(true);
        pat_off_app = build(false);
    }, 300_000);

    afterAll(async () => {
        await seed?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    it('every route in the policy table has a matrix row', () => {
        expect(Object.keys(ROUTE_POLICY).filter((k) => !MATRIX[k])).toEqual([]);
        expect(Object.keys(MATRIX).filter((k) => !ROUTE_POLICY[k])).toEqual([]);
    });

    async function row_for(key: string, allow_pat = true): Promise<string> {
        const row = MATRIX[key];
        const body = { ...default_body(seed), ...(row.body?.(seed) ?? {}) };
        const [method, path] = concrete_path(key, seed);
        let out = '';
        for (const who of CALLERS) {
            const target = allow_pat ? app : pat_off_app;
            let r = method === 'GET' ? request(target).get(path).query(body as Record<string, string>) : request(target).post(path).send(body);
            if (who !== 'anon') r = r.set('Authorization', `Bearer ${seed.token[who as Exclude<Caller, 'anon'>]}`);
            const res = await r;
            out += CODE[res.status] ?? `(${res.status})`;
        }
        return out;
    }

    it.each(Object.keys(MATRIX))('%s', async (key) => {
        expect(`${key}  ${await row_for(key)}`).toBe(`${key}  ${MATRIX[key].expect}`);
    });

    it('with ALLOW_PAT_DAEMON_WRITES off, user tokens cannot push daemon state', async () => {
        // Same rows, but every user token (sam … ben) is refused.
        const users_refused = (row: string) => row[0] + '3333333' + row.slice(8);
        for (const key of ['POST /v1/runs/complete', 'POST /v1/runs/append_logs', 'POST /v1/runs/create']) {
            expect(`${key}  ${await row_for(key, false)}`).toBe(`${key}  ${users_refused(MATRIX[key].expect)}`);
        }
    });
});
