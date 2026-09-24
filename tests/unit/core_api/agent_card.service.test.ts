import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/models/index.js', () => ({
    Realm: { findOne: vi.fn() },
}));

vi.mock('../../../src/db/models/index.js', () => ({
    Team: { findOne: vi.fn() },
    TeamVersion: { findOne: vi.fn() },
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
import { Team as HubTeam, TeamVersion } from '../../../src/db/models/index.js';
import { RealmA2aService } from '../../../src/services/realm_a2a.service.js';

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
            team_list: [
                { scope: 'cliq', slug: 'hello-world' },
                { scope: 'cliq', slug: 'gone' },
            ],
        } as any);
        vi.mocked(RealmA2aService.is_enabled).mockResolvedValue(true);

        vi.mocked(HubTeam.findOne)
            .mockResolvedValueOnce({
                id: hub_legacy_uuid(10),
                name: 'hello-world',
                description: 'Say hello',
            } as any)
            .mockResolvedValueOnce(null as any);

        vi.mocked(TeamVersion.findOne).mockResolvedValue({
            capability_json: JSON.stringify({
                inputs: [{ name: 'message', type: 'string' }],
                use_when: ['greeting'],
            }),
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
    });

    it('returns 404 when A2A disabled', async () => {
        vi.mocked(Realm.findOne).mockResolvedValue({
            id: 'r1',
            slug: 'acme',
            name: 'Acme',
            deleted: false,
            team_list: [],
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
        vi.mocked(HubTeam.findOne).mockResolvedValue(null as any);
        const card = await AgentCardService.build_for_realm({
            id: 'r1',
            slug: 'acme',
            name: 'Acme',
            team_list: [{ scope: 'cliq', slug: 'missing' }],
        });
        expect(card.skills.map((s) => s.id)).toEqual(['notify_member']);
    });
});
