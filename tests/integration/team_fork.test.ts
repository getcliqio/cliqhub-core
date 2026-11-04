/**
 * Forking a team over HTTP on live Postgres: `teams/create` with `forked_from`
 * copies the chosen version's files into the draft of a new team the caller owns,
 * records where it came from, and leaves the original untouched (PLAN-team-bundle S1.3c).
 *
 *   - The fork is a draft with no version yet; its team.yml is the origin's, named after the fork.
 *   - Its detail says which team and version it came from, and the origin's
 *     latest version; the origin counts its forks.
 *   - Teams the caller cannot see cannot be forked (404), nor a team with no version (409);
 *     the target scope must be the caller's (403); names stay unique in a scope (409).
 *   - Editing the fork (files uploaded into its draft, then published) adds versions to the fork
 *     only; a draft is seen only by editors until it is published, and can be discarded.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { Team, TeamVersion } from '../../src/models/index.js';
import { with_manifest_name } from '../../src/services/teams_service.js';
import { upload_files } from '../helpers/publish_team.js';

const has_postgres = await postgres_reachable();

const MANIFEST = (name: string) => [
    `name: ${name}`,
    '# shared pipeline',
    'description: Ticket to PR',
    'phases:',
    '  - name: build',
    '    agent: claude-code',
    '    role: Build it',
].join('\n');

describe('with_manifest_name', () => {
    it('replaces the top-level name and keeps the rest of the text', () => {
        expect(with_manifest_name('name: a\n# keep\nphases: []', 'b')).toBe('name: b\n# keep\nphases: []');
        expect(with_manifest_name('phases: []', 'b')).toBe('name: b\nphases: []');
    });
});

describe.skipIf(!has_postgres)('forking a team', () => {
    let app: Express;
    let s: Seed;
    let author: Awaited<ReturnType<Seed['signup']>>;
    let forker: Awaited<ReturnType<Seed['signup']>>;
    let source_id: string;
    let source_draft: string;
    let fork_id: string;
    const team_ids: string[] = [];

    const post = (path: string, token: string, body: Record<string, unknown>) =>
        request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
    /** A version's (or draft's) team.yml, as stored. */
    const team_yml = async (token: string, team_id: string, version_id: string) => {
        const res = await post('/v1/teams/files/get', token, { team_id, version_id, content: true });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return (res.body.data.files as Array<{ path: string; content: string }>).find((f) => f.path === 'team.yml')?.content;
    };
    /** Upload a team.yml into the fork: into `version_id`'s draft, else a new one. */
    const save = async (manifest: string, version_id?: string) => {
        const res = await upload_files(app, forker.token, { team_id: fork_id, ...(version_id ? { version_id } : {}) }, { 'team.yml': manifest });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return String(res.body.data.version_id);
    };

    beforeAll(async () => {
        app = (await open_live_hub_app()).app;
        s = await seed_authz(app);
        author = await s.signup('fkauthor');
        forker = await s.signup('fkuser');
        const created = await post('/v1/teams/create', author.token, { name: 'pipeline', scope: author.username, description: 'Ticket to PR' });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        source_id = created.body.data.id;
        source_draft = created.body.data.version_id;
        team_ids.push(source_id);
    }, 300_000);

    afterAll(async () => {
        await TeamVersion.destroy({ where: { team_id: { [Op.in]: team_ids } } });
        await Team.destroy({ where: { id: { [Op.in]: team_ids } } });
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    it("cannot fork a draft the caller can't see, nor a team with no version yet", async () => {
        const res = await post('/v1/teams/create', forker.token, { name: 'mine', scope: forker.username, forked_from: { team_id: source_id } });
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        const own = await post('/v1/teams/create', author.token, { name: 'mine', scope: author.username, forked_from: { team_id: source_id } });
        expect(own.status, JSON.stringify(own.body)).toBe(409);
    });

    it('forks the latest version into a new draft the caller owns, and records where it came from', async () => {
        const up = await upload_files(app, author.token, { team_id: source_id, version_id: source_draft }, { 'team.yml': MANIFEST('pipeline') });
        expect(up.status, JSON.stringify(up.body)).toBe(201);
        const pub = await post('/v1/teams/publish', author.token, { team_id: source_id, version: '0.1.0', version_id: source_draft, visibility: 'public' });
        expect(pub.status, JSON.stringify(pub.body)).toBe(200);

        const res = await post('/v1/teams/create', forker.token, { name: 'my-pipeline', scope: forker.username, forked_from: { team_id: source_id } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.data).toMatchObject({ name: 'my-pipeline', scope: forker.username, status: 'draft', version: null, version_id: expect.any(String) });
        fork_id = res.body.data.id as string;
        team_ids.push(fork_id);

        const fork = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        expect(fork.status).toBe(200);
        expect(fork.body.data.forked_from).toEqual({ team_id: source_id, scope: author.username, name: 'pipeline', version: '0.1.0', latest_version: '0.1.0' });
        expect(fork.body.data.description).toBe('Ticket to PR');
        expect(fork.body.data.can_edit).toBe(true);
        expect(fork.body.data.draft).toMatchObject({ version_id: res.body.data.version_id });

        const origin = await post('/v1/teams/get_by_id', author.token, { team_id: source_id });
        expect(origin.body.data.fork_count).toBe(1);
        expect(origin.body.data.forked_from).toBeNull();
        // The fork's draft holds the origin's published team.yml, named after the fork.
        const origin_yml = await team_yml(author.token, source_id, origin.body.data.version_id);
        expect(origin_yml).toContain('# shared pipeline');
        expect(await team_yml(forker.token, fork_id, res.body.data.version_id))
            .toBe(with_manifest_name(origin_yml!, JSON.stringify(`@${forker.username}/my-pipeline`)));
    });

    it('the catalog with_workflow returns phases, version and fork counts', async () => {
        const res = await post('/v1/teams/get', forker.token, { query: 'pipeline', with_workflow: true, limit: 100 });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const item = (res.body.data.items as Array<Record<string, unknown>>).find((t) => t.id === source_id);
        expect(item).toMatchObject({
            phases: [{ name: 'build', type: null, agent: 'claude-code' }],
            version_count: 1, fork_count: 1, updated_at: expect.any(Number),
        });
        const plain = await post('/v1/teams/get', forker.token, { query: 'pipeline', limit: 100 });
        expect((plain.body.data.items as Array<Record<string, unknown>>).find((t) => t.id === source_id)).not.toHaveProperty('phases');
    });

    it("editing the fork adds versions to the fork only; the origin's versions stay as they were", async () => {
        const origin = await post('/v1/teams/get_by_id', author.token, { team_id: source_id });
        const origin_before = await team_yml(author.token, source_id, origin.body.data.version_id);
        const fork = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        const draft = await save(MANIFEST('my-pipeline').replace('Ticket to PR', 'Ticket to PR, my way'), fork.body.data.draft.version_id);
        const published = await post('/v1/teams/publish', forker.token, { team_id: fork_id, version: '0.1.1', version_id: draft });
        expect(published.status, JSON.stringify(published.body)).toBe(200);
        expect(published.body.data.version).toBe('0.1.1');
        expect(await TeamVersion.count({ where: { team_id: source_id } })).toBe(1);
        expect(await team_yml(author.token, source_id, origin.body.data.version_id)).toBe(origin_before);
    });

    it('keeps edits in a draft (seen only by editors) until it is published as a version', async () => {
        const published_before = await TeamVersion.count({ where: { team_id: fork_id, status: 'published' } });
        const edited = MANIFEST('my-pipeline').replace('Ticket to PR', 'Ticket to PR, reviewed');
        const latest = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        const draft = await save(edited);
        await upload_files(app, forker.token, { team_id: fork_id, version_id: draft }, { 'README.md': '# mine\n' });
        expect(await TeamVersion.count({ where: { team_id: fork_id, status: 'published' } })).toBe(published_before);

        const mine = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        expect(mine.body.data.draft).toMatchObject({ version_id: draft });
        expect(mine.body.data.version_id).toBe(latest.body.data.version_id);
        expect(await team_yml(forker.token, fork_id, draft)).toContain('Ticket to PR, reviewed');
        const theirs = await post('/v1/teams/get_by_id', author.token, { team_id: fork_id });
        expect(theirs.status).toBe(404);
        const theirs_files = await post('/v1/teams/files/get', author.token, { team_id: fork_id, version_id: draft, content: true });
        expect(theirs_files.status).toBe(404);

        const version = await post('/v1/teams/publish', forker.token, { team_id: fork_id, version: '0.2.0', version_id: draft, changelog: 'Adds review' });
        expect(version.status, JSON.stringify(version.body)).toBe(200);
        expect(version.body.data).toMatchObject({ version: '0.2.0', version_id: draft });
        const row = await TeamVersion.findOne({ where: { team_id: fork_id, version: '0.2.0' }, attributes: ['status', 'changelog'], raw: true });
        expect(row).toMatchObject({ status: 'published', changelog: 'Adds review' });
        const after = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        expect(after.body.data.draft).toBeNull();
        expect(after.body.data.raw_manifest).toContain('Ticket to PR, reviewed');

        // A new number needs its files: publishing without a draft only re-lists the latest version.
        const no_files = await post('/v1/teams/publish', forker.token, { team_id: fork_id, version: '0.3.0' });
        expect(no_files.status, JSON.stringify(no_files.body)).toBe(422);
    });

    it("save_as 'discard' deletes the draft and publishes nothing", async () => {
        const before = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        const versions_before = await TeamVersion.count({ where: { team_id: fork_id } });
        const draft = await save(MANIFEST('my-pipeline').replace('Ticket to PR', 'wip'));
        expect(await TeamVersion.count({ where: { team_id: fork_id } })).toBe(versions_before + 1);

        const theirs = await post('/v1/teams/update', author.token, { team_id: fork_id, save_as: 'discard', version_id: draft });
        expect(theirs.status).not.toBe(200);
        expect((await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id })).body.data.draft).toMatchObject({ version_id: draft });

        const discard = await post('/v1/teams/update', forker.token, { team_id: fork_id, save_as: 'discard', version_id: draft });
        expect(discard.status, JSON.stringify(discard.body)).toBe(200);
        const after = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        expect(after.body.data.draft).toBeNull();
        expect(after.body.data.description).toBe(before.body.data.description);
        expect(after.body.data.version_id).toBe(before.body.data.version_id);
        expect(await TeamVersion.count({ where: { team_id: fork_id } })).toBe(versions_before);

        const again = await post('/v1/teams/update', forker.token, { team_id: fork_id, save_as: 'discard', version_id: draft });
        expect(again.status).toBe(404);
    });

    it('publishing a draft closes it; a status-only publish keeps the tags it is given', async () => {
        const draft = await save(MANIFEST('my-pipeline'));
        const published = await post('/v1/teams/publish', forker.token, { team_id: fork_id, version: '0.2.1', version_id: draft, changelog: 'First release' });
        expect(published.status, JSON.stringify(published.body)).toBe(200);
        const after = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        expect(after.body.data.draft).toBeNull();

        const status_only = await post('/v1/teams/publish', forker.token, { team_id: fork_id, tags: ['Engineering', 'git'] });
        expect(status_only.status, JSON.stringify(status_only.body)).toBe(200);
        const tagged = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        expect([...tagged.body.data.tags].sort()).toEqual(['engineering', 'git']);
    });

    it("refuses a scope that isn't the caller's, and a name already taken", async () => {
        const other = await post('/v1/teams/create', forker.token, { name: 'x', scope: author.username, forked_from: { team_id: source_id } });
        expect(other.status).toBe(403);
        const taken = await post('/v1/teams/create', forker.token, { name: 'my-pipeline', scope: forker.username, forked_from: { team_id: source_id } });
        expect(taken.status).toBe(409);
    });
});
