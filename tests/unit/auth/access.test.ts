import { describe, it, expect } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { can_view_team } from '../../../src/auth/access.js';
import { ALICE, BOB, UNAUTHED, ORG_ADMIN } from '../../helpers/fixtures.js';

describe('can_view_team', () => {
    it('allows everyone to view public listed teams', () => {
        const team = { visibility: 'public' as const, author_id: hub_legacy_uuid(99), scope: 'org1' };
        expect(can_view_team(UNAUTHED, team)).toBe(true);
        expect(can_view_team(ALICE, team)).toBe(true);
    });

    it('denies unauthenticated users from private teams', () => {
        const team = { visibility: 'private' as const, author_id: hub_legacy_uuid(1), scope: 'alice' };
        expect(can_view_team(UNAUTHED, team)).toBe(false);
    });

    it('allows author to view own private team', () => {
        const team = { visibility: 'private' as const, author_id: hub_legacy_uuid(1), scope: 'alice' };
        expect(can_view_team(ALICE, team)).toBe(true);
    });

    it('denies non-author non-scope-member from private team', () => {
        const team = { visibility: 'private' as const, author_id: hub_legacy_uuid(99), scope: 'other' };
        expect(can_view_team(BOB, team)).toBe(false);
    });

    it('allows scope member to view private org-scoped team', () => {
        const team = { visibility: 'private' as const, author_id: hub_legacy_uuid(99), scope: 'alice' };
        expect(can_view_team(ALICE, team)).toBe(true);
    });

    it('denies non-member from private org-scoped team', () => {
        const team = { visibility: 'draft' as const, author_id: hub_legacy_uuid(99), scope: 'org1' };
        expect(can_view_team(BOB, team)).toBe(false);
    });
});
