/**
 * Who sees a team (PLAN-team-visibility §3.2): public, everyone; private, the members of its scope
 * (not the whole org, not its author by authorship alone); draft, its author.
 */
import { describe, it, expect } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { can_read_team, can_view_team } from '../../../src/auth/access.js';
import { ALICE, BOB, UNAUTHED, ORG_ADMIN, SITE_ADMIN } from '../../helpers/fixtures.js';

/** An org member of acme who isn't assigned to the `acme` scope (nor owner/admin). */
const ACME_MEMBER = { ...BOB, org_slugs: ['acme'], org_ids: [hub_legacy_uuid(1)], member_scopes: [] };

describe('can_view_team', () => {
    it('public: everyone, signed in or not', () => {
        const team = { visibility: 'public' as const, author_id: hub_legacy_uuid(99), scope: 'acme' };
        expect(can_view_team(UNAUTHED, team)).toBe(true);
        expect(can_view_team(BOB, team)).toBe(true);
    });

    it('private: the scope\'s members only', () => {
        const team = { visibility: 'private' as const, author_id: hub_legacy_uuid(99), scope: 'acme' };
        expect(can_view_team(ORG_ADMIN, team)).toBe(true);
        expect(can_view_team(UNAUTHED, team)).toBe(false);
        expect(can_view_team(BOB, team)).toBe(false);
    });

    it('private: an org member not assigned to the scope does not see it', () => {
        const team = { visibility: 'private' as const, author_id: hub_legacy_uuid(99), scope: 'acme' };
        expect(can_view_team(ACME_MEMBER, team)).toBe(false);
    });

    it('private: authorship alone is not membership', () => {
        const team = { visibility: 'private' as const, author_id: hub_legacy_uuid(2), scope: 'acme' };
        expect(can_view_team(ACME_MEMBER, team)).toBe(false);
    });

    it('private in a personal scope: its owner (a member of their personal org\'s scope)', () => {
        const team = { visibility: 'private' as const, author_id: hub_legacy_uuid(1), scope: 'alice' };
        expect(can_view_team(ALICE, team)).toBe(true);
        expect(can_view_team(BOB, team)).toBe(false);
    });

    it('draft: its author only, not the scope\'s members', () => {
        const team = { visibility: 'draft' as const, author_id: hub_legacy_uuid(2), scope: 'acme' };
        expect(can_view_team(BOB, team)).toBe(true);
        expect(can_view_team(ORG_ADMIN, team)).toBe(false);
    });
});

describe('can_read_team', () => {
    it('signed out: only listed public teams', () => {
        expect(can_read_team(undefined, { visibility: 'public', author_id: null, scope: 'acme', listed: 1 })).toBe(true);
        expect(can_read_team(undefined, { visibility: 'public', author_id: null, scope: 'acme', listed: 0 })).toBe(false);
    });

    it('site admins (user token) read any team; through a daemon token they do not', () => {
        const team = { visibility: 'private' as const, author_id: null, scope: 'acme', listed: 1 };
        expect(can_read_team(SITE_ADMIN as never, team)).toBe(true);
        expect(can_read_team({ ...SITE_ADMIN, auth_via: 'daemon_token' } as never, team)).toBe(false);
    });
});
