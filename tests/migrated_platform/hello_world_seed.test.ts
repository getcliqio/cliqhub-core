/**
 * The built-in `@cliq/hello-world` (lib/seed.ts): 2.2.0 is registered with its manifest — the same
 * one cliqd seeds — whose gate attaches review.txt and asks the `reviewers` channel input; it passes
 * the publish lint, and seeding again changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import yaml from 'js-yaml';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { seed_all } from '../../src/lib/seed.js';
import { assert_team_lints } from '../../src/services/teams_service.js';
import { AgentCatalog, Team, TeamVersion } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('built-in hello-world', () => {
    beforeAll(async () => {
        if (!has_postgres) return;
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });
    afterAll(async () => {
        if (!has_postgres) return;
        await close_test_control_plane_store();
    });

    it('2.2.0: the gate attaches review.txt and asks the reviewers channel; the manifest lints; seeding again changes nothing', async () => {
        await seed_all();
        await seed_all();
        const team = (await Team.findOne({ where: { scope: 'cliq', name: 'hello-world' }, raw: true }))!;
        const rows = await TeamVersion.findAll({ where: { team_id: team.id, version: '2.2.0' }, raw: true });
        expect(rows).toHaveLength(1);
        const v = rows[0]!;
        const manifest = yaml.load(v.manifest_yaml) as { version: string; phases: Array<{ name: string; review?: { artifacts?: string[]; reviewers?: Array<{ channels: string[] }> } }> };
        expect(manifest.version).toBe('2.2.0');
        const gate = manifest.phases.find((p) => p.name === 'human-review')!;
        expect(gate.review).toMatchObject({ artifacts: ['review.txt'], reviewers: [{ channels: ['{{inputs.reviewers}}'] }] });
        expect(JSON.parse(v.workflow_json).phases).toEqual(manifest.phases);
        expect(JSON.parse(v.capability_json).inputs.map((i: { name: string; type: string }) => [i.name, i.type])).toEqual([['name', 'text'], ['reviewers', 'channel']]);
        await expect(assert_team_lints(manifest as never)).resolves.toBeUndefined();
    });

    it("the lint reads each agent's newest catalog version: an older hug that required `role` doesn't count", async () => {
        await seed_all();
        const old = await AgentCatalog.create({ name: 'hug', version: '0.0.1', agent_type: 'gate', is_system: true, manifest: { inputs: { role: { required: true }, review: { required: true } } } } as never);
        try {
            await expect(assert_team_lints({ phases: [{ name: 'review', type: 'gate', agent: 'hug', review: { reviewers: [{ channels: ['@ops'] }] } }] })).resolves.toBeUndefined();
        } finally {
            await old.destroy();
        }
    });
});
