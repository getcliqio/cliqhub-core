import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/models/index.js', () => ({
    Realm: { findOne: vi.fn() },
    Team: { findOne: vi.fn(), findByPk: vi.fn() },
    TeamVersion: { findOne: vi.fn() },
}));

// Version content is read from files (PLAN-team-bundle S1.4b).
vi.mock('../../../src/services/version_content.js', () => ({
    version_content: vi.fn(async () => null),
    latest_version_content: vi.fn(async () => null),
    version_contents: vi.fn(async () => new Map()),
}));

// The realm's teams come from their service (PLAN-team-bundle S4.1), each with the version the realm runs.
vi.mock('../../../src/services/realm_team_list.service.js', () => ({
    RealmTeamListService: { entries: vi.fn(async () => []) },
}));

vi.mock('../../../src/services/realm_a2a.service.js', () => ({
    RealmA2aService: {
        is_enabled: vi.fn(),
    },
}));

vi.mock('../../../src/lib/api_error.js', () => ({
    ApiError: {
        not_found: (msg: string) => Object.assign(new Error(msg), { status: 404 }),
    },
}));

import { AgentCardService } from '../../../src/services/agent_card.service.js';
import { Realm } from '../../../src/models/index.js';
import { Team as HubTeam } from '../../../src/models/index.js';
import { RealmA2aService } from '../../../src/services/realm_a2a.service.js';
import { version_content } from '../../../src/services/version_content.js';
import { RealmTeamListService } from '../../../src/services/realm_team_list.service.js';

const entry = (slug: string, team_id: string, version_id: string) => ({ id: `rt-${slug}`, realm_id: 'r1', team_id, version_id, scope: 'cliq', slug, version: '1.0.0' });

describe('AgentCardService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.CLIQHUB_PUBLIC_API_URL = 'https://api.cliqhub.io';
    });

    it('maps installed teams to skills with capability inputs', async () => {
        vi.mocked(Realm.findOne).mockResolvedValue({
            id: 'r1',
            slug: 'acme',
            name: 'Acme',
            deleted: false,
        } as any);
        vi.mocked(RealmTeamListService.entries).mockResolvedValue([entry('hello-world', hub_legacy_uuid(10), 'v-hello'), entry('gone', hub_legacy_uuid(11), 'v-gone')]);
        vi.mocked(RealmA2aService.is_enabled).mockResolvedValue(true);

        vi.mocked(HubTeam.findByPk)
            .mockResolvedValueOnce({
                id: hub_legacy_uuid(10),
                name: 'hello-world',
                description: 'Say hello',
            } as any)
            .mockResolvedValueOnce(null as any);

        // the version the realm runs, not the team's latest
        vi.mocked(version_content).mockResolvedValue({
            version_id: 'v1', version: '1.0.0',
            inputs: [{ name: 'message', type: 'string' }],
            use_when: ['greeting'],
        } as any);

        const card = await AgentCardService.build_for_slug('acme');

        expect(card.url).toBe('https://api.cliqhub.io/a2a/r/acme');
        expect(card.capabilities.streaming).toBe(true);
        expect(card.skills).toHaveLength(2);
        expect(card.skills[0].id).toBe('cliq/hello-world');
        expect(card.skills[0].metadata.team_id).toBe('cliq/hello-world');
        expect(card.skills[0].metadata.inputs).toEqual([
            { name: 'message', type: 'string' },
        ]);
        expect(card.skills[0].metadata.use_when).toEqual(['greeting']);
        expect(card.skills[1].id).toBe('notify_member');
        expect(version_content).toHaveBeenCalledWith('v-hello');
    });

    it('returns 404 when A2A disabled', async () => {
        vi.mocked(Realm.findOne).mockResolvedValue({
            id: 'r1',
            slug: 'acme',
            name: 'Acme',
            deleted: false,
        } as any);
        vi.mocked(RealmA2aService.is_enabled).mockResolvedValue(false);

        await expect(AgentCardService.build_for_slug('acme')).rejects.toMatchObject({
            status: 404,
        });
    });

    it('returns 404 for missing realm', async () => {
        vi.mocked(Realm.findOne).mockResolvedValue(null as any);

        await expect(AgentCardService.build_for_slug('nope')).rejects.toMatchObject({
            status: 404,
        });
    });

    it('omits unresolved team but still includes notify_member', async () => {
        vi.mocked(HubTeam.findByPk).mockResolvedValue(null as any);
        vi.mocked(RealmTeamListService.entries).mockResolvedValue([entry('missing', hub_legacy_uuid(12), 'v-missing')]);
        const card = await AgentCardService.build_for_realm({
            id: 'r1',
            slug: 'acme',
            name: 'Acme',
        });
        expect(card.skills.map((s) => s.id)).toEqual(['notify_member']);
    });
});
