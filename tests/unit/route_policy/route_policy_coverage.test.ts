/**
 * Meta-tests: every mounted Core route has exactly one policy, and the
 * sensitive lists (public, daemon-callable, site-admin) only change on purpose.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';

import { register_routes } from '../../../src/routes/index.js';
import { list_routes } from '../../../src/auth/route_policy/registry.js';
import { ROUTE_POLICY } from '../../../src/auth/route_policy/table.js';
import { check_route_policies } from '../../../src/middleware/enforce_route_policy.js';
import type { Container } from '../../../src/container.js';

/** Any controller, any method: routes only need handler functions to mount. */
function fake_container(): Container {
    const handler = () => undefined;
    const controller = new Proxy({}, {
        get: (_t, prop) => (prop === 'wrap' ? () => handler : handler),
    });
    return new Proxy({}, { get: () => controller }) as unknown as Container;
}

function mounted_routes(): string[] {
    const app = express();
    register_routes(app, fake_container());
    return list_routes(app);
}

describe('route policy coverage', () => {
    const routes = mounted_routes();

    it('mounts the full Core surface', () => {
        expect(routes.length).toBeGreaterThan(170);
    });

    it('every mounted route has a policy', () => {
        expect(check_route_policies(routes).missing).toEqual([]);
    });

    it('every policy belongs to a mounted route', () => {
        expect(check_route_policies(routes).stale).toEqual([]);
    });

    it('public routes are exactly these (change on purpose)', () => {
        const pub = Object.entries(ROUTE_POLICY)
            .filter(([, p]) => p.kind === 'public' || p.kind === 'bff_only' || p.kind === 'a2a_dispatch')
            .map(([k, p]) => `${p.kind} ${k}`).sort();
        expect(pub).toMatchInlineSnapshot(`
          [
            "a2a_dispatch POST /a2a/o/:org/r/:slug/send",
            "bff_only POST /internal/auth/authenticate_user",
            "bff_only POST /internal/auth/revoke_session_token",
            "bff_only POST /internal/auth/signup",
            "public GET /a2a/o/:org/r/:slug/.well-known/agent-card.json",
            "public GET /v1/health",
            "public POST /v1/integrations/jira/disconnect_workspace",
            "public POST /v1/integrations/jira/get_workspaces",
            "public POST /v1/integrations/jira/register_workspace",
            "public POST /v1/integrations/jira/rotate_secret",
            "public POST /v1/invitations/accept",
            "public POST /v1/invitations/get_by_token",
            "public POST /v1/teams/get",
          ]
        `);
    });

    it('daemon-callable routes are exactly these (replaces the daemon allowlist)', () => {
        const daemon = Object.entries(ROUTE_POLICY)
            .filter(([, p]) => p.kind === 'daemon_self' || p.kind === 'daemon_realm' || ('daemon' in p && p.daemon))
            .map(([k]) => k).sort();
        expect(daemon).toMatchInlineSnapshot(`
          [
            "POST /v1/artifacts/submit",
            "POST /v1/auth/acl",
            "POST /v1/daemons/ack_command",
            "POST /v1/daemons/deregister",
            "POST /v1/daemons/heartbeat",
            "POST /v1/daemons/register",
            "POST /v1/events/submit",
            "POST /v1/reviews/ack",
            "POST /v1/reviews/create",
            "POST /v1/reviews/get_by_id",
            "POST /v1/reviews/send_message",
            "POST /v1/runs/append_logs",
            "POST /v1/runs/claim",
            "POST /v1/runs/complete",
            "POST /v1/runs/create",
            "POST /v1/runs/report_activity",
            "POST /v1/runs/report_telemetry",
            "POST /v1/runs/resume",
            "POST /v1/runs/update_status",
            "POST /v1/settings/get",
            "POST /v1/settings/get_by_key",
          ]
        `);
    });

    it('site-admin routes never accept a daemon token for writes', () => {
        for (const [key, p] of Object.entries(ROUTE_POLICY)) {
            if (p.kind === 'site_admin' && p.daemon) {
                expect(key, key).toMatch(/\/settings\/get(_by_key)?$/);
            }
        }
    });
});
