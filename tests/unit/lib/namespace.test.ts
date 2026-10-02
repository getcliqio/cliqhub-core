import { describe, it, expect, vi } from 'vitest';
import { assert_email_free, assert_namespace_free, deciding_holder, namespace_conflict, namespace_holders, namespace_message, type NamespaceRepos } from '../../../src/lib/namespace.js';

function repos(over: { org?: object | null; scope?: object | null; user?: object | null; org_by_id?: object | null; owner?: object | null } = {}): NamespaceRepos {
    return {
        org_repo: { find_by_slug: vi.fn().mockResolvedValue(over.org ?? null), find_by_id: vi.fn().mockResolvedValue(over.org_by_id ?? null) },
        scope_repo: { find_by_slug: vi.fn().mockResolvedValue(over.scope ?? null) },
        user_repo: { find_by_username: vi.fn().mockResolvedValue(over.user ?? null), find_profile_by_id: vi.fn().mockResolvedValue(over.owner ?? null) },
    } as unknown as NamespaceRepos;
}

describe('namespace messages (approved wording)', () => {
    it.each([
        [{ kind: 'org', slug: 'measureone', personal: false }, 'measureone is already an org'],
        [{ kind: 'org', slug: 'measureone', personal: true, owner_username: 'measureone' }, 'measureone is already an org — the personal org of user measureone'],
        [{ kind: 'scope', slug: 'measureone', scope_type: 'user', owner_username: 'sapan' }, 'measureone is already a scope (user, owned by user sapan)'],
        [{ kind: 'scope', slug: 'measureone', scope_type: 'org', org_slug: 'acme' }, 'measureone is already a scope (org, owned by org acme)'],
        [{ kind: 'scope', slug: 'measureone', scope_type: 'org', org_slug: null }, 'measureone is already a scope (org, not attached to any org)'],
        [{ kind: 'scope', slug: 'measureone', scope_type: 'user', owner_username: null }, 'measureone is already a scope (user, not attached to any org or user)'],
        [{ kind: 'user', slug: 'measureone' }, 'measureone is already a username'],
    ] as const)('%o → %s', (holder, text) => {
        expect(namespace_message(holder)).toBe(text);
        expect(namespace_conflict(holder)).toMatchObject({ status: 409, code: 'conflict', message: text, details: { ...holder, field: 'slug', holder: { slug: 'measureone' } } });
    });
});

describe('namespace_holders / assert_namespace_free', () => {
    it('resolves the scope owner and org, and reports kinds in the order asked', async () => {
        const r = repos({ scope: { id: 's', scope_type: 'org', org_id: 'o1', owner_id: 'u1' }, org_by_id: { slug: 'acme' }, owner: { username: 'sapan' }, user: { username: 'measureone' } });
        expect(await namespace_holders(r, '@MeasureOne', ['user', 'scope'])).toEqual([
            { kind: 'user', slug: 'measureone' },
            { kind: 'scope', slug: 'measureone', id: 's', scope_type: 'org', org_slug: 'acme', owner_username: 'sapan', org_id: 'o1', owner_id: 'u1' },
        ]);
        await expect(assert_namespace_free(r, 'measureone', ['scope'])).rejects.toMatchObject({ message: 'measureone is already a scope (org, owned by org acme)' });
        await expect(assert_namespace_free(repos(), 'free-name')).resolves.toBeUndefined();
    });

    it('only looks the user up when it matters (personal org check or a user check)', async () => {
        const r = repos();
        await namespace_holders(r, 'x', ['scope']);
        expect(r.user_repo.find_by_username).not.toHaveBeenCalled();
    });
});

describe('conflict details (contract: kind, field, holder)', () => {
    it('names the request field and the holder row', async () => {
        const r = repos({ org: { id: 'org-1', slug: 'acme' } });
        await expect(assert_namespace_free(r, 'acme', ['org'], 'username')).rejects.toMatchObject({
            status: 409, code: 'conflict', details: { kind: 'org', field: 'username', holder: { id: 'org-1', slug: 'acme' } },
        });
    });
});

describe('deleted names (409 deleted)', () => {
    const when = new Date('2026-03-04T05:06:07Z');

    it('a soft-deleted org holds its slug: deleted with was_active from activated_at', async () => {
        const r = repos({ org: { id: 'org-1', slug: 'acme', deleted_at: when, status: 'deleted', activated_at: when } });
        await expect(assert_namespace_free(r, 'acme')).rejects.toMatchObject({
            status: 409, code: 'deleted', message: 'acme belongs to a deleted org',
            details: { kind: 'org', id: 'org-1', deleted_at: when.toISOString(), was_active: true },
        });
    });

    it('an org that never got its owner reports was_active false', async () => {
        const r = repos({ org: { id: 'org-2', slug: 'waiting', deleted_at: when, status: 'deleted', activated_at: null } });
        await expect(assert_namespace_free(r, 'waiting', ['org'])).rejects.toMatchObject({ code: 'deleted', details: { was_active: false } });
    });

    it('a soft-deleted user holds the username; an invited user that was deleted was never active', async () => {
        const r = repos({ user: { id: 'u-1', username: 'priya', deleted_at: when, status: 'invited' } });
        await expect(assert_namespace_free(r, 'priya', ['user'], 'username')).rejects.toMatchObject({
            code: 'deleted', details: { kind: 'user', id: 'u-1', was_active: false },
        });
    });

    it('a deleted personal org reports its deleted user', async () => {
        const r = repos({
            org: { id: 'org-p', slug: 'sam', deleted_at: when, activated_at: when },
            user: { id: 'u-sam', username: 'sam', deleted_at: when, status: 'active' },
        });
        await expect(assert_namespace_free(r, 'sam', ['org', 'scope', 'user'])).rejects.toMatchObject({
            code: 'deleted', details: { kind: 'user', id: 'u-sam', was_active: true },
        });
    });

    it('a live holder wins over a deleted one (conflict, not deleted)', () => {
        const holders = [
            { kind: 'org' as const, slug: 'x', id: 'o', deleted: { kind: 'org' as const, id: 'o', deleted_at: when.toISOString(), was_active: true } },
            { kind: 'user' as const, slug: 'x', id: 'u' },
        ];
        expect(deciding_holder(holders)).toMatchObject({ kind: 'user', id: 'u' });
        expect(deciding_holder([])).toBeNull();
    });

    it('the scope of a deleted org does not make the name live', async () => {
        const r = repos({
            org: { id: 'org-1', slug: 'acme', deleted_at: when, activated_at: when },
            scope: { id: 's-1', scope_type: 'org', org_id: 'org-1', owner_id: null },
            org_by_id: { slug: 'acme' },
        });
        await expect(assert_namespace_free(r, 'acme')).rejects.toMatchObject({ code: 'deleted', details: { kind: 'org', id: 'org-1' } });
    });
});

describe('assert_email_free', () => {
    it('passes when nobody has the address, normalizing it first', async () => {
        const user_repo = { find_by_email: vi.fn().mockResolvedValue(null) };
        await expect(assert_email_free(user_repo, ' Priya@Example.COM ', 'self-id')).resolves.toBeUndefined();
        expect(user_repo.find_by_email).toHaveBeenCalledWith('priya@example.com', 'self-id');
    });

    it('live holder → 409 conflict with field email; deleted holder → 409 deleted', async () => {
        const live = { find_by_email: vi.fn().mockResolvedValue({ id: 'u-1', username: 'priya', status: 'active', deleted_at: null }) };
        await expect(assert_email_free(live, 'priya@example.com')).rejects.toMatchObject({
            status: 409, code: 'conflict', details: { kind: 'user', field: 'email', holder: { id: 'u-1', slug: 'priya' } },
        });
        const gone = { find_by_email: vi.fn().mockResolvedValue({ id: 'u-2', username: null, status: 'invited', deleted_at: '2026-01-02T00:00:00.000Z' }) };
        await expect(assert_email_free(gone, 'old@example.com')).rejects.toMatchObject({
            status: 409, code: 'deleted', details: { kind: 'user', id: 'u-2', deleted_at: '2026-01-02T00:00:00.000Z', was_active: false },
        });
    });
});
