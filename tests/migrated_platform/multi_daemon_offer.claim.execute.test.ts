/**
 * Slice 3d — Multi-daemon exclusive pickup.
 *
 * Two HTTP stub daemons receive /v1/offer_job; each races Hub claim.
 * Exactly one wins; Hub POSTs /v1/execute only to the winner.
 */

import http from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import {
    close_test_control_plane_store,
    open_test_control_plane_store,
    postgres_reachable,
} from './helpers/control_plane_store.js';
import * as outbox from '../../src/services/command_outbox.service.js';
import {
    Daemon,
    Realm,
    RealmMember,
    RealmDispatchQueue,
    Run,
} from '../../src/models/index.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import { QueueService } from '../../src/services/queue.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { ScopeService } from '../../src/services/control_scope_service.js';
import { TeamService } from '../../src/services/teams_install_service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `m3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Stub_daemon = {
    id: string;
    url: string;
    server: http.Server;
    offers: number;
    executes: Array<Record<string, unknown>>;
};

async function start_stub(daemon_id: string): Promise<Stub_daemon> {
    const state: Stub_daemon = {
        id: daemon_id,
        url: '',
        server: null as unknown as http.Server,
        offers: 0,
        executes: [],
    };

    state.server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString('utf8');
        const json = body ? JSON.parse(body) as Record<string, unknown> : {};

        if (req.method === 'POST' && req.url === '/v1/offer_job') {
            state.offers += 1;
            const queue_item_id = String(json.queue_item_id ?? '');
            try {
                await QueueService.claim(queue_item_id, daemon_id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, claimed: true, daemon_id }));
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, claimed: false, daemon_id }));
            }
            return;
        }

        if (req.method === 'POST' && req.url === '/v1/execute') {
            state.executes.push(json);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, accepted: true, run_id: json.run_id }));
            return;
        }

        res.writeHead(404);
        res.end();
    });

    await new Promise<void>((resolve) => {
        state.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = state.server.address() as AddressInfo;
    state.url = `http://127.0.0.1:${addr.port}`;
    return state;
}

async function stop_stub(stub: Stub_daemon): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        stub.server.close((err) => (err ? reject(err) : resolve()));
    });
}

describe.skipIf(!has_postgres)('multi-daemon offer + claim + execute (Slice 3)', () => {
    const user_id = hub_legacy_uuid(1);
    let realm_id: string;
    let workspace_id: string;
    let team_id: string;
    let scope_id: string;
    let stub_a: Stub_daemon;
    let stub_b: Stub_daemon;
    /** Spy on outbox enqueue — execute is now dispatched via the durable outbox. */
    const mock_enqueue = vi.fn();

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        mock_enqueue.mockResolvedValue({ tx_id: 'test-tx-id' });
        vi.spyOn(outbox, 'command_outbox_enqueue').mockImplementation(mock_enqueue);

        const realm = await RealmService.create(user_id, `m3-${uid()}`.slice(0, 40), 'Multi Daemon Realm');
        realm_id = realm.id;

        const scope = await ScopeService.add(`m3-scope-${uid()}`);
        scope_id = scope.id;
        const team_slug = `m3-team-${uid()}`;
        const registry_team = await TeamService.create(
            scope.id,
            team_slug,
            '1.0.0',
            null,
            'name: m3\nversion: "1.0.0"\nphases: []\n',
        );
        team_id = registry_team.get('id') as string;

        const { record } = await WorkspaceService.upsert_by_path(`/tmp/m3-ws-${uid()}`);
        workspace_id = record.id;

        stub_a = await start_stub(`daemon-a-${uid()}`);
        stub_b = await start_stub(`daemon-b-${uid()}`);

        for (const stub of [stub_a, stub_b]) {
            await Daemon.create({
                id: stub.id,
                api_key_hash: 'h',
                user_id,
                user_email: 'platform@test.local',
                hostname: 'stub',
                ip: '127.0.0.1',
                port: 0,
                public_url: stub.url,
                status: 'online',
                last_heartbeat: Date.now(),
                capacity: 5,
                created_at: Date.now(),
                last_registered_at: Date.now(),
            });
            await RealmService.upsert_daemon_member(realm_id, stub.id);
            // Install the team on this daemon so dispatch_claimed_run can
            // resolve `team_id` (a registry UUID) to a per-daemon Team row.
            // Mirrors what a real install flow writes.
            await TeamService.create(
                scope.id,
                team_slug,
                '1.0.0',
                null,
                'name: m3\nversion: "1.0.0"\nphases: []\n',
                { daemon_id: stub.id },
            );
        }
    }, 120_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        if (stub_a) await stop_stub(stub_a);
        if (stub_b) await stop_stub(stub_b);
        await RealmDispatchQueue.destroy({ where: { realm_id } });
        await RealmMember.destroy({ where: { realm_id } });
        await Realm.destroy({ where: { id: realm_id } });
        if (stub_a) await Daemon.destroy({ where: { id: stub_a.id } });
        if (stub_b) await Daemon.destroy({ where: { id: stub_b.id } });
        await close_test_control_plane_store();
    }, 120_000);

    it('3d two daemons offered; exactly one claims and receives execute', async () => {
        const { item } = await DispatchService.enqueue({
            realm_id,
            kind: 'run',
            user_id,
            scope_ids: [scope_id],
            payload: {
                workspace_id,
                team_id,
                workspace_path: `/tmp/m3-ws`,
                manifest_yaml: 'name: m3\nversion: "1.0.0"\nphases: []\n',
                run_name: 'multi-daemon-run',
            },
        });

        expect(stub_a.offers).toBe(1);
        expect(stub_b.offers).toBe(1);

        expect(item.status).toBe('running');
        expect(item.run_id).toBeTruthy();
        expect([stub_a.id, stub_b.id]).toContain(item.claimed_by);

        const winner = item.claimed_by === stub_a.id ? stub_a : stub_b;
        const loser = winner === stub_a ? stub_b : stub_a;

        // Execute is now dispatched via the durable outbox, not direct HTTP.
        // Verify the outbox enqueue was called with the winning daemon.
        const execute_calls = mock_enqueue.mock.calls.filter(
            (args: unknown[]) => args[1] === '/v1/execute',
        );
        expect(execute_calls).toHaveLength(1);
        expect(execute_calls[0]![0]).toBe(winner.id);
        expect(execute_calls[0]![2]).toEqual(
            expect.objectContaining({ run_id: item.run_id }),
        );

        // The stub daemons should NOT have received execute over HTTP.
        expect(winner.executes).toHaveLength(0);
        expect(loser.executes).toHaveLength(0);

        const run = await Run.findByPk(item.run_id!);
        expect(run).toBeTruthy();
        expect(run!.get('daemon_id')).toBe(winner.id);

        const final = await QueueService.get(item.id);
        expect(final.status).toBe('running');
        expect(final.claimed_by).toBe(winner.id);
    });
});
