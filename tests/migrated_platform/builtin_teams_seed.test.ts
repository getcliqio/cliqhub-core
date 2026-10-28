/**
 * The built-in teams (lib/seed.ts, from cliq-sdk `BUILTIN_TEAMS` — the same source cliqd seeds from):
 * every one is registered with its exact manifest and passes the publish lint against the real agent
 * catalog; hello-world 2.2.0's gate attaches review.txt and asks the `reviewers` channel input;
 * hug-example 2.0.0's gate asks for the guest list as a file; seeding again changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import yaml from 'js-yaml';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { BUILTIN_TEAMS } from '@getcliqio/cliq-sdk';

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

    it('every built-in team: its version is registered with the exact manifest and passes the publish lint', async () => {
        await seed_all();
        for (const builtin of BUILTIN_TEAMS) {
            const team = (await Team.findOne({ where: { scope: builtin.scope, name: builtin.name }, raw: true }))!;
            const [row] = await TeamVersion.findAll({ where: { team_id: team.id, version: builtin.version }, raw: true });
            expect(row?.manifest_yaml, `${builtin.name}@${builtin.version}`).toBe(builtin.manifest_yaml);
            await expect(assert_team_lints(yaml.load(builtin.manifest_yaml) as never), builtin.name).resolves.toBeUndefined();
        }
    });

    it('hug-example 2.0.0: the gate attaches plan.md and asks for the guest list as a CSV file; the next phase runs cliq hug files', async () => {
        await seed_all();
        const team = (await Team.findOne({ where: { scope: 'cliq', name: 'hug-example' }, raw: true }))!;
        const [v] = await TeamVersion.findAll({ where: { team_id: team.id, version: '2.0.0' }, raw: true });
        const manifest = yaml.load(v!.manifest_yaml) as { phases: Array<{ name: string; review?: Record<string, unknown>; commands?: Array<{ run: string }> }> };
        const gate = manifest.phases.find((p) => p.name === 'human-review')!;
        expect(gate.review).toMatchObject({ artifacts: ['plan.md'], inputs: [{ name: 'guest_list', type: 'file', accept: ['.csv', 'text/csv'], required: true }] });
        expect(manifest.phases.find((p) => p.name === 'invitations')!.commands![0]!.run).toBe('cliq hug files human-review guest_list guests/');
        expect(JSON.parse(v!.agents_json)).toEqual({ exec: {}, hug: {} });
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
