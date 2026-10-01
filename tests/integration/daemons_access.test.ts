/**
 * Core API 5 — daemons and workspaces route files (S16, S26). Production app,
 * default mode (daemons/ and workspaces/ routes are always enforced).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { Daemon, RealmMember, Workspace } from '../../src/models/index.js';
import { get_control_plane_store } from '../../src/db/control_plane_store.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('daemons and workspaces access (Core API 5)', () => {
    let app: Express;
    let s: Seed;
    const daemons: string[] = [];
    const workspaces: string[] = [];
    const commands: string[] = [];
    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send({ tx_id: randomUUID(), ...body });
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };

    async function daemon_in(...realm_ids: string[]): Promise<string> {
        const id = `azd${randomUUID().slice(0, 8)}`;
        daemons.push(id);
        await Daemon.create({ id, api_key_hash: 'x', created_at: Date.now(), last_registered_at: Date.now() } as never);
        for (const realm_id of realm_ids) {
            await RealmMember.create({ id: randomUUID(), realm_id, member_type: 'daemon', member_id: id, role: 'operator', created_at: Date.now() } as never);
        }
        return id;
    }

    async function workspace_on(daemon_id: string): Promise<{ id: string; path: string }> {
        const id = `azw${randomUUID().slice(0, 8)}`;
        const path = `/tmp/${id}`;
        workspaces.push(id);
        await Workspace.create({ id, path, daemon_id, created_at: Date.now(), updated_at: Date.now() } as never);
        return { id, path };
    }

    async function command_for(daemon_id: string): Promise<string> {
        const tx = randomUUID();
        commands.push(tx);
        await get_control_plane_store().sequelize.query(
            `INSERT INTO cliq.command_outbox (tx_id, daemon_id, endpoint, payload, created_at) VALUES (?, ?, '/v1/test', '{}'::jsonb, ?)`,
            { replacements: [tx, daemon_id, Date.now()] },
        );
        return tx;
    }

    beforeAll(async () => {
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        if (commands.length) {
            await get_control_plane_store().sequelize.query('DELETE FROM cliq.command_outbox WHERE tx_id IN (?)', { replacements: [commands] }).catch(() => {});
        }
        await Workspace.destroy({ where: { id: workspaces } }).catch(() => {});
        await RealmMember.destroy({ where: { member_id: daemons } }).catch(() => {});
        await Daemon.destroy({ where: { id: daemons } }).catch(() => {});
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    describe('reading daemons', () => {
        it('viewer and org owner read a realm daemon; another org gets 404', async () => {
            expect((await post('/v1/daemons/get_by_id', s.token.mia, { daemon_id: s.daemon_a1 })).status).toBe(200);
            expect((await post('/v1/daemons/get_by_id', s.token.olivia, { daemon_id: s.daemon_a1 })).status).toBe(200);
            expect((await post('/v1/daemons/get_by_id', s.token.ben, { daemon_id: s.daemon_a1 })).status).toBe(404);
            expect((await post('/v1/daemons/get', s.token.ben, { realm_id: s.A1 })).status).toBe(404);
        });
    });

    describe('S16 — removing a daemon', () => {
        it('viewers and operators cannot; another org gets 404', async () => {
            const d = await daemon_in(s.A1);
            expect((await post('/v1/daemons/remove', s.token.mia, { daemon_id: d })).status).toBe(403);
            expect((await post('/v1/daemons/remove', s.token.omar, { daemon_id: d })).status).toBe(403);
            expect((await post('/v1/daemons/remove', s.token.ben, { daemon_id: d })).status).toBe(404);
        });

        it('a realm admin removes a daemon that serves only their realms', async () => {
            const d = await daemon_in(s.A1);
            expect((await post('/v1/daemons/remove', s.token.olivia, { daemon_id: d })).status).toBe(200);
        });

        it('a daemon shared with another org’s realm needs admin there too', async () => {
            const d = await daemon_in(s.A1, s.B1);
            expect((await post('/v1/daemons/remove', s.token.olivia, { daemon_id: d })).status).toBe(403);
            expect((await post('/v1/daemons/remove', s.token.sam, { daemon_id: d })).status).toBe(200);
        });
    });

    describe('daemon self-service', () => {
        it('heartbeat needs a daemon token for a daemon of its realm', async () => {
            expect((await post('/v1/daemons/heartbeat', s.token.omar, { daemon_id: s.daemon_a1 })).status).toBe(403);
            expect((await post('/v1/daemons/heartbeat', s.token.dB, { daemon_id: s.daemon_a1 })).status).toBe(403);
        });
    });

    describe('S26 — acknowledging commands', () => {
        it('another realm’s daemon cannot ack', async () => {
            const tx = await command_for(s.daemon_a1);
            expect((await post('/v1/daemons/ack_command', s.token.dB, { command_tx_id: tx, daemon_id: s.daemon_a1, status: 'ok' })).status).toBe(403);
        });

        it('a daemon cannot ack a command addressed to another daemon', async () => {
            const other = await daemon_in(s.A1);
            const tx = await command_for(s.daemon_a1);
            expect((await post('/v1/daemons/ack_command', s.token.dA, { command_tx_id: tx, daemon_id: other, status: 'ok' })).status).toBe(404);
        });

        it('the addressed daemon acks its own command', async () => {
            const tx = await command_for(s.daemon_a1);
            expect((await post('/v1/daemons/ack_command', s.token.dA, { command_tx_id: tx, daemon_id: s.daemon_a1, status: 'ok' })).status).toBe(200);
            const [rows] = await get_control_plane_store().sequelize.query('SELECT acked_at FROM cliq.command_outbox WHERE tx_id = ?', { replacements: [tx] });
            expect((rows as Array<{ acked_at: number | null }>)[0].acked_at).toBeTruthy();
        });
    });

    describe('workspaces', () => {
        it('read: viewer yes, another org 404', async () => {
            const w = await workspace_on(s.daemon_a1);
            expect((await post('/v1/workspaces/get_by_id', s.token.mia, { workspace_id: w.id })).status).toBe(200);
            expect((await post('/v1/workspaces/get_by_id', s.token.ben, { workspace_id: w.id })).status).toBe(404);
        });

        it('remove by path needs realm admin (the policy cannot see a path)', async () => {
            const w = await workspace_on(s.daemon_a1);
            expect((await post('/v1/workspaces/remove', s.token.mia, { path: w.path })).status).toBe(403);
            expect((await post('/v1/workspaces/remove', s.token.ben, { path: w.path })).status).toBe(404);
            const ok = await post('/v1/workspaces/remove', s.token.olivia, { path: w.path });
            expect(ok.status).toBe(200);
            expect(ok.body.removed).toBeTruthy();
        });

        it('remove by id: viewer 403, admin 200', async () => {
            const w = await workspace_on(s.daemon_a1);
            expect((await post('/v1/workspaces/remove', s.token.mia, { id: w.id })).status).toBe(403);
            expect((await post('/v1/workspaces/remove', s.token.adam, { id: w.id })).status).toBe(200);
        });
    });
});
