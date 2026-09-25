/**
 * Agents API — Zod request schemas (SoT for inbound bodies).
 *
 * Naming: PascalCase value + type with the same name (Zod idiom):
 *   `AgentsRegisterInput` schema → `type AgentsRegisterInput = z.infer<…>`
 *
 * Shared pieces live under `schemas/common/` — import and reuse there first.
 * Every field must have `.describe(…)` (feeds Hub OpenAPI / Mintlify).
 *
 * AG-1a: every body requires `org_id` (UUID). Tenancy is never taken from X-Org-Id.
 */

import { z } from 'zod';

import { ManifestInput } from '../common/manifest.js';

/** Org tenancy for every agents route — must match Bearer membership / daemon realm org. */
const OrgIdField = z.string().uuid().describe(
    'Organization this call targets. Caller must be authorized for this org '
    + 'via the Bearer credential (PAT membership or daemon realm org).',
);

/** POST /v1/agents/get — list with filters. */
export const AgentsGetInput = z.object({
    org_id: OrgIdField,
    query: z.string().min(1).optional().describe('Substring match on agent name or description'),
    names: z.array(z.string().min(1)).min(1).optional().describe('When set, only return agents whose name is in this list'),
    agent_type: z.string().min(1).optional().describe('Filter by agent_type (e.g. exec, connector)'),
    include_manifest: z.boolean().optional().describe('When false, omit the heavy manifest from each AgentData row (default true)'),
});
export type AgentsGetInput = z.infer<typeof AgentsGetInput>;

/**
 * Shared selector: exactly one of catalog `id` or `name` (+ optional `version`).
 * Used by get_details and (AG-1d) deregister.
 */
export function refine_id_xor_name(
    val: { id?: string; name?: string; version?: string },
    ctx: z.RefinementCtx,
): void {
    const has_id = typeof val.id === 'string' && val.id.length > 0;
    const has_name = typeof val.name === 'string' && val.name.length > 0;
    if (has_id === has_name) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'exactly one of id or name is required',
            path: has_id ? ['name'] : ['id'],
        });
    }
    if (has_id && val.version !== undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'version must not be set when id is provided',
            path: ['version'],
        });
    }
}

/** POST /v1/agents/get_details (was get_by_id) */
export const AgentsGetDetailsInput = z.object({
    org_id: OrgIdField,
    id: z.string().uuid().optional().describe('Catalog row UUID — mutually exclusive with name'),
    name: z.string().min(1).optional().describe('Agent catalog name — mutually exclusive with id'),
    version: z.string().min(1).optional().describe('With name only: pin version; omit for newest active row'),
    include_manifest: z.boolean().optional().describe('When false, omit the manifest from the response (default true)'),
}).superRefine(refine_id_xor_name);
export type AgentsGetDetailsInput = z.infer<typeof AgentsGetDetailsInput>;

/** POST /v1/agents/register */
export const AgentsRegisterInput = z.object({
    org_id: OrgIdField,
    name: z.string().min(1).describe('Catalog name to register under the target org'),
    version: z.string().min(1).optional().describe('Version string; falls back to manifest.version when omitted'),
    manifest: ManifestInput.describe('Agent manifest as YAML/JSON string or already-parsed object'),
    description: z.string().optional().describe('Human-readable summary; falls back to manifest.description'),
    agent_type: z.string().optional().describe('Runtime kind; falls back to manifest.agent_type or exec'),
    force: z.boolean().optional().describe('When true, overwrite an existing active (org, name, version) row'),
});
export type AgentsRegisterInput = z.infer<typeof AgentsRegisterInput>;

/** POST /v1/agents/deregister — id XOR name(+version). */
export const AgentsDeregisterInput = z.object({
    org_id: OrgIdField,
    id: z.string().uuid().optional().describe('Catalog row UUID — mutually exclusive with name'),
    name: z.string().min(1).optional().describe('Custom agent name — mutually exclusive with id'),
    version: z.string().min(1).optional().describe('With name only: one version; omit to soft-delete all org versions'),
}).superRefine(refine_id_xor_name);
export type AgentsDeregisterInput = z.infer<typeof AgentsDeregisterInput>;

/** POST /v1/agents/get_settings — omit id for summary list; id for one agent. */
export const AgentsGetSettingsInput = z.object({
    org_id: OrgIdField,
    id: z.string().uuid().optional().describe('When set, return SettingsData for that catalog row; omit for a summary list'),
    realm_id: z.string().uuid().optional().describe('When set, resolve realm overrides; realm must belong to org_id'),
});
export type AgentsGetSettingsInput = z.infer<typeof AgentsGetSettingsInput>;

/** POST /v1/agents/update_settings — mutate by catalog UUID only. */
export const AgentsUpdateSettingsInput = z.object({
    org_id: OrgIdField,
    id: z.string().uuid().describe('Catalog row UUID whose settings to mutate'),
    realm_id: z.string().uuid().optional().describe('When set, write realm overrides; realm must belong to org_id'),
    settings: z.object({
        values: z.record(z.string(), z.string()).optional().describe('Keys to upsert (must be declared on the agent manifest)'),
        clear: z.array(z.string().min(1)).optional().describe('Keys to remove so values fall back to unset / inherited'),
    }).describe('Upsert and/or clear operations applied in one call'),
});
export type AgentsUpdateSettingsInput = z.infer<typeof AgentsUpdateSettingsInput>;
