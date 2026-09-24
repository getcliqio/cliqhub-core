import { z } from 'zod';

export const teams_get_schema = z.object({
    query: z.string().optional(),
    tag: z.string().optional(),
    scope: z.string().optional(),
    mine: z.boolean().optional(),
    group_by_scope: z.boolean().optional(),
    listed: z.boolean().optional(),
    /** Filter by draft vs published status (derived from visibility). */
    status: z.enum(['draft', 'published']).optional(),
    /**
     * When set, return realm team roster + daemon coverage
     * (replaces /v1/realms/teams/get). Catalog filters above are ignored.
     */
    realm_id: z.string().min(1).optional(),
    /**
     * When set, live-query installed teams from that daemon
     * (replaces /v1/daemons/teams/get). Other filters ignored.
     */
    daemon_id: z.string().min(1).optional(),
    origin: z.enum(['published', 'local']).optional(),
    coverage: z.enum(['full', 'partial', 'none']).optional(),
    sort_by: z.enum(['team', 'origin', 'coverage']).optional(),
    sort_dir: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
});

export const teams_get_by_id_schema = z.object({
    name: z.string().optional(),
    scope: z.string().optional(),
    team_id: z.string().uuid().optional(),
    /** When set, load this specific published version instead of latest. */
    version: z.string().optional(),
}).refine(
    (d) => Boolean(d.name) || Boolean(d.team_id),
    { message: 'Either name or team_id is required' },
);

export const teams_get_versions_schema = z.object({
    name: z.string().min(1, 'name is required'),
    scope: z.string().optional(),
    latest_only: z.boolean().optional(),
});

/**
 * Team workflow phases for a published version.
 * Omit version_id → latest semver. Echoes resolved version_id.
 */
export const teams_get_phases_schema = z.object({
    team_id: z.string().uuid(),
    version_id: z.string().uuid().optional(),
});

/** Create a team as draft (visibility draft, listed 0). */
export const teams_create_schema = z.object({
    name: z.string().min(1, 'name is required'),
    scope: z.string().min(1, 'scope is required'),
    description: z.string().optional(),
    /** Manifest as YAML string or JSON object. Seeds version 0.1.0 when present. */
    manifest: z.union([z.string(), z.record(z.unknown())]).optional(),
    /** SPA builder alias — JSON string of the team canvas object. */
    team_json: z.string().optional(),
});

/** Update draft/manifest fields; auto patch-bumps semver (optional minor/major). */
export const teams_update_schema = z.object({
    name: z.string().optional(),
    scope: z.string().optional(),
    team_id: z.string().uuid().optional(),
    description: z.string().optional(),
    manifest: z.union([z.string(), z.record(z.unknown())]).optional(),
    team_json: z.string().optional(),
    bump: z.enum(['minor', 'major']).optional(),
}).refine(
    (d) => Boolean(d.name) || Boolean(d.team_id),
    { message: 'Either name or team_id is required' },
);

export const publish_schema = z.object({
    name: z.string().optional(),
    scope: z.string().optional(),
    team_id: z.string().uuid().optional(),
    version: z.string().optional(),
    bump: z.enum(['patch', 'minor', 'major']).optional(),
    changelog: z.string().optional(),
    description: z.string().optional(),
    license: z.string().optional(),
    tags: z.array(z.string()).optional(),
    /** Must be public or private when publishing (draft is rejected). */
    visibility: z.enum(['public', 'private']).optional(),
    /**
     * Optional when republishing an existing draft that already has versions
     * (status flip only). Required when creating a new published version.
     */
    data_base64: z.string().optional(),
    agents: z.record(z.unknown()).optional(),
}).refine(
    (d) => Boolean(d.name) || Boolean(d.team_id),
    { message: 'Either name or team_id is required' },
);

export const unpublish_schema = z.object({
    name: z.string().optional(),
    scope: z.string().optional(),
    team_id: z.string().uuid().optional(),
}).refine(
    (d) => Boolean(d.name) || Boolean(d.team_id),
    { message: 'Either name or team_id is required' },
);

export const download_schema = z.object({
    name: z.string().min(1, 'name is required'),
    scope: z.string().optional(),
    version: z.string().optional(),
});

export const delete_team_schema = z.object({
    name: z.string().optional(),
    scope: z.string().optional(),
    team_id: z.string().uuid().optional(),
}).refine(
    (d) => d.name || d.team_id,
    { message: 'Either name or team_id is required' },
);

export const delete_version_schema = z.object({
    name: z.string().min(1, 'name is required'),
    scope: z.string().optional(),
    version: z.string().min(1, 'version is required'),
});

export const rename_schema = z.object({
    name: z.string().min(1, 'name is required'),
    scope: z.string().min(1, 'scope is required'),
    new_name: z.string().min(1, 'new_name is required'),
});
