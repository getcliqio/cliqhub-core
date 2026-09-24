/**
 * Zod contracts for Hub Agents API (`POST /v1/agents/*`).
 *
 * Hub SoT is `cliq.agent_catalog` (`AgentCatalogEntry`).
 * Four catalog endpoints: get (list), get_by_id, register, deregister.
 * Settings endpoints are separate (Phase 5).
 *
 * Identity: agents are identified by `(org_id, name, version)`.
 * `org_id` comes from auth context, not the request body.
 */

import { z } from 'zod';

// ── Shared ───────────────────────────────────────────────────────────

/** Manifest can be a JSON string or an object. */
const manifest_input = z.union([
    z.string().min(1),
    z.record(z.string(), z.unknown()),
]);

/** Hub AgentCatalogEntry as returned in all success payloads. */
export const agent_catalog_entry_schema = z.object({
    /** Primary UUID (server-generated). */
    id: z.string(),
    /** Agent name (unique within org or system scope). */
    name: z.string(),
    /** Semver version string, or null if unversioned. */
    version: z.string().nullable(),
    /** Short human description. */
    description: z.string().nullable(),
    /** Agent type: exec, llm, gate, connector, notify, meta. */
    agent_type: z.string(),
    /** True for built-in platform agents; false for org-registered custom agents. */
    is_system: z.boolean(),
    /** AgentManifest object; omitted when include_manifest is false. */
    manifest: z.record(z.string(), z.unknown()).optional(),
    /** Epoch ms. */
    created_at: z.number(),
    /** Epoch ms. */
    updated_at: z.number(),
});

export type Agent_catalog_entry = z.infer<typeof agent_catalog_entry_schema>;

// ── POST /v1/agents/get ──────────────────────────────────────────────

/** Input: list agents visible to the caller's org (system + custom). */
export const agents_get_input = z.object({
    /** Case-insensitive substring match on name or description. */
    query: z.string().min(1).optional(),
    /** Exact name allowlist. */
    names: z.array(z.string().min(1)).min(1).optional(),
    /** Filter by agent_type (e.g. exec, llm, gate). */
    agent_type: z.string().min(1).optional(),
    /** When true (default), include the `manifest` object on each agent. */
    include_manifest: z.boolean().optional(),
}).optional();

/** Output: list of catalog entries. */
export const agents_get_output = z.object({
    ok: z.literal(true),
    agents: z.array(agent_catalog_entry_schema),
});

export type Agents_get_input = z.infer<typeof agents_get_input>;
export type Agents_get_output = z.infer<typeof agents_get_output>;

// ── POST /v1/agents/get_by_id ────────────────────────────────────────

/** Input: single agent by name (+ optional version). */
export const agents_get_by_id_input = z.object({
    /** Agent name. */
    name: z.string().min(1),
    /** Specific version. Omit to get the latest / only match. */
    version: z.string().min(1).optional(),
    /** When true (default), include the `manifest` object. */
    include_manifest: z.boolean().optional(),
});

/** Output: single catalog entry. */
export const agents_get_by_id_output = z.object({
    ok: z.literal(true),
    agent: agent_catalog_entry_schema,
});

export type Agents_get_by_id_input = z.infer<typeof agents_get_by_id_input>;
export type Agents_get_by_id_output = z.infer<typeof agents_get_by_id_output>;

// ── POST /v1/agents/register ─────────────────────────────────────────

/** Input: register a custom agent in the caller's org. */
export const agents_register_input = z.object({
    /** Agent name. */
    name: z.string().min(1),
    /** Semver version string. */
    version: z.string().min(1).optional(),
    /** AgentManifest JSON (string or object). */
    manifest: manifest_input,
    /** Short human description. */
    description: z.string().optional(),
    /** Agent type. Defaults to 'exec'. */
    agent_type: z.string().optional(),
    /** When true, overwrite an existing (org, name, version) row. */
    force: z.boolean().optional(),
});

/** Output: the created or updated catalog entry. */
export const agents_register_output = z.object({
    ok: z.literal(true),
    agent: agent_catalog_entry_schema,
    /** True when an existing row was overwritten via force. */
    updated: z.boolean().optional(),
});

export type Agents_register_input = z.infer<typeof agents_register_input>;
export type Agents_register_output = z.infer<typeof agents_register_output>;

// ── POST /v1/agents/deregister ───────────────────────────────────────

/** Input: remove custom agent(s) by name (+ optional version). */
export const agents_deregister_input = z.object({
    /** Agent name. */
    name: z.string().min(1),
    /** Specific version to remove. Omit to remove all versions. */
    version: z.string().min(1).optional(),
});

/** Output: deregistration result. */
export const agents_deregister_output = z.object({
    ok: z.literal(true),
    /** True if at least one row was removed. */
    deregistered: z.boolean(),
    /** Number of version rows removed. */
    removed_count: z.number().optional(),
});

export type Agents_deregister_input = z.infer<typeof agents_deregister_input>;
export type Agents_deregister_output = z.infer<typeof agents_deregister_output>;

// ── POST /v1/agents/get_settings ──────────────────────────────────────

/** Setting definition as derived from the agent manifest. */
export const setting_def_schema = z.object({
    key: z.string(),
    description: z.string().optional(),
    default: z.unknown().optional(),
    when: z.record(z.string(), z.string()).optional(),
});

/**
 * Input: get settings schema + current values.
 *
 * - With `name`: returns full settings detail for one agent.
 * - Without `name`: returns a summary list of all agents with settings counts.
 */
export const agents_get_settings_input = z.object({
    /** Agent name. Omit for list mode. */
    name: z.string().min(1).optional(),
    /** When set, return realm-level overrides with org fallback. */
    realm_id: z.string().min(1).optional(),
});

/** Output: settings schema from manifest + current values + source map. */
export const agents_get_settings_output = z.object({
    ok: z.literal(true),
    data: z.object({
        name: z.string(),
        settings: z.object({
            required: z.array(setting_def_schema),
            optional: z.array(setting_def_schema),
        }),
        /** Current effective values (realm override > org fallback). */
        values: z.record(z.string(), z.string()),
        /** Source of each value: 'org', 'realm', or null (unset). */
        source: z.record(z.string(), z.enum(['org', 'realm']).nullable()),
        /** True when the value is inherited from org (not overridden at realm). */
        inherited: z.record(z.string(), z.boolean()),
        /** True when the key has a non-empty value at any scope. */
        configured: z.record(z.string(), z.boolean()),
    }),
});

export type Agents_get_settings_input = z.infer<typeof agents_get_settings_input>;
export type Agents_get_settings_output = z.infer<typeof agents_get_settings_output>;

// ── POST /v1/agents/update_settings ──────────────────────────────────

/** Input: update settings for an agent at org or realm scope. */
export const agents_update_settings_input = z.object({
    /** Agent name. */
    name: z.string().min(1),
    /** When set, write to realm scope. Otherwise write to org scope. */
    realm_id: z.string().min(1).optional(),
    /** Settings to upsert or clear. */
    settings: z.object({
        /** Upsert: key → value. */
        values: z.record(z.string(), z.string()).optional(),
        /** Keys to clear at this scope. */
        clear: z.array(z.string().min(1)).optional(),
    }),
});

/** Output: update result. */
export const agents_update_settings_output = z.object({
    ok: z.literal(true),
    applied: z.boolean(),
});

export type Agents_update_settings_input = z.infer<typeof agents_update_settings_input>;
export type Agents_update_settings_output = z.infer<typeof agents_update_settings_output>;
