import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { AuthService } from '../../../src/services/auth_service.js';
import { ALICE, SITE_ADMIN, UNAUTHED } from '../../helpers/fixtures.js';
import { test_config } from '../../helpers/test_container.js';

vi.mock('../../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('$2b$10$hashed'),
    verify_password: vi.fn(),
}));

vi.mock('../../../src/services/per_user_channel.service.js', () => ({
    ensure_per_user_channel: vi.fn().mockResolvedValue(undefined),
}));

import * as password from '../../../src/auth/password.js';

const { RealmService } = await import('../../../src/services/realm.service.js');

function make_user_repo() {
    return {
        find_by_id: vi.fn(), find_by_username: vi.fn(),
        find_by_username_or_email: vi.fn(), find_by_email: vi.fn(),
        create: vi.fn().mockResolvedValue(1),
        find_by_id_with_transaction: vi.fn().mockResolvedValue(ALICE.user),
    };
}

function make_scope_repo() {
    return {
        find_owned_by_user: vi.fn().mockResolvedValue([]),
        find_by_org_ids: vi.fn().mockResolvedValue([]),
        find_member_scopes: vi.fn().mockResolvedValue([]),
        find_by_slug: vi.fn(),
        find_by_slug_with_transaction: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(1),
    };
}

function make_org_member_repo() {
    return {
        find_orgs_by_user: vi.fn().mockResolvedValue([]),
    };
}

function make_org_repo() {
    return {
        find_by_slug: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(1),
    };
}

function make_token_repo() {
    return {
        create: vi.fn().mockResolvedValue({ id: 'tok-1' }),
        find_by_prefix: vi.fn().mockResolvedValue(null),
        soft_revoke_by_id: vi.fn().mockResolvedValue(1),
        soft_revoke: vi.fn().mockResolvedValue(1),
    };
}

describe('AuthService', () => {
    let service: AuthService;
    let user_repo: ReturnType<typeof make_user_repo>;
    let scope_repo: ReturnType<typeof make_scope_repo>;
    let org_member_repo: ReturnType<typeof make_org_member_repo>;
    let org_repo: ReturnType<typeof make_org_repo>;
    let token_repo: ReturnType<typeof make_token_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        user_repo = make_user_repo();
        scope_repo = make_scope_repo();
        org_member_repo = make_org_member_repo();
        org_repo = make_org_repo();
        token_repo = make_token_repo();
        service = new AuthService(
            user_repo as any,
            scope_repo as any,
            org_member_repo as any,
            test_config(),
            org_repo as any,
            token_repo as any,
        );
    });

    describe('mint_session_pat', () => {
        it('creates cliq_tok_ with session: name and default grant', async () => {
            user_repo.find_by_id.mockResolvedValueOnce(ALICE.user);
            org_member_repo.find_orgs_by_user.mockResolvedValueOnce([
                { org_id: hub_legacy_uuid(10), slug: 'alice', role: 'admin' },
            ]);
            scope_repo.find_owned_by_user.mockResolvedValueOnce([
                { id: hub_legacy_uuid(1), slug: 'alice' },
            ]);

            const result = await service.mint_session_pat(hub_legacy_uuid(1));

            expect(result.token).toMatch(/^cliq_tok_/);
            expect(result.scopes).toContain('alice');
            expect(result.org_ids).toEqual([hub_legacy_uuid(10)]);
            expect(token_repo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'user',
                    user_id: hub_legacy_uuid(1),
                    name: expect.stringMatching(/^session:/),
                    permissions: expect.objectContaining({
                        domains: expect.any(Object),
                        access: expect.any(Object),
                    }),
                }),
            );
        });

        it('rejects missing user', async () => {
            user_repo.find_by_id.mockResolvedValueOnce(null);
            await expect(service.mint_session_pat(hub_legacy_uuid(999))).rejects.toThrow('User not found');
        });

        it('rejects suspended user', async () => {
            user_repo.find_by_id.mockResolvedValueOnce({
                ...ALICE.user!,
                suspended_at: '2025-06-01',
            });
            await expect(service.mint_session_pat(hub_legacy_uuid(1))).rejects.toThrow('suspended');
        });
    });

    describe('signup', () => {
        it('creates user, account, and session PAT', async () => {
            user_repo.find_by_username_or_email.mockResolvedValueOnce(null);
            user_repo.find_by_id.mockResolvedValue(ALICE.user);
            const result = await service.signup('alice', 'alice@test.com', 'password123');
            expect(result.user).toBeDefined();
            expect(result.token).toMatch(/^cliq_tok_/);
            expect(result.account_slug).toBe('alice');
            expect(result.account_id).toBe(hub_legacy_uuid(1));
            expect(user_repo.create).toHaveBeenCalled();
            expect(token_repo.create).toHaveBeenCalled();
        });

        it('uses username as account_slug', async () => {
            user_repo.find_by_username_or_email.mockResolvedValueOnce(null);
            user_repo.find_by_id.mockResolvedValue(ALICE.user);
            const result = await service.signup('Alice', 'alice@test.com', 'password123');
            expect(result.account_slug).toBe('alice');
        });

        it('rejects reserved username', async () => {
            await expect(service.signup('admin', 'a@test.com', 'password123'))
                .rejects.toThrow('reserved');
        });

        it('rejects invalid username slug format', async () => {
            await expect(service.signup('123bad', 'a@test.com', 'password123'))
                .rejects.toThrow('start with a letter');
        });

        it('rejects duplicate username or email', async () => {
            user_repo.find_by_username_or_email.mockResolvedValueOnce({ id: hub_legacy_uuid(99) });
            await expect(service.signup('alice', 'alice@test.com', 'password123'))
                .rejects.toThrow('already taken');
        });

        it('rejects duplicate account slug', async () => {
            user_repo.find_by_username_or_email.mockResolvedValueOnce(null);
            org_repo.find_by_slug.mockResolvedValueOnce({ id: hub_legacy_uuid(5) });
            await expect(service.signup('alice', 'alice@test.com', 'password123'))
                .rejects.toThrow('account with that name already exists');
        });

        it('rejects password shorter than 8 characters', async () => {
            await expect(service.signup('alice', 'alice@test.com', 'short'))
                .rejects.toThrow('at least 8');
        });

        it('creates account default realm on signup', async () => {
            user_repo.find_by_username_or_email.mockResolvedValueOnce(null);
            user_repo.find_by_id.mockResolvedValue(ALICE.user);
            vi.mocked(RealmService.ensure_account_default_realm).mockResolvedValueOnce({
                realm: {
                    id: 'realm-account',
                    slug: 'alice.default',
                    name: 'alice',
                    owner_user_id: hub_legacy_uuid(1),
                    created_by: hub_legacy_uuid(1),
                    created_at: 0,
                    updated_at: 0,
                },
                default_realm_id: 'realm-account',
                default_realm_slug: 'alice.default',
                enroll_token: 'cliq_dt_test',
            });
            const result = await service.signup('alice', 'alice@test.com', 'password123');
            expect(RealmService.ensure_account_default_realm).toHaveBeenCalledWith(hub_legacy_uuid(1), 'alice');
            expect(result.default_realm_slug).toBe('alice.default');
            expect(result.enroll_token).toBe('cliq_dt_test');
        });

        it('fails signup when account default realm creation fails', async () => {
            user_repo.find_by_username_or_email.mockResolvedValueOnce(null);
            user_repo.find_by_id.mockResolvedValue(ALICE.user);
            vi.mocked(RealmService.ensure_account_default_realm).mockRejectedValueOnce(new Error('realm conflict'));
            await expect(service.signup('carol', 'carol@test.com', 'password123'))
                .rejects.toThrow('realm conflict');
        });
    });

    describe('authenticate_user', () => {
        it('returns session PAT on valid credentials', async () => {
            user_repo.find_by_username.mockResolvedValueOnce({
                id: hub_legacy_uuid(1), username: 'alice', password_hash: 'hash', role: 'user', suspended_at: null,
            });
            user_repo.find_by_id.mockResolvedValue(ALICE.user);
            vi.mocked(password.verify_password).mockResolvedValueOnce(true);
            const result = await service.authenticate_user('alice', 'password123');
            expect(result.token).toMatch(/^cliq_tok_/);
            expect(result.user.username).toBe('alice');
            expect(token_repo.create).toHaveBeenCalled();
        });

        it('includes org memberships in response', async () => {
            user_repo.find_by_username.mockResolvedValueOnce({
                id: hub_legacy_uuid(1), username: 'alice', password_hash: 'hash', role: 'user', suspended_at: null,
            });
            user_repo.find_by_id.mockResolvedValue(ALICE.user);
            vi.mocked(password.verify_password).mockResolvedValueOnce(true);
            org_member_repo.find_orgs_by_user.mockResolvedValue([
                { org_id: hub_legacy_uuid(10), slug: 'acme', role: 'member' },
                { org_id: hub_legacy_uuid(20), slug: 'shared', role: 'admin' },
            ]);
            const result = await service.authenticate_user('alice', 'password123');
            expect(result.org_slugs).toEqual(['acme', 'shared']);
        });

        it('returns unauthorized for non-existent username', async () => {
            user_repo.find_by_username.mockResolvedValueOnce(null);
            await expect(service.authenticate_user('ghost', 'password123'))
                .rejects.toThrow('Invalid credentials');
        });

        it('returns unauthorized when password does not match', async () => {
            user_repo.find_by_username.mockResolvedValueOnce({
                id: hub_legacy_uuid(1), username: 'alice', password_hash: 'hash', role: 'user', suspended_at: null,
            });
            vi.mocked(password.verify_password).mockResolvedValueOnce(false);
            await expect(service.authenticate_user('alice', 'wrong'))
                .rejects.toThrow('Invalid credentials');
        });

        it('returns forbidden for suspended user', async () => {
            user_repo.find_by_username.mockResolvedValueOnce({
                id: hub_legacy_uuid(1), username: 'alice', password_hash: 'hash', role: 'user', suspended_at: '2025-06-01',
            });
            vi.mocked(password.verify_password).mockResolvedValueOnce(true);
            await expect(service.authenticate_user('alice', 'password123'))
                .rejects.toThrow('suspended');
        });
    });

    describe('issue_session_token', () => {
        it('mints PAT as target for site admin', async () => {
            const target = { ...ALICE.user!, id: hub_legacy_uuid(2), username: 'bob' };
            user_repo.find_by_id.mockResolvedValue(target);
            const result = await service.issue_session_token(SITE_ADMIN, hub_legacy_uuid(2));
            expect(result.user_id).toBe(hub_legacy_uuid(2));
            expect(result.token).toMatch(/^cliq_tok_/);
        });

        it('rejects non-admin', async () => {
            await expect(service.issue_session_token(ALICE, hub_legacy_uuid(2)))
                .rejects.toThrow('Site admin required');
        });

        it('rejects self', async () => {
            await expect(service.issue_session_token(SITE_ADMIN, hub_legacy_uuid(99)))
                .rejects.toThrow('yourself');
        });

        it('rejects missing target', async () => {
            user_repo.find_by_id.mockResolvedValueOnce(null);
            await expect(service.issue_session_token(SITE_ADMIN, hub_legacy_uuid(2)))
                .rejects.toThrow('User not found');
        });

        it('rejects suspended target', async () => {
            user_repo.find_by_id.mockResolvedValueOnce({
                ...ALICE.user!,
                id: hub_legacy_uuid(2),
                suspended_at: '2025-06-01',
            });
            await expect(service.issue_session_token(SITE_ADMIN, hub_legacy_uuid(2)))
                .rejects.toThrow('suspended');
        });

        it('rejects unauthenticated', async () => {
            await expect(service.issue_session_token(UNAUTHED, 2))
                .rejects.toThrow('Authentication required');
        });
    });

    describe('revoke_session_token', () => {
        it('soft_revokes when prefix+hash match', async () => {
            const plaintext = 'cliq_tok_abc123';
            token_repo.find_by_prefix.mockResolvedValueOnce({
                id: 'tok-1', user_id: hub_legacy_uuid(1), token_hash: 'hash', type: 'user',
            });
            vi.mocked(password.verify_password).mockResolvedValueOnce(true);
            const result = await service.revoke_session_token(plaintext);
            expect(result).toEqual({ ok: true });
            expect(token_repo.soft_revoke_by_id).toHaveBeenCalledWith('tok-1');
        });

        it('is idempotent for unknown tokens', async () => {
            token_repo.find_by_prefix.mockResolvedValueOnce(null);
            const result = await service.revoke_session_token('cliq_tok_unknown');
            expect(result).toEqual({ ok: true });
            expect(token_repo.soft_revoke_by_id).not.toHaveBeenCalled();
        });

        it('is idempotent for non-PAT strings', async () => {
            const result = await service.revoke_session_token('not-a-pat');
            expect(result).toEqual({ ok: true });
        });
    });
});
