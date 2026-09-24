import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { TeamService } from '../../src/services/teams_install_service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Daemon, Team, Scope, WorkspaceTeam } from '../../src/models/index.js';
import { randomUUID } from 'node:crypto';

const has_postgres = await postgres_reachable();

const uid = () => `test-team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let scope_id: string;
const daemon_id = randomUUID();

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();

    scope_id = randomUUID();
    await Scope.create({
        id: scope_id,
        slug: `test-scope-${Date.now()}`,
        name: 'Test Scope',
        is_default: 0,
        created_at: Date.now(),
    });
    await Daemon.create({
        id: daemon_id,
        api_key_hash: 'team-service-test',
        user_id: hub_legacy_uuid(1),
        user_email: 'platform@test.local',
        hostname: 'team-service-test',
        ip: null,
        port: null,
        public_url: null,
        status: 'online',
        last_heartbeat: Date.now(),
        capacity: 5,
        created_at: Date.now(),
        last_registered_at: Date.now(),
    });
});

beforeEach(async () => {
    if (!has_postgres) return;
    await WorkspaceTeam.destroy({ where: {} });
    await Team.destroy({ where: { scope_id } });
});

afterAll(async () => {
    if (!has_postgres) return;
    await WorkspaceTeam.destroy({ where: {} });
    await Team.destroy({ where: { scope_id } });
    await Scope.destroy({ where: { id: scope_id } });
    await Daemon.destroy({ where: { id: daemon_id } });
    await close_test_control_plane_store();
});

const manifest = JSON.stringify({ phases: [{ name: 'plan' }] });

describe.skipIf(!has_postgres)('TeamService.list', () => {
    it('returns empty array when no teams exist for scope', async () => {
        const result = await TeamService.list(scope_id);
        expect(result).toEqual([]);
    });

    it('returns teams ordered by slug ASC', async () => {
        const slug_b = `b-${uid()}`;
        const slug_a = `a-${uid()}`;
        await TeamService.create(scope_id, slug_b, '1.0', null, manifest);
        await TeamService.create(scope_id, slug_a, '1.0', null, manifest);

        const result = await TeamService.list(scope_id);
        const slugs = result.map((t) => t.slug);
        expect(slugs).toEqual([slug_a, slug_b]);
    });

    it('lists all teams when scope_id is omitted', async () => {
        const slug = uid();
        await TeamService.create(scope_id, slug, null, null, manifest);

        const result = await TeamService.list();
        expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('ignores empty scope_ids array filter', async () => {
        const slug = uid();
        await TeamService.create(scope_id, slug, null, null, manifest);

        const result = await TeamService.list([]);
        expect(result.some((t) => t.slug === slug)).toBe(true);
    });
});

describe.skipIf(!has_postgres)('TeamService.get', () => {
    it('returns team by scope_id and slug', async () => {
        const slug = uid();
        await TeamService.create(scope_id, slug, '1.0', 'a test team', manifest);

        const team = await TeamService.get(scope_id, slug);
        expect(team.slug).toBe(slug);
        expect(team.version).toBe('1.0');
    });

    it('throws 404 for missing team', async () => {
        await expect(TeamService.get(scope_id, 'nonexistent'))
            .rejects.toThrow(/not found/);
    });
});

describe.skipIf(!has_postgres)('TeamService.get_by_id', () => {
    it('returns team by primary key', async () => {
        const slug = uid();
        const created = await TeamService.create(scope_id, slug, null, null, manifest);
        const id = created.id;

        const team = await TeamService.get_by_id(id);
        expect(team.slug).toBe(slug);
    });

    it('throws 404 for unknown id', async () => {
        await expect(TeamService.get_by_id(randomUUID()))
            .rejects.toThrow(/not found/);
    });
});

describe.skipIf(!has_postgres)('TeamService.create', () => {
    it('creates team with full fields', async () => {
        const slug = uid();
        const team = await TeamService.create(scope_id, slug, '2.0', 'desc', manifest, {
            dockerfile: 'FROM node:20',
            dependencies: 'express',
        });

        expect(team.slug).toBe(slug);
        expect(team.scope_id).toBe(scope_id);
        expect(team.version).toBe('2.0');
        expect(team.dockerfile).toBe('FROM node:20');
    });

    it('sets nullable fields to null when omitted', async () => {
        const slug = uid();
        const team = await TeamService.create(scope_id, slug, null, null, manifest);

        expect(team.version).toBeNull();
        expect(team.description).toBeNull();
        expect(team.dockerfile).toBeNull();
    });
});

describe.skipIf(!has_postgres)('TeamService.update', () => {
    it('updates manifest and version', async () => {
        const slug = uid();
        await TeamService.create(scope_id, slug, '1.0', null, manifest);

        const new_manifest = JSON.stringify({ phases: [{ name: 'build' }] });
        const updated = await TeamService.update(scope_id, slug, {
            manifest: new_manifest,
            version: '2.0',
        });

        expect(updated.manifest).toBe(new_manifest);
        expect(updated.version).toBe('2.0');
    });

    it('throws 404 for missing team', async () => {
        await expect(TeamService.update(scope_id, 'ghost', { version: '9.0' }))
            .rejects.toThrow(/not found/);
    });
});

describe.skipIf(!has_postgres)('TeamService.remove', () => {
    it('removes existing team and returns true', async () => {
        const slug = uid();
        await TeamService.create(scope_id, slug, null, null, manifest);

        const removed = await TeamService.remove(scope_id, slug);
        expect(removed).toBe(true);

        const remaining = await TeamService.list(scope_id);
        expect(remaining.find((t) => t.slug === slug)).toBeUndefined();
    });

    it('returns false for nonexistent team', async () => {
        const removed = await TeamService.remove(scope_id, 'ghost');
        expect(removed).toBe(false);
    });
});

describe.skipIf(!has_postgres)('TeamService.find', () => {
    it('returns team when present', async () => {
        const slug = uid();
        await TeamService.create(scope_id, slug, null, null, manifest);

        const found = await TeamService.find(scope_id, slug);
        expect(found).not.toBeNull();
        expect(found!.slug).toBe(slug);
    });

    it('returns null when team missing', async () => {
        expect(await TeamService.find(scope_id, 'missing-team')).toBeNull();
    });

    it('filters by daemon_id when provided', async () => {
        const slug = uid();
        await TeamService.create(scope_id, slug, null, null, manifest, { daemon_id });

        const found = await TeamService.find(scope_id, slug, { daemon_id });
        expect(found).not.toBeNull();
        expect(found!.daemon_id).toBe(daemon_id);
    });
});

describe.skipIf(!has_postgres)('TeamService.list with daemon filter', () => {
    it('filters teams by daemon_id', async () => {
        const slug = uid();
        await TeamService.create(scope_id, slug, null, null, manifest, { daemon_id });

        const result = await TeamService.list(scope_id, { daemon_id });
        expect(result.some((t) => t.slug === slug)).toBe(true);
    });
});

describe.skipIf(!has_postgres)('TeamService.count_by_scope', () => {
    it('returns 0 when scope has no teams', async () => {
        const count = await TeamService.count_by_scope(scope_id);
        expect(count).toBe(0);
    });

    it('returns correct count after creating teams', async () => {
        await TeamService.create(scope_id, uid(), null, null, manifest);
        await TeamService.create(scope_id, uid(), null, null, manifest);

        const count = await TeamService.count_by_scope(scope_id);
        expect(count).toBe(2);
    });
});

