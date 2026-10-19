/**
 * Built-in agent catalog — Core's copy of each agent's manifest matches the agent (cliq-agents):
 * the inputs a phase may carry, which are required, and "one of" pairs (`required_unless`).
 * (Fresh and local databases; in production each cliq-agents release writes the full manifests.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { AgentCatalog } from '../../src/models/index.js';
import { seed_all } from '../../src/lib/seed.js';

const has_postgres = await postgres_reachable();

type Inputs = Record<string, { required?: boolean; required_unless?: string[] }>;
const inputs_of = async (name: string): Promise<Inputs> => {
    const row = await AgentCatalog.findOne({ where: { name, is_system: true }, raw: true });
    return ((row?.manifest ?? {}) as { inputs?: Inputs }).inputs ?? {};
};

describe.skipIf(!has_postgres)('built-in agent catalog seed', () => {
    beforeAll(async () => {
        await open_live_hub_app();
        await seed_all();
    }, 300_000);
    afterAll(async () => { await close_live_hub_app(); }, 300_000);

    it.each([
        ['confluence', ['action', 'sources', 'target_entries']],
        ['datadog', ['action', 'sources', 'target_entries']],
        ['hubspot', ['action', 'sources', 'target_entries']],
        ['zendesk', ['action', 'sources', 'target_entries']],
        ['git', ['action', 'base_branch', 'notify', 'project_dir']],
        ['jira', ['action', 'notify', 'sources', 'target_entries']],
        ['email', ['notify']],
        ['team', ['team']],
    ])('%s declares the same inputs as its manifest in cliq-agents', async (name, keys) => {
        expect(Object.keys(await inputs_of(name)).sort()).toEqual(keys);
    });

    it('a connector needs sources or target_entries (one of them); action is required', async () => {
        const jira = await inputs_of('jira');
        expect(jira.action.required).toBe(true);
        expect(jira.sources).toMatchObject({ required: false, required_unless: ['target_entries'] });
        expect(jira.target_entries).toMatchObject({ required: false, required_unless: ['sources'] });
    });

});
