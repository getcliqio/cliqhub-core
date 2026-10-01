/**
 * Core API 5 — teams (S14), agents and notification channels route files.
 * Production app, default mode (these route files are always enforced).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { Team } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('teams, agents and channels access (Core API 5)', () => {
    let app: Express;
    let s: Seed;
    let team_unlisted = '';
    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send(body);
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };

    beforeAll(async () => {
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
        team_unlisted = randomUUID();
        await Team.create({ id: team_unlisted, name: `azunl${s.stamp}`, scope: 'cliq', visibility: 'public', listed: 0, author_id: s.user.ben } as never);
    }, 300_000);

    afterAll(async () => {
        await Team.destroy({ where: { id: team_unlisted } }).catch(() => {});
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    describe('S14 — private team workflow and versions', () => {
        it('get_versions / get_phases of a private team: author yes; anonymous and others 404', async () => {
            const name = `azpriv${s.stamp}`;
            expect((await post('/v1/teams/get_versions', null, { name })).status).toBe(404);
            expect((await post('/v1/teams/get_versions', s.token.ben, { name })).status).toBe(404);
            expect((await post('/v1/teams/get_versions', s.token.mia, { name })).status).toBe(200);
            expect((await post('/v1/teams/get_phases', null, { team_id: s.team_private })).status).toBe(404);
            expect((await post('/v1/teams/get_phases', s.token.ben, { team_id: s.team_private })).status).toBe(404);
        });

        it('get_by_id without signing in: listed public teams only (decision 6)', async () => {
            expect((await post('/v1/teams/get_by_id', null, { team_id: s.team_public })).status).toBe(200);
            expect((await post('/v1/teams/get_by_id', null, { team_id: team_unlisted })).status).toBe(404);
            expect((await post('/v1/teams/get_by_id', s.token.nora, { team_id: team_unlisted })).status).toBe(200);
            expect((await post('/v1/teams/get_by_id', null, { team_id: s.team_private })).status).toBe(404);
        });
    });

    describe('agents', () => {
        it('realm settings need standing in that realm, not only the org permission', async () => {
            // Omar's org role (operator) has agents.view, but he was never added to A2.
            expect((await post('/v1/agents/get_settings', s.token.omar, { org_id: s.acme, realm_id: s.A2 })).status).toBe(404);
            expect((await post('/v1/agents/get_settings', s.token.omar, { org_id: s.acme, realm_id: s.A1 })).status).toBe(200);
            expect((await post('/v1/agents/update_settings', s.token.omar, { org_id: s.acme, realm_id: s.A2, id: randomUUID(), settings: { values: {} } })).status).toBe(404);
            expect((await post('/v1/agents/update_settings', s.token.mia, { org_id: s.acme, realm_id: s.A1, id: randomUUID(), settings: { values: {} } })).status).toBe(403);
        });

        it('another org and daemon tokens are refused', async () => {
            expect((await post('/v1/agents/get', s.token.ben, { org_id: s.acme })).status).toBe(404);
            expect((await post('/v1/agents/get', s.token.dA, { org_id: s.acme })).status).toBe(403);
            expect((await post('/v1/agents/get', s.token.mia, { org_id: s.acme })).status).toBe(200);
        });
    });

    describe('notification channels', () => {
        it('realm channels: viewer reads, operator edits, another org 404', async () => {
            expect((await post('/v1/notification_channels/get', s.token.mia, { realm_id: s.A1 })).status).toBe(200);
            expect((await post('/v1/notification_channels/get', s.token.ben, { realm_id: s.A1 })).status).toBe(404);
            expect((await post('/v1/notification_channels/update', s.token.mia, { id: s.channel_a1, name: 'x' })).status).toBe(403);
            expect((await post('/v1/notification_channels/update', s.token.omar, { id: s.channel_a1, name: `a1-${s.stamp}` })).status).toBe(200);
            expect((await post('/v1/notification_channels/update', s.token.ben, { id: s.channel_a1, name: 'x' })).status).toBe(404);
        });

        it('sending a test needs channels.test (admins), not just operate', async () => {
            expect((await post('/v1/notification_channels/test', s.token.omar, { id: s.channel_a1 })).status).toBe(403);
        });

        it('org channels use the org permission', async () => {
            expect((await post('/v1/notification_channels/update', s.token.omar, { id: s.channel_acme, name: 'x' })).status).toBe(403);
            expect((await post('/v1/notification_channels/update', s.token.adam, { id: s.channel_acme, name: `acme-${s.stamp}` })).status).toBe(200);
        });

        it('the inbox is for signed-in users, not daemon tokens', async () => {
            expect((await post('/v1/notifications/get', s.token.mia, { org_id: s.acme })).status).toBe(200);
            expect((await post('/v1/notifications/get', s.token.dA, { org_id: s.acme })).status).toBe(403);
        });
    });
});
