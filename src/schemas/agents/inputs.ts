/**
 * Agents API — Zod request schemas (SoT for inbound bodies).
 *
 * Naming: PascalCase value + type with the same name (Zod idiom):
 *   `AgentsRegisterInput` schema → `type AgentsRegisterInput = z.infer<…>`
 *
 * Shared pieces live under `schemas/common/` — import and reuse there first.
 * Every field must have `.describe(…)` (feeds Hub OpenAPI / Mintlify).
 */

import { z } from 'zod';

import { ManifestInput } from '../common/manifest.js';

/** POST /v1/agents/get */
export const AgentsGetInput = z.object({
    query: z.string().min(1).optional().describe('Substring match on agent name or description'),
    names: z.array(z.string().min(1)).min(1).optional().describe('When set, only return agents whose name is in this list'),
    agent_type: z.string().min(1).optional().describe('Filter by agent_type (e.g. exec, connector)'),
    include_manifest: z.boolean().optional().describe('When false, omit the heavy manifest from each AgentData row (default true)'),
}).optional();
export type AgentsGetInput = z.infer<typeof AgentsGetInput>;

/** POST /v1/agents/get_by_id */
export const AgentsGetByIdInput = z.object({
    name: z.string().min(1).describe('Agent catalog name (natural key with org)'),
    version: z.string().min(1).optional().describe('Optional version; omit to use the newest active row for this name'),
    include_manifest: z.boolean().optional().describe('When false, omit the manifest from the response (default true)'),
});
export type AgentsGetByIdInput = z.infer<typeof AgentsGetByIdInput>;

/** POST /v1/agents/register */
export const AgentsRegisterInput = z.object({
    name: z.string().min(1).describe('Catalog name to register under the active org'),
    version: z.string().min(1).optional().describe('Version string; falls back to manifest.version when omitted'),
    manifest: ManifestInput.describe('Agent manifest as YAML/JSON string or already-parsed object'),
    description: z.string().optional().describe('Human-readable summary; falls back to manifest.description'),
    agent_type: z.string().optional().describe('Runtime kind; falls back to manifest.agent_type or exec'),
    force: z.boolean().optional().describe('When true, overwrite an existing active (org, name, version) row'),
});
export type AgentsRegisterInput = z.infer<typeof AgentsRegisterInput>;

/** POST /v1/agents/deregister */
export const AgentsDeregisterInput = z.object({
    name: z.string().min(1).describe('Custom agent name to soft-delete'),
    version: z.string().min(1).optional().describe('When set, only that version; omit to soft-delete all org versions of the name'),
});
export type AgentsDeregisterInput = z.infer<typeof AgentsDeregisterInput>;

/** POST /v1/agents/get_settings */
export const AgentsGetSettingsInput = z.object({
    name: z.string().min(1).optional().describe('When set, return SettingsData for one agent; omit for a summary list'),
    realm_id: z.string().min(1).optional().describe('When set, resolve realm overrides / filter summary to realm team_list agents'),
});
export type AgentsGetSettingsInput = z.infer<typeof AgentsGetSettingsInput>;

/** POST /v1/agents/update_settings */
export const AgentsUpdateSettingsInput = z.object({
    name: z.string().min(1).describe('Agent whose settings to mutate'),
    realm_id: z.string().min(1).optional().describe('When set, write realm overrides; otherwise write org defaults'),
    settings: z.object({
        values: z.record(z.string(), z.string()).optional().describe('Keys to upsert (must be declared on the agent manifest)'),
        clear: z.array(z.string().min(1)).optional().describe('Keys to remove so values fall back to unset / inherited'),
    }).describe('Upsert and/or clear operations applied in one call'),
});
export type AgentsUpdateSettingsInput = z.infer<typeof AgentsUpdateSettingsInput>;
