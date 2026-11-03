/**
 * Realm team coverage + catalog install + site-admin catalog listing, on a
 * real Postgres (skipped without one).
 *
 * Pins:
 *  - realm-mode teams/get rows carry their scope and, for published teams,
 *    the catalog team id (also for roster teams no daemon has yet);
 *  - origin hub/cli comes from the catalog (`cliq.teams`), not
 *    daemon_teams (regression from the repository refactor);
 *  - /v1/teams/install accepts that catalog UUID;
 *  - site-admin `listed` / `scope` filters return rows with version_count.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { publish_version } from './helpers/version_files.js';
import { Daemon, DaemonTeam, Realm, RealmMember, Scope, Team, TeamVersion } from '../../src/models/index.js';
import { RealmService } from '../../src/services/realm.service.js';
import { RealmTeamListService } from '../../src/services/realm_team_list.service.js';
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
    let gamma_dt_id: string;   // gamma's daemon_teams row on d2 (a CLI team)
    const version_of: Record<string, string> = {};  // name@version → version id
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
            is_default: 0, created_at: new Date(),
        });

        const publish = async (name: string, listed: number, versions: Record<string, unknown> = { '1.0.0': {} }) => {
            const team = await Team.create({
                id: randomUUID(), name, scope: scope_slug, description: `${name} team`,
                author_id: user_id, license: 'MIT', visibility: 'public', listed, install_count: 0,
            } as any);
            // Each version's use_when / not_for / inputs are in its team.yml.
            for (const [version, capability] of Object.entries(versions)) {
                version_of[`${name}@${version}`] = await publish_version(team.id, version, { name: `@${scope_slug}/${name}`, ...(capability as object), phases: [] });
            }
            return team.id;
        };
        alpha_id = await publish('alpha', 1, {
            '1.0.0': {
                use_when: ['You have failed item IDs'], not_for: ['Finding failed documents'],
                inputs: [
                    { name: 'item_ids', required: true, description: 'The documents' },
                    { name: 'mode', required: false },
                    { name: 'work_root', required: true, default: 'parser-work' },
                ],
            },
            '1.1.0': { use_when: ['Newer text the realm does not run yet'], not_for: [], inputs: [] },
        });
        beta_id = await publish('beta', 0);

        const realm = await RealmService.create(user_id, uid().slice(0, 40), 'Coverage Realm');
        realm_id = realm.id;
        // The realm runs alpha at 1.0.0 and beta at its latest (realm_teams, PLAN-team-bundle S4.1). gamma was never
        // published, so it can't be on the realm's list: it shows up because a daemon has it (a CLI team).
        await RealmTeamListService.add(realm_id, user_id, { team_id: alpha_id, version_id: version_of['alpha@1.0.0'] });
        await RealmTeamListService.add(realm_id, user_id, { team_id: beta_id });

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

        // alpha on d1: a child of the realm's alpha (PLAN-team-bundle S4.2).
        const alpha_rt = (await RealmTeamListService.find(realm_id, alpha_id))!;
        const dt = await DaemonTeam.create({
            id: randomUUID(), daemon_id: d1, scope_id, slug: 'alpha', version: '1.0.0', description: null,
            team_id: alpha_id, realm_team_id: alpha_rt.id, version_id: alpha_rt.version_id,
            manifest: 'name: alpha\n', dockerfile: null, dependencies: null, created_at: Date.now(), updated_at: Date.now(),
        });
        alpha_dt_id = dt.id;
        gamma_dt_id = (await DaemonTeam.create({
            id: randomUUID(), daemon_id: d2, scope_id, slug: 'gamma', version: '0.1.0', description: null,
            manifest: 'name: gamma\n', dockerfile: null, dependencies: null, created_at: Date.now(), updated_at: Date.now(),
        })).id;
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await DaemonTeam.unscoped().destroy({ where: { scope_id } });
        await RealmMember.destroy({ where: { realm_id } });
        await Realm.destroy({ where: { id: realm_id } });
        await Daemon.destroy({ where: { id: [d1, d2] } });
        await TeamVersion.destroy({ where: { team_id: [alpha_id, beta_id] } });
        await Team.destroy({ where: { id: [alpha_id, beta_id] } });
        await Scope.destroy({ where: { id: scope_id } });
        await close_test_control_plane_store();
    });

    it('coverage rows: scope, origin from the catalog, catalog team_id for hub teams', async () => {
        const { rows } = await RealmService.list_team_coverage({ realm_id }, user_id);
        const by = Object.fromEntries(rows.map((r) => [r.slug, r]));

        expect(by.alpha).toMatchObject({
            scope: scope_slug, origin: 'hub', team_id: alpha_id, version_id: version_of['alpha@1.0.0'],
            sample_team_id: alpha_dt_id, installed_daemon_ids: [d1], in_team_list: true,
        });
        // On the roster, on no daemon: still installable by its catalog id.
        expect(by.beta).toMatchObject({
            scope: scope_slug, origin: 'hub', team_id: beta_id,
            sample_team_id: null, installed_daemon_ids: [],
        });
        // Never published, on a daemon only: no catalog id, not on the realm's list.
        expect(by.gamma).toMatchObject({ scope: scope_slug, origin: 'cli', team_id: null, version_id: null, sample_team_id: gamma_dt_id, in_team_list: false });
    });

    it('rows say when to use a team: the realm version\'s use_when / not_for, required inputs, description', async () => {
        const { rows } = await RealmService.list_team_coverage({ realm_id }, user_id);
        const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
        expect(by.alpha).toMatchObject({
            description: 'alpha team',
            use_when: ['You have failed item IDs'],
            not_for: ['Finding failed documents'],
            required_inputs: [{ name: 'item_ids', description: 'The documents' }],
        });
        // Never published: nothing known about it.
        expect(by.gamma).toMatchObject({ description: null, use_when: [], not_for: [], required_inputs: [] });
    });

    it('search matches what a team is for, not only its name', async () => {
        const { rows } = await RealmService.list_team_coverage({ realm_id, query: 'failed item' }, user_id);
        expect(rows.map((r) => r.slug)).toEqual(['alpha']);
    });

    it('teams/get realm mode: rows carry scope and the catalog id', async () => {
        const data = await call('get', { realm_id });
        const by = Object.fromEntries(data.items.map((t: any) => [t.slug, t]));
        // The realm's version by id: what "Update them" sends back to realms/add_team.
        expect(by.alpha).toMatchObject({ id: alpha_id, scope: scope_slug, origin: 'hub', version_id: version_of['alpha@1.0.0'] });
        expect(by.beta).toMatchObject({ id: beta_id, scope: scope_slug, origin: 'hub' });
        expect(by.gamma.id).toBeUndefined();
        expect(by.gamma.scope).toBe(scope_slug);
    });

    it('install by catalog UUID resolves the catalog team (no daemon had it)', async () => {
        mock_enqueue.mockClear();
        const result = await DispatchService.install_team({
            team_id: beta_id, daemon_ids: [d2], user_id, org_ids: [],
        });
        expect(result.results).toEqual([expect.objectContaining({ daemon_id: d2, ok: true })]);
        // Catalog ids only (S4.2): the daemon downloads the realm's version and gets its row id back.
        expect(mock_enqueue).toHaveBeenCalledWith(d2, '/v1/install', { team_id: beta_id, version_id: version_of['beta@1.0.0'], agent_settings: undefined });
        const row = await DaemonTeam.findOne({ where: { daemon_id: d2, team_id: beta_id }, raw: true }) as any;
        expect(row).toMatchObject({ realm_team_id: (await RealmTeamListService.find(realm_id, beta_id))!.id, version: '1.0.0' });
    });

    it('install by a daemon_teams id installs its catalog team, at the realm\'s version', async () => {
        mock_enqueue.mockClear();
        const result = await DispatchService.install_team({
            team_id: alpha_dt_id, daemon_ids: [d2], user_id, org_ids: [],
        });
        expect(result.results[0].ok).toBe(true);
        expect(mock_enqueue).toHaveBeenCalledWith(d2, '/v1/install', { team_id: alpha_id, version_id: version_of['alpha@1.0.0'], agent_settings: undefined });
    });

    it('site-admin listed / scope filters return the teams with version_count', async () => {
        const listed = await call('get', { scope: scope_slug, listed: true }, 'admin');
        expect(listed.total).toBe(1);
        expect(listed.items[0]).toMatchObject({
            // alpha has 1.0.0 (the realm's) and 1.1.0 (see the use_when test).
            id: alpha_id, name: 'alpha', scope: scope_slug, listed: true, version_count: 2,
            latest_version: '1.1.0', author_id: user_id,
        });

        const unlisted = await call('get', { scope: scope_slug, listed: false }, 'admin');
        expect(unlisted.items.map((t: any) => t.name)).toEqual(['beta']);

        const all = await call('get', { scope: scope_slug }, 'admin');
        expect(all.items.map((t: any) => t.name).sort()).toEqual(['alpha', 'beta']);
    });
});
