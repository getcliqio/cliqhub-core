/**
 * Realm team coverage + catalog install + site-admin catalog listing, on a
 * real Postgres (skipped without one).
 *
 * Pins:
 *  - realm-mode teams/get rows carry their scope and, for published teams,
 *    the catalog team id (also for roster teams no daemon has yet);
 *  - origin published/local comes from the catalog (`cliq.teams`), not
 *    daemon_teams (regression from the repository refactor);
 *  - /v1/teams/install accepts that catalog UUID;
 *  - site-admin `listed` / `scope` filters return rows with version_count.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Daemon, DaemonTeam, Realm, RealmMember, Scope, Team, TeamVersion } from '../../src/models/index.js';
import { RealmService } from '../../src/services/realm.service.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import { TeamsService } from '../../src/services/teams_service.js';
import { TeamsController } from '../../src/controllers/teams_controller.js';
import { TeamRepository } from '../../src/repositories/team_repository.js';
import { TeamVersionRepository } from '../../src/repositories/team_version_repository.js';
import { TagRepository } from '../../src/repositories/tag_repository.js';
import { DownloadLogRepository } from '../../src/repositories/download_log_repository.js';
import { ScopeRepository } from '../../src/repositories/scope_repository.js';
import { AuditRepository } from '../../src/repositories/audit_repository.js';
import * as outbox from '../../src/services/command_outbox.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `cov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('realm team coverage + catalog install', () => {
    const user_id = hub_legacy_uuid(1);
    const scope_slug = uid().slice(0, 40);
    let scope_id: string;
    let realm_id: string;
    let d1: string;
    let d2: string;
    let alpha_id: string;      // published, installed on d1
    let beta_id: string;       // published, on the roster, on no daemon
    let alpha_dt_id: string;   // alpha's daemon_teams row on d1
    const mock_enqueue = vi.fn().mockResolvedValue({ tx_id: 'tx' });

    const teams_controller = () => new TeamsController(new TeamsService(
        new TeamRepository() as any, new TeamVersionRepository() as any, new TagRepository() as any,
        new DownloadLogRepository() as any, {} as any, '/tmp/test',
        new ScopeRepository() as any, new AuditRepository() as any,
    ));

    /** Calls a controller method like Express would; returns `data`. */
    async function call(method: 'get', body: unknown, role: 'user' | 'admin' = 'user'): Promise<any> {
        let sent: any;
        const req = {
            body,
            auth: {
                user: { id: user_id, role, username: 'u' },
                org_ids: [], org_slugs: [], scopes: [],
            },
        } as unknown as Request;
        const res = {
            status() { return res; },
            json(b: unknown) { sent = b; return res; },
        } as unknown as Response;
        const c = teams_controller();
        await c[method](req as any, res as any);
        return sent.data;
    }

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        vi.spyOn(outbox, 'command_outbox_enqueue').mockImplementation(mock_enqueue);

        scope_id = randomUUID();
        await Scope.create({
            id: scope_id, slug: scope_slug, display_name: 'Coverage', owner_id: null, org_id: null,
            visibility: 'public', scope_type: 'platform', is_default: 0, created_at: new Date(),
        });

        const publish = async (name: string, listed: number) => {
            const team = await Team.create({
                id: randomUUID(), name, scope: scope_slug, scope_type: 'org', description: `${name} team`,
                author_id: user_id, license: 'MIT', visibility: 'public', listed, install_count: 0,
            } as any);
            await TeamVersion.create({
                id: randomUUID(), team_id: team.id, version: '1.0.0', changelog: '', package_path: '/tmp/x.zip',
                workflow_json: JSON.stringify({ phases: [] }), manifest_yaml: '', readme: '',
                capability_json: '{}', agents_json: '{}', roles_json: '[]', tools: '[]', published_at: new Date(),
            } as any);
            return team.id;
        };
        alpha_id = await publish('alpha', 1);
        beta_id = await publish('beta', 0);

        const realm = await RealmService.create(user_id, uid().slice(0, 40), 'Coverage Realm');
        realm_id = realm.id;
        await Realm.update(
            { team_list: [
                { scope: scope_slug, slug: 'alpha' },
                { scope: scope_slug, slug: 'beta' },
                { scope: scope_slug, slug: 'gamma' },
            ] } as any,
            { where: { id: realm_id } },
        );

        d1 = uid();
        d2 = uid();
        for (const id of [d1, d2]) {
            await Daemon.create({
                id, api_key_hash: 'h', user_id: null, user_email: null, hostname: 'pod', ip: '127.0.0.1',
                port: 4900, public_url: `https://daemon.test/${id}`, status: 'online',
                last_heartbeat: Date.now(), capacity: 5, created_at: Date.now(), last_registered_at: Date.now(),
            });
            await RealmService.upsert_daemon_member(realm_id, id);
        }

        const dt = await DaemonTeam.create({
            id: randomUUID(), daemon_id: d1, scope_id, slug: 'alpha', version: '1.0.0', description: null,
            manifest: 'name: alpha\n', dockerfile: null, dependencies: null, created_at: Date.now(), updated_at: Date.now(),
        });
        alpha_dt_id = dt.id;
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await DaemonTeam.destroy({ where: { scope_id } });
        await RealmMember.destroy({ where: { realm_id } });
        await Realm.destroy({ where: { id: realm_id } });
        await Daemon.destroy({ where: { id: [d1, d2] } });
        await TeamVersion.destroy({ where: { team_id: [alpha_id, beta_id] } });
        await Team.destroy({ where: { id: [alpha_id, beta_id] } });
        await Scope.destroy({ where: { id: scope_id } });
        await close_test_control_plane_store();
    });

    it('coverage rows: scope, origin from the catalog, catalog team_id for published teams', async () => {
        const { rows } = await RealmService.list_team_coverage({ realm_id }, user_id);
        const by = Object.fromEntries(rows.map((r) => [r.slug, r]));

        expect(by.alpha).toMatchObject({
            scope: scope_slug, origin: 'published', team_id: alpha_id,
            sample_team_id: alpha_dt_id, installed_daemon_ids: [d1], in_team_list: true,
        });
        // On the roster, on no daemon: still installable by its catalog id.
        expect(by.beta).toMatchObject({
            scope: scope_slug, origin: 'published', team_id: beta_id,
            sample_team_id: null, installed_daemon_ids: [],
        });
        // Never published: nothing to install from.
        expect(by.gamma).toMatchObject({ scope: scope_slug, origin: 'local', team_id: null, sample_team_id: null });
    });

    it('teams/get realm mode: rows carry scope and the catalog id', async () => {
        const data = await call('get', { realm_id });
        const by = Object.fromEntries(data.items.map((t: any) => [t.slug, t]));
        expect(by.alpha).toMatchObject({ id: alpha_id, scope: scope_slug, origin: 'published' });
        expect(by.beta).toMatchObject({ id: beta_id, scope: scope_slug, origin: 'published' });
        expect(by.gamma.id).toBeUndefined();
        expect(by.gamma.scope).toBe(scope_slug);
    });

    it('install by catalog UUID resolves the catalog team (no daemon had it)', async () => {
        mock_enqueue.mockClear();
        const result = await DispatchService.install_team({
            team_id: beta_id, daemon_ids: [d2], user_id, scope_ids: [scope_id], org_ids: [],
        });
        expect(result.results).toEqual([expect.objectContaining({ daemon_id: d2, ok: true })]);
        expect(mock_enqueue).toHaveBeenCalledWith(
            d2, '/v1/install', expect.objectContaining({ scope: scope_slug, slug: 'beta', version: '1.0.0' }),
        );
        const row = await DaemonTeam.findOne({ where: { daemon_id: d2, scope_id, slug: 'beta' } });
        expect(row).not.toBeNull();
    });

    it('install by a daemon_teams id still works (fallback path)', async () => {
        mock_enqueue.mockClear();
        const result = await DispatchService.install_team({
            team_id: alpha_dt_id, daemon_ids: [d2], user_id, scope_ids: [scope_id], org_ids: [],
        });
        expect(result.results[0].ok).toBe(true);
    });

    it('site-admin listed / scope filters return the teams with version_count', async () => {
        const listed = await call('get', { scope: scope_slug, listed: true }, 'admin');
        expect(listed.total).toBe(1);
        expect(listed.items[0]).toMatchObject({
            id: alpha_id, name: 'alpha', scope: scope_slug, listed: true, version_count: 1,
            latest_version: '1.0.0', author_id: user_id,
        });

        const unlisted = await call('get', { scope: scope_slug, listed: false }, 'admin');
        expect(unlisted.items.map((t: any) => t.name)).toEqual(['beta']);

        const all = await call('get', { scope: scope_slug }, 'admin');
        expect(all.items.map((t: any) => t.name).sort()).toEqual(['alpha', 'beta']);
    });
});
