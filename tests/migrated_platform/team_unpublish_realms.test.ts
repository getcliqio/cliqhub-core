/**
 * teams/unpublish takes the team off every realm that has it — all or nothing (real Postgres).
 *
 *  - the caller can remove it everywhere → every team list loses it, it's a draft, daemons are told;
 *  - a realm where the caller is only a member, or one they can't see → 403 `unpublish_blocked`,
 *    nothing changes (team lists and visibility untouched, no uninstall sent).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { publish_version, test_package_storage } from './helpers/version_files.js';
import { version_content } from '../../src/services/version_content.js';
import { Realm, RealmMember, Scope, Team, TeamVersion } from '../../src/models/index.js';
import { RealmService } from '../../src/services/realm.service.js';
import { RealmTeamListService } from '../../src/services/realm_team_list.service.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import { TeamsService } from '../../src/services/teams_service.js';
import { TeamRepository } from '../../src/repositories/team_repository.js';
import { TeamVersionRepository } from '../../src/repositories/team_version_repository.js';
import { TagRepository } from '../../src/repositories/tag_repository.js';
import { DownloadLogRepository } from '../../src/repositories/download_log_repository.js';
import { ScopeRepository } from '../../src/repositories/scope_repository.js';
import { AuditRepository } from '../../src/repositories/audit_repository.js';

const has_postgres = await postgres_reachable();
const uid = () => `unp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('teams/unpublish: off every realm, all or nothing', () => {
    const author = hub_legacy_uuid(1);
    const other = hub_legacy_uuid(2);
    const scope_slug = uid().slice(0, 40);
    const service = new TeamsService(
        new TeamRepository() as any, new TeamVersionRepository() as any, new TagRepository() as any,
        new DownloadLogRepository() as any, test_package_storage(), '/tmp/test',
        new ScopeRepository() as any, new AuditRepository() as any,
    );
    const auth = { user: { id: author, role: 'user', username: 'author' }, org_ids: [], org_slugs: [], scopes: [{ id: 's', slug: scope_slug }] } as any;
    const uninstall = vi.fn();

    async function team_named(name: string, files: { team_yml?: string; other?: Record<string, string> } = {}): Promise<string> {
        const team = await Team.create({
            id: randomUUID(), name, scope: scope_slug, description: name,
            author_id: author, license: 'MIT', visibility: 'public', listed: 1, install_count: 0,
        } as any);
        await publish_version(team.id, '1.0.0', files.team_yml ?? { name: `@${scope_slug}/${name}`, phases: [] }, files.other);
        return team.id;
    }
    let keep_me_id = '';
    /** A realm that runs exactly `team` (a catalog id) and keep-me. */
    async function realm_with(owner: string, team: string): Promise<string> {
        // The realm runs exactly this team and keep-me (realm_teams, PLAN-team-bundle S4.1).
        const r = await RealmService.create(owner, uid().slice(0, 40), 'Unpublish');
        for (const e of await RealmTeamListService.entries(r.id)) await RealmTeamListService.remove(r.id, owner, e.team_id);
        for (const team_id of [team, keep_me_id]) await RealmTeamListService.add(r.id, owner, { team_id });
        return r.id;
    }
    const list_of = async (realm_id: string) => (await RealmTeamListService.entries(realm_id)).map((e) => ({ scope: e.scope, slug: e.slug }));
    const visibility = async (id: string) => ((await Team.findByPk(id, { raw: true })) as any).visibility;

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        await Scope.create({ id: randomUUID(), slug: scope_slug, display_name: 'Unpublish', owner_id: author, org_id: null, is_default: 0, created_at: new Date() } as any);
        keep_me_id = await team_named('keep-me'); // the other team on each realm, which unpublishing another team leaves alone
    });
    beforeEach(() => {
        uninstall.mockReset().mockResolvedValue({ daemons: [] });
        vi.spyOn(DispatchService, 'uninstall_team').mockImplementation(uninstall);
    });
    afterAll(async () => {
        vi.restoreAllMocks();
        // A scope with no org makes the team-visibility migration complain on every later start: leave none behind.
        await Team.destroy({ where: { scope: scope_slug } });
        await Scope.destroy({ where: { slug: scope_slug } });
        await close_test_control_plane_store();
    });

    it('removes it from every realm, then makes it a draft; other teams stay; daemons are told', async () => {
        const id = await team_named('everywhere');
        const a = await realm_with(author, id);
        const b = await realm_with(author, id);
        const res = await service.unpublish(auth, { name: 'everywhere', scope: scope_slug });
        expect(res.status).toBe('draft');
        expect(res.uninstalled_from.map((r) => r.realm_id).sort()).toEqual([a, b].sort());
        for (const r of [a, b]) expect(await list_of(r)).toEqual([{ scope: scope_slug, slug: 'keep-me' }]);
        expect(await visibility(id)).toBe('draft');
        expect(uninstall.mock.calls.map((c) => c[0].realm_id).sort()).toEqual([a, b].sort());
    });

    it('a realm where the caller is only a member blocks it: nothing changes', async () => {
        const id = await team_named('member-only');
        const mine = await realm_with(author, id);
        const theirs = await realm_with(other, id);
        await RealmMember.create({ id: randomUUID(), realm_id: theirs, member_type: 'user', member_id: author, role: 'member', created_at: Date.now() } as any);
        const slug = ((await Realm.findByPk(theirs, { raw: true })) as any).slug;
        await expect(service.unpublish(auth, { name: 'member-only', scope: scope_slug })).rejects.toMatchObject({
            code: 'unpublish_blocked', status: 403, details: { blocked: [{ realm_id: theirs, realm_slug: slug }], hidden: 0 },
        });
        expect((await list_of(mine)).some((e) => e.slug === 'member-only')).toBe(true);
        expect((await list_of(theirs)).some((e) => e.slug === 'member-only')).toBe(true);
        expect(await visibility(id)).toBe('public');
        expect(uninstall).not.toHaveBeenCalled();
    });

    it('a realm the caller can’t see blocks it too, counted but not named', async () => {
        const id = await team_named('hidden-realm');
        await realm_with(author, id);
        await realm_with(other, id);
        const err = await service.unpublish(auth, { name: 'hidden-realm', scope: scope_slug }).catch((e) => e);
        expect(err).toMatchObject({ code: 'unpublish_blocked', details: { blocked: [], hidden: 1 } });
        expect(err.message).toContain('1 realm you can’t see'.replace('’', '\''));
        expect(await visibility(id)).toBe('public');
    });

    it('a fork copies the origin version’s role briefs as well as its team.yml', async () => {
        const id = await team_named('with-roles', {
            team_yml: 'name: with-roles\nversion: 1.0.0\nphases:\n  - name: design\n    type: standard\n',
            other: { 'roles/design.md': 'You are the designer.' },
        });
        const fork = await service.create(auth, { name: `with-roles-fork-${Date.now()}`, scope: scope_slug, forked_from: { team_id: id } });
        // The fork's draft is the origin's files, renamed.
        const v = (await version_content(fork.version_id))!;
        expect(v.roles).toEqual([{ name: 'design', content_md: 'You are the designer.' }]);
        expect(v.manifest_yaml).toContain(fork.name);
    });

    it('a team on no realm just becomes a draft', async () => {
        const id = await team_named('nowhere');
        const res = await service.unpublish(auth, { name: 'nowhere', scope: scope_slug });
        expect(res.uninstalled_from).toEqual([]);
        expect(await visibility(id)).toBe('draft');
    });
});
