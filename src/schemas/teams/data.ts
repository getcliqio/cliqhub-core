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

import { z } from 'zod';
import type {
    QueuedInstallResult,
    QueuedUninstallResult,
} from '../../services/dispatch.service.js';

// ─── Canonical team shape ───────────────────────────────────────────────────

/** Canonical team shape returned by all teams endpoints. */
export const TeamData = z.object({
    // Core identity — always present
    id: z.string().optional()
        .describe('Team UUID'),
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
