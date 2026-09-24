import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { ScopeService } from '../../src/services/control_scope_service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Scope } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

const uid = () => `test-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();
});

beforeEach(async () => {
    if (!has_postgres) return;
    await Scope.destroy({ where: {}, truncate: true, cascade: true });
});

afterAll(async () => {
    if (!has_postgres) return;
    await Scope.destroy({ where: {}, truncate: true, cascade: true });
    await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('ScopeService.list', () => {
    it('returns empty array when no scopes exist', async () => {
        const result = await ScopeService.list();
        expect(result).toEqual([]);
    });

    it('returns scopes with default first, then alpha', async () => {
        const slug_a = `a-${uid()}`;
        const slug_b = `b-${uid()}`;
        await ScopeService.add(slug_b);
        await ScopeService.add(slug_a);

        const result = await ScopeService.list();
        expect(result[0].slug).toBe(slug_b);
        expect(result[0].is_default).toBeTruthy();
    });
});

describe.skipIf(!has_postgres)('ScopeService.add', () => {
    it('creates a new scope', async () => {
        const slug = uid();
        const scope = await ScopeService.add(slug, 'My Scope');

        expect(scope.slug).toBe(slug);
        expect(scope.name).toBe('My Scope');
        expect(scope.id).toBeTruthy();
    });

    it('first scope becomes default', async () => {
        const slug = uid();
        const scope = await ScopeService.add(slug);
        expect(scope.is_default).toBeTruthy();
    });

    it('returns existing scope if slug already exists', async () => {
        const slug = uid();
        const first = await ScopeService.add(slug, 'first');
        const second = await ScopeService.add(slug, 'second');

        expect(first.id).toBe(second.id);
        expect(second.name).toBe('first');
    });

    it('second scope is not default', async () => {
        await ScopeService.add(uid());
        const second = await ScopeService.add(uid());
        expect(second.is_default).toBeFalsy();
    });

    it('creates scope with org_id and scope_type', async () => {
        const slug = uid();
        const org = uid();
        const scope = await ScopeService.add(slug, 'Org Scope', org, 'org');
        expect(scope.org_id).toBe(org);
        expect(scope.scope_type).toBe('org');
    });
});

describe.skipIf(!has_postgres)('ScopeService.get_default', () => {
    it('returns null when no scopes exist', async () => {
        const result = await ScopeService.get_default();
        expect(result).toBeNull();
    });

    it('returns the default scope', async () => {
        const slug = uid();
        await ScopeService.add(slug);

        const def = await ScopeService.get_default();
        expect(def).not.toBeNull();
        expect(def!.slug).toBe(slug);
    });
});

describe.skipIf(!has_postgres)('ScopeService.set_default', () => {
    it('changes the default scope', async () => {
        const slug_1 = uid();
        const slug_2 = uid();
        await ScopeService.add(slug_1);
        await ScopeService.add(slug_2);

        const changed = await ScopeService.set_default(slug_2);
        expect(changed).toBe(true);

        const def = await ScopeService.get_default();
        expect(def!.slug).toBe(slug_2);
    });

    it('returns false for nonexistent slug', async () => {
        const changed = await ScopeService.set_default('nonexistent');
        expect(changed).toBe(false);
    });
});

describe.skipIf(!has_postgres)('ScopeService.remove', () => {
    it('removes existing scope', async () => {
        const slug = uid();
        await ScopeService.add(slug);

        const removed = await ScopeService.remove(slug);
        expect(removed).toBe(true);

        const found = await ScopeService.find_by_slug(slug);
        expect(found).toBeNull();
    });

    it('returns false for nonexistent scope', async () => {
        const removed = await ScopeService.remove('ghost');
        expect(removed).toBe(false);
    });
});

describe.skipIf(!has_postgres)('ScopeService.resolve', () => {
    it('resolves by slug', async () => {
        const slug = uid();
        await ScopeService.add(slug, 'Resolve Me');

        const scope = await ScopeService.resolve(slug);
        expect(scope.slug).toBe(slug);
    });

    it('resolves by @slug', async () => {
        const slug = uid();
        await ScopeService.add(slug);

        const scope = await ScopeService.resolve(`@${slug}`);
        expect(scope.slug).toBe(slug);
    });

    it('resolves by id', async () => {
        const slug = uid();
        const created = await ScopeService.add(slug);

        const scope = await ScopeService.resolve(created.id);
        expect(scope.id).toBe(created.id);
    });

    it('throws 404 for unknown ref', async () => {
        await expect(ScopeService.resolve('missing-scope')).rejects.toThrow(/not found/);
    });
});

describe.skipIf(!has_postgres)('ScopeService.list_by_org_ids', () => {
    it('returns empty for empty org_ids', async () => {
        expect(await ScopeService.list_by_org_ids([])).toEqual([]);
    });

    it('returns scopes matching org_ids', async () => {
        const org = uid();
        const slug = uid();
        await ScopeService.add(slug, 'Org Scope', org, 'org');

        const result = await ScopeService.list_by_org_ids([org]);
        expect(result.some((s) => s.slug === slug)).toBe(true);
    });
});

describe.skipIf(!has_postgres)('ScopeService.find_by_id / find_by_slug', () => {
    it('find_by_id returns scope', async () => {
        const slug = uid();
        const scope = await ScopeService.add(slug);

        const found = await ScopeService.find_by_id(scope.id);
        expect(found).not.toBeNull();
        expect(found!.slug).toBe(slug);
    });

    it('find_by_id returns null for unknown id', async () => {
        const found = await ScopeService.find_by_id('nonexistent');
        expect(found).toBeNull();
    });

    it('find_by_slug returns scope', async () => {
        const slug = uid();
        await ScopeService.add(slug);

        const found = await ScopeService.find_by_slug(slug);
        expect(found).not.toBeNull();
        expect(found!.slug).toBe(slug);
    });

    it('find_by_slug returns null for unknown slug', async () => {
        const found = await ScopeService.find_by_slug('nonexistent');
        expect(found).toBeNull();
    });
});

