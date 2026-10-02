/**
 * Forking a team over HTTP on live Postgres: `teams/create` with `forked_from`
 * copies the chosen version's manifest into a new draft team the caller owns,
 * records where it came from, and leaves the original untouched.
 *
 *   - The fork starts at 0.1.0 as a draft, its manifest named after the fork.
 *   - Its detail says which team and version it came from, and the origin's
 *     latest version; the origin counts its forks.
 *   - Teams the caller cannot see cannot be forked (404); the target scope must
 *     be the caller's (403); names stay unique in a scope (409).
 *   - Editing the fork adds versions to the fork only; edits can be kept as an
 *     unversioned working copy (seen only by editors) until a version is saved.
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

const has_postgres = await postgres_reachable();

const MANIFEST = (name: string) => [
    `name: ${name}`,
    '# shared pipeline',
    'description: Ticket to PR',
    'phases:',
    '  - name: build',
    '    agent: claude-code',
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
    const team_ids: string[] = [];

    const post = (path: string, token: string, body: Record<string, unknown>) =>
        request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);

    beforeAll(async () => {
        app = (await open_live_hub_app()).app;
        s = await seed_authz(app);
        author = await s.signup('fkauthor');
        forker = await s.signup('fkuser');
        const created = await post('/v1/teams/create', author.token, { name: 'pipeline', scope: author.username, description: 'Ticket to PR', manifest: MANIFEST('pipeline') });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        source_id = created.body.data.id;
        team_ids.push(source_id);
    }, 300_000);

    afterAll(async () => {
        await TeamVersion.destroy({ where: { team_id: { [Op.in]: team_ids } } });
        await Team.destroy({ where: { id: { [Op.in]: team_ids } } });
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    it("cannot fork a draft the caller can't see", async () => {
        const res = await post('/v1/teams/create', forker.token, { name: 'mine', scope: forker.username, forked_from: { team_id: source_id } });
        expect(res.status, JSON.stringify(res.body)).toBe(404);
    });

    it('forks the latest version into a new draft the caller owns, and records where it came from', async () => {
        await Team.update({ visibility: 'public', listed: 1 }, { where: { id: source_id } });

        const res = await post('/v1/teams/create', forker.token, { name: 'my-pipeline', scope: forker.username, forked_from: { team_id: source_id } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.data).toMatchObject({ name: 'my-pipeline', scope: forker.username, status: 'draft', version: '0.1.0' });
        const fork_id = res.body.data.id as string;
        team_ids.push(fork_id);

        const fork = await post('/v1/teams/get_by_id', forker.token, { team_id: fork_id });
        expect(fork.status).toBe(200);
        expect(fork.body.data.forked_from).toEqual({ team_id: source_id, scope: author.username, name: 'pipeline', version: '0.1.0', latest_version: '0.1.0' });
        expect(fork.body.data.description).toBe('Ticket to PR');
        expect(fork.body.data.raw_manifest).toBe(MANIFEST('my-pipeline'));
        expect(fork.body.data.can_edit).toBe(true);

        const origin = await post('/v1/teams/get_by_id', author.token, { team_id: source_id });
        expect(origin.body.data.fork_count).toBe(1);
        expect(origin.body.data.forked_from).toBeNull();
    });

    it('the catalog with_workflow returns phases, version and fork counts and the verified flag', async () => {
        const res = await post('/v1/teams/get', forker.token, { query: 'pipeline', with_workflow: true, limit: 100 });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const item = (res.body.data.items as Array<Record<string, unknown>>).find((t) => t.id === source_id);
        expect(item).toMatchObject({
            phases: [{ name: 'build', type: null, agent: 'claude-code' }],
            version_count: 1, fork_count: 1, verified: false, updated_at: expect.any(Number),
        });
        const plain = await post('/v1/teams/get', forker.token, { query: 'pipeline', limit: 100 });
        expect((plain.body.data.items as Array<Record<string, unknown>>).find((t) => t.id === source_id)).not.toHaveProperty('phases');
    });

    it("editing the fork adds versions to the fork only; the origin's versions stay as they were", async () => {
        const fork = await Team.findOne({ where: { name: 'my-pipeline', scope: forker.username }, attributes: ['id'], raw: true });
        const edited = await post('/v1/teams/update', forker.token, { team_id: fork!.id, manifest: MANIFEST('my-pipeline').replace('Ticket to PR', 'Ticket to PR, my way') });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        expect(edited.body.data.version).toBe('0.1.1');
        expect(await TeamVersion.count({ where: { team_id: source_id } })).toBe(1);
        const source_manifest = await TeamVersion.findOne({ where: { team_id: source_id }, attributes: ['manifest_yaml'], raw: true });
        expect(source_manifest!.manifest_yaml).toBe(MANIFEST('pipeline'));
    });

    it('keeps edits as a working copy until a version is saved, then mints it from the copy', async () => {
        const fork = await Team.findOne({ where: { name: 'my-pipeline', scope: forker.username }, attributes: ['id'], raw: true });
        const versions_before = await TeamVersion.count({ where: { team_id: fork!.id } });
        const edited = MANIFEST('my-pipeline').replace('Ticket to PR', 'Ticket to PR, reviewed');

        const draft = await post('/v1/teams/update', forker.token, { team_id: fork!.id, manifest: edited, save_as: 'draft' });
        expect(draft.status, JSON.stringify(draft.body)).toBe(200);
        expect(draft.body.data.version).toBeNull();
        expect(draft.body.data.draft_saved_at).toEqual(expect.any(String));
        expect(await TeamVersion.count({ where: { team_id: fork!.id } })).toBe(versions_before);

        const mine = await post('/v1/teams/get_by_id', forker.token, { team_id: fork!.id });
        expect(mine.body.data.draft).toMatchObject({ manifest: edited });
        const theirs = await post('/v1/teams/get_by_id', author.token, { team_id: fork!.id });
        expect(theirs.status).toBe(404);

        const version = await post('/v1/teams/update', forker.token, { team_id: fork!.id, save_as: 'version', bump: 'minor', changelog: 'Adds review' });
        expect(version.status, JSON.stringify(version.body)).toBe(200);
        expect(version.body.data).toMatchObject({ version: '0.2.0', draft_saved_at: null });
        const row = await TeamVersion.findOne({ where: { team_id: fork!.id, version: '0.2.0' }, attributes: ['manifest_yaml', 'changelog'], raw: true });
        expect(row).toMatchObject({ manifest_yaml: edited, changelog: 'Adds review' });
        const after = await post('/v1/teams/get_by_id', forker.token, { team_id: fork!.id });
        expect(after.body.data.draft).toBeNull();

        const empty = await post('/v1/teams/update', forker.token, { team_id: fork!.id, save_as: 'draft' });
        expect(empty.status).toBe(422);
    });

    it("refuses a scope that isn't the caller's, and a name already taken", async () => {
        const other = await post('/v1/teams/create', forker.token, { name: 'x', scope: author.username, forked_from: { team_id: source_id } });
        expect(other.status).toBe(403);
        const taken = await post('/v1/teams/create', forker.token, { name: 'my-pipeline', scope: forker.username, forked_from: { team_id: source_id } });
        expect(taken.status).toBe(409);
    });
});
