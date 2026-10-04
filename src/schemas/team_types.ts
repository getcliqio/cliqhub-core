/**
 * Teams API — Zod request schemas (SoT for inbound bodies).
 *
 * Naming: PascalCase value + type with the same name (Zod idiom):
 *   `TeamsGetInput` schema → `type TeamsGetInput = z.infer<…>`
 *
 * Every field must have `.describe(…)` (feeds Hub OpenAPI / Mintlify).
 *
 * Routes:
 *   POST /v1/teams/get             — list / search catalog + realm coverage + daemon inventory
 *   POST /v1/teams/get_by_id       — single team detail
 *   POST /v1/teams/get_versions    — version history for a team
 *   POST /v1/teams/get_phases      — workflow phases for a version
 *   POST /v1/teams/create          — create a team as draft
 *   POST /v1/teams/update          — update draft manifest / description
 *   POST /v1/teams/publish         — publish a version
 *   POST /v1/teams/unpublish       — revert published team to draft
 *   POST /v1/teams/download        — fetch pack for a version
 *   POST /v1/teams/delete          — soft-delete a team
 *   POST /v1/teams/delete_version  — remove a specific version
 *   POST /v1/teams/rename          — rename a team within its scope
 *   POST /v1/teams/build           — AI builder actions (generate/validate/suggest/chat)
 *   POST /v1/teams/install         — fan-out install to daemon_ids XOR realm_id
 *   POST /v1/teams/uninstall       — fan-out uninstall from daemon_id/daemon_ids XOR realm_id
 */

import { z } from 'zod';

// ─── Shared field fragments ─────────────────────────────────────────────────

/** Pagination page size. */
const LimitField = z.number().int().min(1).max(200).optional()
    .describe('Page size (default 50, max 200)');

/** Zero-based page offset. */
const OffsetField = z.number().int().min(0).optional()
    .describe('Zero-based page offset (default 0)');

/** Shared sort direction. */
const SortDirField = z.enum(['asc', 'desc']).optional()
    .describe('Sort direction (default asc)');

/** `teams/get` sort keys valid in realm mode (`realm_id`). */
export const TEAM_REALM_SORT_KEYS = ['team', 'origin', 'coverage'] as const;

/** `teams/get` sort keys valid in catalog / site-admin mode (no realm_id, daemon_id or mine). */
export const TEAM_CATALOG_SORT_KEYS = ['name', 'install_count', 'created_at', 'updated_at'] as const;

/** A catalog / site-admin mode sort key. */
export type TeamCatalogSortKey = typeof TEAM_CATALOG_SORT_KEYS[number];

// ─── Read handlers ──────────────────────────────────────────────────────────

/**
 * POST /v1/teams/get — unified list with AND filters.
 *
 * Mode selection (mutually exclusive; all other params apply as AND filters):
 *   - `daemon_id`  → live installed teams from that daemon
 *   - `realm_id`   → realm team roster with daemon coverage
 *   - neither      → Hub catalog search
 */
export const TeamsGetInput = z.object({
    query: z.string().optional()
        .describe('Search: `@scope/name` matches scope and name; other text matches name, description or scope'),
    tag: z.string().optional()
        .describe('Filter by tag slug'),
    scope: z.string().optional()
        .describe('Filter to teams owned by this scope (publisher)'),
    mine: z.boolean().optional()
        .describe('When true, return only teams authored by the caller'),
    group_by_scope: z.boolean().optional()
        .describe('When true, group results by scope instead of a flat list'),
    listed: z.boolean().optional()
        .describe('Filter by listed flag (public marketplace visibility)'),
    status: z.enum(['draft', 'published']).optional()
        .describe('Filter by team status'),
    realm_id: z.string().min(1).optional()
        .describe('Realm mode: return team roster with daemon coverage for this realm'),
    daemon_id: z.string().min(1).optional()
        .describe('Daemon mode: return live installed teams from this daemon'),
    origin: z.enum(['published', 'local']).optional()
        .describe('Realm mode: filter by team origin (published catalog vs local)'),
    coverage: z.enum(['full', 'partial', 'none']).optional()
        .describe('Realm mode: filter by coverage status across realm daemons'),
    sort_by: z.enum([...TEAM_REALM_SORT_KEYS, ...TEAM_CATALOG_SORT_KEYS]).optional()
        .describe('Sort column. Realm mode: team | origin | coverage (default team). Catalog / site-admin '
            + 'mode: name | install_count | created_at | updated_at (default most installed; site-admin '
            + '`listed` / `scope` listing: most recently updated). A key from the other mode, or any key in '
            + 'daemon / mine mode, is 400 invalid_params. Ties are broken by id ascending.'),
    sort_dir: SortDirField,
    limit: LimitField,
    offset: OffsetField,
    with_workflow: z.boolean().optional()
        .describe('Catalog mode: also return each team\'s latest workflow (phase name, type, agent), number of versions, '
            + 'last update, fork count and whether its publisher is verified'),
});
export type TeamsGetInput = z.infer<typeof TeamsGetInput>;

/**
 * POST /v1/teams/get_by_id — fetch one team by UUID or by name + scope.
 * Exactly one of `team_id` or `name` is required.
 */
export const TeamsGetByIdInput = z.object({
    name: z.string().optional()
        .describe('Team name — mutually exclusive with team_id'),
    scope: z.string().optional()
        .describe('Scope (publisher) slug; required when name is provided and scope is ambiguous'),
    team_id: z.string().uuid().optional()
        .describe('Team UUID — mutually exclusive with name'),
    version: z.string().optional()
        .describe('Pin to a specific published version; omit for latest'),
}).refine(
    (d) => Boolean(d.name) || Boolean(d.team_id),
    { message: 'Provide exactly one of team_id or name' },
);
export type TeamsGetByIdInput = z.infer<typeof TeamsGetByIdInput>;

/** POST /v1/teams/get_versions — version history for a team. */
export const TeamsGetVersionsInput = z.object({
    name: z.string().min(1).describe('Team name'),
    scope: z.string().optional().describe('Scope (publisher) slug'),
    latest_only: z.boolean().optional()
        .describe('When true, return only the latest version string instead of the full list'),
});
export type TeamsGetVersionsInput = z.infer<typeof TeamsGetVersionsInput>;

/**
 * POST /v1/teams/get_phases — workflow phases for a published version.
 * Omit `version_id` to resolve the latest semver. Echoes the resolved version_id
 * so callers can pin older runs via run.team_version_id.
 */
export const TeamsGetPhasesInput = z.object({
    team_id: z.string().uuid().describe('Team UUID'),
    version_id: z.string().uuid().optional()
        .describe('Version row UUID; omit for latest published version'),
});
export type TeamsGetPhasesInput = z.infer<typeof TeamsGetPhasesInput>;

// ─── Write handlers ─────────────────────────────────────────────────────────

/**
 * POST /v1/teams/create — create a team as draft.
 * Seeds version 0.1.0 when a manifest is provided.
 * Name must match `^[a-z][a-z0-9-]*$`.
 */
export const TeamsCreateInput = z.object({
    name: z.string()
        .min(1, 'name is required')
        .regex(/^[a-z][a-z0-9-]*$/, 'Team name must be lowercase letters, numbers, and hyphens, starting with a letter')
        .describe('Team name — lowercase letters, numbers, and hyphens; must start with a letter'),
    scope: z.string().min(1, 'scope is required')
        .describe('Scope (publisher) slug; caller must have write access to this scope'),
    description: z.string().optional()
        .describe('Human-readable summary'),
    forked_from: z.object({
        team_id: z.string().uuid().describe('Team to fork'),
        version: z.string().optional().describe('Version to fork from; omit for the latest'),
    }).optional()
        .describe('Start the new team as a copy of this team version (its manifest unless `manifest` is given); the new team records where it came from'),
    manifest: z.union([z.string(), z.record(z.unknown())]).optional()
        .describe('Team manifest as YAML string or parsed object; seeds version 0.1.0 when provided'),
    team_json: z.string().optional()
        .describe('SPA builder canvas JSON string (alternative to manifest)'),
});
export type TeamsCreateInput = z.infer<typeof TeamsCreateInput>;

/**
 * POST /v1/teams/update — update draft manifest / description.
 * Auto patch-bumps semver; pass `bump` for minor/major.
 * Exactly one of `team_id` or `name` is required.
 */
export const TeamsUpdateInput = z.object({
    name: z.string().optional()
        .describe('Team name — mutually exclusive with team_id as the lookup key'),
    scope: z.string().optional()
        .describe('Scope (publisher) slug'),
    team_id: z.string().uuid().optional()
        .describe('Team UUID — mutually exclusive with name as the lookup key'),
    description: z.string().optional()
        .describe('Updated human-readable summary'),
    manifest: z.union([z.string(), z.record(z.unknown())]).optional()
        .describe('Updated manifest as YAML string or parsed object; triggers a new patch version'),
    team_json: z.string().optional()
        .describe('Updated SPA builder canvas JSON string'),
    bump: z.enum(['minor', 'major']).optional()
        .describe('Bump magnitude when updating manifest; omit for patch (default)'),
    save_as: z.enum(['draft', 'version']).optional()
        .describe("'draft': keep the manifest as the team's working copy without minting a version; "
            + "'version' (default): mint the next version from the manifest, or from the working copy when no manifest is sent, and clear the working copy"),
    changelog: z.string().max(2000).optional()
        .describe('What changed in the version being minted'),
}).refine(
    (d) => Boolean(d.name) || Boolean(d.team_id),
    { message: 'Provide exactly one of team_id or name' },
);
export type TeamsUpdateInput = z.infer<typeof TeamsUpdateInput>;

/**
 * POST /v1/teams/publish — publish a draft version.
 * Requires either `team_id` or `name`. `visibility` must not be `draft`.
 */
export const TeamsPublishInput = z.object({
    name: z.string().optional()
        .describe('Team name — mutually exclusive with team_id as the lookup key'),
    scope: z.string().optional()
        .describe('Scope (publisher) slug'),
    team_id: z.string().uuid().optional()
        .describe('Team UUID — mutually exclusive with name as the lookup key'),
    version: z.string().optional()
        .describe('Explicit version string; omit to auto-bump from latest'),
    bump: z.enum(['patch', 'minor', 'major']).optional()
        .describe('Bump magnitude when auto-versioning; omit for patch'),
    changelog: z.string().optional()
        .describe('Release notes for this version'),
    description: z.string().optional()
        .describe('Updated description to apply on publish'),
    license: z.string().optional()
        .describe('SPDX license identifier'),
    tags: z.array(z.string()).optional()
        .describe('Tag slugs to attach'),
    visibility: z.enum(['public', 'private']).optional()
        .describe('Visibility after publish; must be public or private (draft is rejected)'),
    data_base64: z.string().optional()
        .describe('Base64-encoded team package zip (required for first publish without prior versions)'),
    agents: z.record(z.unknown()).optional()
        .describe('Agent binding overrides for this version'),
}).refine(
    (d) => Boolean(d.name) || Boolean(d.team_id),
    { message: 'Provide exactly one of team_id or name' },
);
export type TeamsPublishInput = z.infer<typeof TeamsPublishInput>;

/** POST /v1/teams/unpublish — revert a published team to draft status. */
export const TeamsUnpublishInput = z.object({
    name: z.string().optional()
        .describe('Team name — mutually exclusive with team_id'),
    scope: z.string().optional()
        .describe('Scope (publisher) slug'),
    team_id: z.string().uuid().optional()
        .describe('Team UUID — mutually exclusive with name'),
}).refine(
    (d) => Boolean(d.name) || Boolean(d.team_id),
    { message: 'Provide exactly one of team_id or name' },
);
export type TeamsUnpublishInput = z.infer<typeof TeamsUnpublishInput>;

/** POST /v1/teams/download — fetch the package for a published version. */
export const TeamsDownloadInput = z.object({
    name: z.string().min(1, 'name is required').describe('Team name'),
    scope: z.string().optional().describe('Scope (publisher) slug'),
    version: z.string().optional()
        .describe('Specific version to download; omit for latest published'),
});
export type TeamsDownloadInput = z.infer<typeof TeamsDownloadInput>;

/** POST /v1/teams/delete — soft-delete a team and all its versions. */
export const TeamsDeleteTeamInput = z.object({
    name: z.string().optional()
        .describe('Team name — mutually exclusive with team_id'),
    scope: z.string().optional()
        .describe('Scope (publisher) slug'),
    team_id: z.string().uuid().optional()
        .describe('Team UUID — mutually exclusive with name'),
}).refine(
    (d) => Boolean(d.name) || Boolean(d.team_id),
    { message: 'Provide exactly one of team_id or name' },
);
export type TeamsDeleteTeamInput = z.infer<typeof TeamsDeleteTeamInput>;

/** POST /v1/teams/delete_version — remove a specific published version. */
export const TeamsDeleteVersionInput = z.object({
    name: z.string().min(1, 'name is required').describe('Team name'),
    scope: z.string().optional().describe('Scope (publisher) slug'),
    version: z.string().min(1, 'version is required').describe('Version string to remove'),
});
export type TeamsDeleteVersionInput = z.infer<typeof TeamsDeleteVersionInput>;

/** POST /v1/teams/rename — rename a team within its scope. */
export const TeamsRenameInput = z.object({
    name: z.string().min(1, 'name is required').describe('Current team name'),
    scope: z.string().min(1, 'scope is required').describe('Scope (publisher) slug'),
    new_name: z.string()
        .min(1, 'new_name is required')
        .regex(/^[a-z][a-z0-9-]*$/, 'New name must be lowercase letters, numbers, and hyphens, starting with a letter')
        .describe('New team name — same slug rules as create'),
});
export type TeamsRenameInput = z.infer<typeof TeamsRenameInput>;

// ─── Fleet install / uninstall ──────────────────────────────────────────────

/**
 * POST /v1/teams/install — fan-out install to daemon_ids XOR realm_id.
 * Exactly one of `daemon_ids` (non-empty) or `realm_id` must be provided.
 */
export const TeamsInstallInput = z.object({
    team_id: z.string().uuid().describe('Published team UUID to install'),
    daemon_ids: z.array(z.string().min(1)).optional()
        .describe('Explicit daemon targets — mutually exclusive with realm_id'),
    realm_id: z.string().min(1).optional()
        .describe('Install to every daemon in this realm — mutually exclusive with daemon_ids'),
    agent_settings: z.record(z.string(), z.record(z.string(), z.string())).optional()
        .describe('Per-agent key/value setting overrides applied at install time'),
    force: z.boolean().optional()
        .describe('When true, re-install even if the current version is already present'),
    version: z.string().optional()
        .describe('Pin to a specific published version; omit for latest'),
}).refine(
    (v) => {
        const has_daemons = (v.daemon_ids?.length ?? 0) > 0;
        const has_realm = Boolean(v.realm_id);
        return has_daemons !== has_realm;
    },
    { message: 'Provide exactly one of daemon_ids or realm_id' },
);
export type TeamsInstallInput = z.infer<typeof TeamsInstallInput>;

/**
 * POST /v1/teams/uninstall — fan-out uninstall from daemon_id/daemon_ids XOR realm_id.
 * Exactly one target group must be provided.
 */
export const TeamsUninstallInput = z.object({
    scope: z.string().min(1).describe('Scope (publisher) slug of the team'),
    slug: z.string().min(1).describe('Team slug within the scope'),
    daemon_id: z.string().min(1).optional()
        .describe('Single daemon target — mutually exclusive with realm_id'),
    daemon_ids: z.array(z.string().min(1)).optional()
        .describe('Multiple daemon targets — mutually exclusive with realm_id'),
    realm_id: z.string().min(1).optional()
        .describe('Uninstall from every daemon in this realm — mutually exclusive with daemon_id/daemon_ids'),
}).refine(
    (v) => {
        const ids = [...(v.daemon_id ? [v.daemon_id] : []), ...(v.daemon_ids ?? [])];
        return (ids.length > 0) !== Boolean(v.realm_id);
    },
    { message: 'Provide exactly one of daemon_id/daemon_ids or realm_id' },
);
export type TeamsUninstallInput = z.infer<typeof TeamsUninstallInput>;

/**
 * Teams API — response data types (SoT for OpenAPI / Mintlify).
 *
 * Naming matches inputs: PascalCase value + type with the same name.
 * Every field must have `.describe(…)` (feeds Hub OpenAPI).
 *
 * `TeamData` is the canonical team shape used across all handlers.
 * Catalog fields are always present; coverage fields are populated only
 * when `realm_id` is passed to `get`; daemon fields when `daemon_id` is passed.
 */

import type {
    QueuedInstallResult,
    QueuedUninstallResult,
} from '../services/dispatch.service.js';

// ─── Canonical team shape ───────────────────────────────────────────────────

/** Canonical team shape returned by all teams endpoints. */
export const TeamData = z.object({
    // Core identity — always present
    id: z.string().optional()
        .describe('Catalog team UUID (realm mode: set for published teams; install with it)'),
    name: z.string()
        .describe('Team name (natural key within scope)'),
    scope: z.string().nullable()
        .describe('Scope (publisher) slug; null for global teams'),
    version: z.string().nullable().optional()
        .describe('Latest or requested version string; null when no versions exist'),
    description: z.string().optional()
        .describe('Human-readable summary'),
    status: z.enum(['draft', 'published']).optional()
        .describe('Current lifecycle status'),

    // Catalog fields — present in catalog and get_by_id responses
    visibility: z.string().optional()
        .describe('Visibility level (public, private, draft)'),
    listed: z.boolean().optional()
        .describe('Whether this team appears in the public marketplace'),
    tags: z.array(z.string()).optional()
        .describe('Tag slugs attached to this team'),
    author: z.string().nullable().optional()
        .describe('Username of the team author'),
    latest_version: z.string().optional()
        .describe('Latest published version string'),
    install_count: z.number().int().optional()
        .describe('Total number of daemon installations'),
    version_count: z.number().int().optional()
        .describe('Number of published versions (site-admin catalog listing; catalog with_workflow)'),
    phases: z.array(z.object({
        name: z.string().describe('Phase name'),
        type: z.string().nullable().describe('Phase type (e.g. gate), or null for a standard phase'),
        agent: z.string().nullable().describe('Agent that runs the phase, or null'),
    })).optional()
        .describe('Latest version\'s workflow phases in order (catalog with_workflow)'),
    fork_count: z.number().int().optional()
        .describe('How many teams were forked from this one (catalog with_workflow)'),
    verified: z.boolean().optional()
        .describe('Published by a verified (platform) scope (catalog with_workflow)'),
    author_id: z.string().nullable().optional()
        .describe('UUID of the team author (site-admin catalog listing only)'),
    created_at: z.number().optional()
        .describe('Team creation time (unix ms)'),
    updated_at: z.number().optional()
        .describe('Team last update time (unix ms)'),

    // Coverage fields — populated when realm_id is provided to get
    installed_daemon_ids: z.array(z.string()).optional()
        .describe('IDs of daemons in the realm that have this team installed'),
    installed_count: z.number().int().optional()
        .describe('Number of realm daemons with this team installed'),
    online_daemon_count: z.number().int().optional()
        .describe('Number of online daemons in the realm (coverage denominator)'),
    coverage_label: z.string().optional()
        .describe('Human-readable coverage summary (e.g. "2/3 daemons")'),
    missing_agents: z.array(z.string()).optional()
        .describe('Agent names referenced by this team that are not registered in the org'),
    origin: z.enum(['published', 'local']).optional()
        .describe('Whether the team came from the published catalog or a local install'),
    in_team_list: z.boolean().optional()
        .describe('Whether this team is in the realm team list'),
    last_run_at: z.number().nullable().optional()
        .describe('Timestamp of the most recent run of this team in the realm (unix ms)'),
    slug: z.string().optional()
        .describe('Team slug (alias for name used in daemon/realm context)'),
    label: z.string().optional()
        .describe('Display label for the team (realm coverage context)'),
    sample_team_id: z.string().nullable().optional()
        .describe('UUID of a representative team row (realm coverage context)'),
});
export type TeamData = z.infer<typeof TeamData>;

// ─── Single-team write response ─────────────────────────────────────────────

/** Response data for create / update / publish / unpublish. */
export const TeamMutationData = z.object({
    id: z.string().describe('Team UUID'),
    name: z.string().describe('Team name'),
    scope: z.string().describe('Scope (publisher) slug'),
    status: z.enum(['draft', 'published']).describe('Lifecycle status after the mutation'),
    version: z.string().nullable().describe('Version string after the mutation; null when no version was seeded'),
    listed: z.boolean().optional().describe('Listed flag (present after unpublish)'),
    draft_saved_at: z.string().nullable().optional()
        .describe('teams/update: when the working copy was saved (save_as draft), or null after a version was minted'),
});
export type TeamMutationData = z.infer<typeof TeamMutationData>;

// ─── Version / phases ────────────────────────────────────────────────────────

/** One version entry in a team's version history. */
export const TeamVersionEntry = z.object({
    version: z.string().describe('Semver version string'),
    changelog: z.string().nullable().describe('Release notes for this version'),
    published_at: z.number().nullable().describe('Publish timestamp (unix ms)'),
    is_latest: z.boolean().describe('True when this is the most recent published version'),
});
export type TeamVersionEntry = z.infer<typeof TeamVersionEntry>;

/** Response data for get_versions. */
export const TeamsGetVersionsData = z.object({
    name: z.string().describe('Team name'),
    scope: z.string().nullable().describe('Scope (publisher) slug'),
    latest: z.string().nullable().optional().describe('Latest version string'),
    version: z.string().nullable().optional().describe('Single version (latest_only mode)'),
    versions: z.array(TeamVersionEntry).optional().describe('Full version history'),
});
export type TeamsGetVersionsData = z.infer<typeof TeamsGetVersionsData>;

/** Response data for get_phases. */
export const TeamsGetPhasesData = z.object({
    team_id: z.string().describe('Team UUID'),
    version_id: z.string().nullable().describe('Version row UUID; null when no versions exist'),
    version: z.string().nullable().describe('Resolved version string'),
    phases: z.array(z.record(z.unknown())).describe('Workflow phase definitions'),
});
export type TeamsGetPhasesData = z.infer<typeof TeamsGetPhasesData>;

// ─── Fleet install / uninstall ───────────────────────────────────────────────

/** Per-daemon result entry for install/uninstall. */
export const TeamsDaemonResultEntry = z.object({
    daemon_id: z.string().describe('Daemon that was targeted'),
    ok: z.boolean().describe('Whether the operation succeeded for this daemon'),
    already_installed: z.boolean().optional().describe('Install only: true when the version was already current'),
    error: z.string().optional().describe('Error message when ok is false'),
});
export type TeamsDaemonResultEntry = z.infer<typeof TeamsDaemonResultEntry>;

/**
 * Response data for POST /v1/teams/install.
 * Re-uses `QueuedInstallResult` from dispatch service; typed here for OpenAPI.
 */
export type TeamsInstallData = QueuedInstallResult;

/**
 * Response data for POST /v1/teams/uninstall.
 * `dispatched` is true when at least one daemon result was ok.
 */
export type TeamsUninstallData = QueuedUninstallResult & { dispatched: boolean };


// ── Internal persistence shapes ─────────────────────────────────────────────

export type TeamVo = {
    id: string;
    name: string;
    scope: string | null;
    scope_type: 'user' | 'org' | null;
    description: string;
    author_id: string | null;
    license: string;
    visibility: 'public' | 'private' | 'draft';
    listed: number;
    created_at: string;
    updated_at: string;
    install_count: number;
};

export type TeamListItemVo = {
    id: string;
    name: string;
    scope: string | null;
    description: string;
    author: string | null;
    latest_version: string | null;
    install_count: number;
    listed?: number;
};

export type TeamVersionVo = {
    version: string;
    changelog: string;
    published_at: string;
};

export type TeamVersionDetailVo = {
    id: string;
    team_id: string;
    version: string;
    changelog: string;
    package_path: string;
    cliq_version: string | null;
    tools: string;
    workflow_json: string;
    readme: string;
    capability_json: string;
    agents_json: string;
    published_at: string;
};

export type TeamTagVo = {
    team_id: string;
    tag: string;
};

export type TeamRoleVo = {
    name: string;
    content_md: string;
};

export type TeamListItemDto = {
    id?: string;
    name: string;
    scope: string | null;
    description: string;
    author: string | null;
    latest_version: string;
    install_count: number;
    tags: string[];
    listed: boolean;
    visibility?: string;
    status?: 'draft' | 'published';
    /** Site-admin listing only. */
    version_count?: number;
    /** Site-admin listing only. */
    author_id?: string | null;
};

/** @deprecated Use PascalCase `*Vo` names. */
export type TeamVO = TeamVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamListItemVO = TeamListItemVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamVersionVO = TeamVersionVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamVersionDetailVO = TeamVersionDetailVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamTagVO = TeamTagVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamRoleVO = TeamRoleVo;
/** @deprecated Prefer PascalCase `*Dto` names. */
export type TeamListItemDTO = TeamListItemDto;
