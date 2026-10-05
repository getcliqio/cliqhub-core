import { ApiError } from '../errors/api_error.js';
import { can_read_team, can_view_team } from '../auth/access.js';
import { assert_access, assert_admin_access } from '../auth/assert_grant.js';

import yaml from 'js-yaml';
import { extract_package, normalize_tags, compute_next_version, workflow_from_team_yml, enrich_required_inputs } from './package_parser.js';
import type { ParsedTeamYml } from './package_parser.js';
import { SemVer } from '../lib/semver.js';
import { SLUG_PATTERN, RESERVED_SCOPES } from '../config/env.js';
import type { TeamRepository } from '../repositories/team_repository.js';
import type { TeamVersionRepository } from '../repositories/team_version_repository.js';
import type { TagRepository } from '../repositories/tag_repository.js';
import type { DownloadLogRepository } from '../repositories/download_log_repository.js';
import type { ScopeRepository } from '../repositories/scope_repository.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { PackageStorage } from '../storage/package_storage.js';
import { package_key, package_path } from '../storage/package_storage.js';
import type { AuthContext } from '../schemas/auth_types.js';
import type { TeamCatalogSortKey, TeamListItemVO, TeamRoleVO } from '../schemas/team_types.js';
import { Op, QueryTypes, col, fn, literal, type WhereOptions } from 'sequelize';
import { list_order, type SortColumns, type SortDir } from '../lib/list_sort.js';
import type { NormalizedWorkflow } from './package_parser.js';
import { RealmTeamListService } from '../services/realm_team_list.service.js';
import { get_sequelize } from '../lib/sequelize.js';
import { ScopeRepository as ScopeRepoClass } from '../repositories/scope_repository.js';
import { OrgMemberRepository as OrgMemberRepoClass } from '../repositories/org_member_repository.js';

import { get_logger } from '../lib/log.js';
import { escape_like } from '../lib/search.js';

const log = get_logger('svc.teams');

const _scope_repo_ts = new ScopeRepoClass();
const _org_member_repo_ts = new OrgMemberRepoClass();

function team_status(visibility: string): 'draft' | 'published' {
    return visibility === 'draft' ? 'draft' : 'published';
}

/**
 * `manifest_yaml` with its top-level `name:` set to `name` (added at the top
 * when missing); the rest of the text, comments included, is kept as is.
 */
export function with_manifest_name(manifest_yaml: string, name: string): string {
    const line = /^name:.*$/m;
    return line.test(manifest_yaml) ? manifest_yaml.replace(line, `name: ${name}`) : `name: ${name}\n${manifest_yaml}`;
}

/** Normalize optional manifest (YAML string, JSON object, or team_json string). */
function resolve_manifest_yaml(params: {
    manifest?: string | Record<string, unknown>;
    team_json?: string;
}): string | null {
    if (params.team_json) return params.team_json;
    if (params.manifest == null) return null;
    if (typeof params.manifest === 'string') return params.manifest;
    try {
        return yaml.dump(params.manifest);
    } catch {
        return JSON.stringify(params.manifest);
    }
}

function parse_manifest_yaml(manifest_yaml: string): ParsedTeamYml | null {
    try {
        const parsed = yaml.load(manifest_yaml);
        if (parsed && typeof parsed === 'object') return parsed as ParsedTeamYml;
    } catch { /* ignore */ }
    try {
        const parsed = JSON.parse(manifest_yaml);
        if (parsed && typeof parsed === 'object') return parsed as ParsedTeamYml;
    } catch { /* ignore */ }
    return null;
}

function build_visibility_where(auth: AuthContext): WhereOptions {
    if (!auth.user) {
        return { visibility: 'public', listed: 1 };
    }
    const scope_slugs = auth.scopes.map((s) => s.slug);
    if (scope_slugs.length === 0) {
        return {
            [Op.or]: [
                { visibility: 'public', listed: 1 },
                { visibility: 'draft', author_id: auth.user.id },
            ],
        };
    }
    return {
        [Op.or]: [
            { listed: 1, visibility: 'public' },
            { listed: 1, visibility: 'private', scope: { [Op.in]: scope_slugs } },
            { visibility: 'draft', author_id: auth.user.id },
        ],
    };
}

/**
 * `teams/get` search: `@scope/name` (or `scope/name`) matches the scope and
 * the name; any other text matches the name, description or scope. Case
 * insensitive substring matches; null when there is nothing to search.
 */
export function team_query_where(raw: string | undefined): WhereOptions | null {
    const q = (raw ?? '').trim().replace(/^@+/, '');
    if (!q) return null;
    const like = (text: string) => ({ [Op.iLike]: `%${escape_like(text)}%` });
    const slash = q.indexOf('/');
    if (slash >= 0) {
        const scope = q.slice(0, slash).trim();
        const name = q.slice(slash + 1).trim();
        return { [Op.and]: [...(scope ? [{ scope: like(scope) }] : []), ...(name ? [{ name: like(name) }] : [])] };
    }
    return { [Op.or]: [{ name: like(q) }, { description: like(q) }, { scope: like(q) }] };
}

/** `teams/get` catalog / site-admin sort key → ORDER BY (qualified: the author join also has columns). */
const TEAM_SORT_COLUMNS: SortColumns<TeamCatalogSortKey> = {
    name: (d) => [[fn('LOWER', col('Team.name')), d]],
    install_count: (d) => [['install_count', d]],
    created_at: (d) => [['created_at', d]],
    updated_at: (d) => [['updated_at', d]],
};

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

export class TeamsService {
    constructor(
        private _team_repo: TeamRepository,
        private _version_repo: TeamVersionRepository,
        private _tag_repo: TagRepository,
        private _download_log_repo?: DownloadLogRepository,
        private _storage?: PackageStorage,
        private _packages_path?: string,
        private _scope_repo?: ScopeRepository,
        private _audit_repo?: AuditRepository,
    ) {}

    // ─── Unified list (replaces list, search, list_mine, list_all_mine, admin_list_teams) ───

    async get(auth: AuthContext, params: {
        query?: string; tag?: string; scope?: string;
        mine?: boolean; group_by_scope?: boolean; listed?: boolean;
        status?: 'draft' | 'published';
        limit?: number; offset?: number;
        /** Catalog / site-admin modes only (the controller rejects it elsewhere). */
        sort_by?: TeamCatalogSortKey; sort_dir?: SortDir;
        /** Site-admin listing only. */
        org_id?: string; installed_realm_id?: string;
    }) {
        log.debug('get', { scope: params.scope, status: params.status });
        if (params.mine) {
            return this._get_mine(auth, params);
        }

        const is_admin = auth.user?.role === 'admin';
        const limit = Math.min(params.limit || 50, 100);
        const offset = params.offset || 0;

        if (is_admin && (params.listed !== undefined || params.scope || params.org_id || params.installed_realm_id)) {
            return this._get_admin(auth, params, limit, offset);
        }

        const conditions: WhereOptions[] = [build_visibility_where(auth)];

        const query_where = team_query_where(params.query);
        if (query_where) conditions.push(query_where);
        if (params.tag) {
            conditions.push(
                literal(`EXISTS (SELECT 1 FROM team_tags tt WHERE tt.team_id = "Team"."id" AND tt.tag = ${get_sequelize().escape(params.tag)})`) as any,
            );
        }
        if (params.status === 'draft') {
            conditions.push({ visibility: 'draft' });
        } else if (params.status === 'published') {
            conditions.push({ visibility: { [Op.ne]: 'draft' } });
        }

        const where: WhereOptions = { [Op.and]: conditions };
        const total = await this._team_repo.count_filtered(where);
        const rows = await this._team_repo.list_filtered(where, limit, offset, list_order(TEAM_SORT_COLUMNS, params, [['install_count', 'DESC']]));
        const tag_map = await this._build_tag_map(rows);
        return { teams: rows, tag_map, total, limit, offset };
    }

    private async _get_mine(auth: AuthContext, params: {
        scope?: string; group_by_scope?: boolean; query?: string;
        tag?: string; limit?: number; offset?: number;
        status?: 'draft' | 'published';
    }) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);

        if (params.group_by_scope) {
            // Include both the user's own scopes and all public scopes
            // so that teams like @cliq/hello-world are always visible.
            const public_scopes = await _scope_repo_ts.find_all_q({ where: { visibility: 'public', scope_type: 'org' }, attributes: ['id', 'slug', 'display_name', 'visibility', 'scope_type'], raw: true });

            const scope_map = new Map<string, typeof auth.scopes[0]>();
            for (const s of auth.scopes) scope_map.set(s.slug, s);
            for (const s of public_scopes) {
                if (!scope_map.has(s.slug)) scope_map.set(s.slug, s as any);
            }

            const all_scopes = [...scope_map.values()];
            if (all_scopes.length === 0) return { scopes: [] };

            const scope_slugs = all_scopes.map((s) => s.slug);
            let rows = await this._team_repo.list_by_scope_list(scope_slugs);
            if (params.status === 'draft') {
                rows = rows.filter((t: any) => t.visibility === 'draft');
            } else if (params.status === 'published') {
                rows = rows.filter((t: any) => t.visibility !== 'draft');
            }
            const tag_map = await this._build_tag_map(rows);
            const query = params.query?.trim().toLowerCase();

            const grouped = all_scopes.map((s) => {
                let teams = rows.filter((t: any) => t.scope === s.slug);
                if (query) {
                    teams = teams.filter((t: any) =>
                        String(t.name).toLowerCase().includes(query)
                        || String(t.description || '').toLowerCase().includes(query),
                    );
                }
                return {
                    slug: s.slug,
                    display_name: s.display_name,
                    scope_type: s.scope_type,
                    visibility: s.visibility,
                    teams,
                };
            }).filter((g) => g.teams.length > 0);
            return { scopes: grouped, tag_map };
        }

        // Flat mine list — include all scopes the user can see.
        const scope_slugs = auth.scopes.map((s) => s.slug);
        let rows = scope_slugs.length
            ? await this._team_repo.list_by_scope_list(scope_slugs)
            : [];
        // Also include author drafts that may live outside listed scopes.
        if (params.status === 'draft' || !params.status) {
            const author_drafts = await this._team_repo.find_all_q({
                where: { author_id: auth.user.id, visibility: 'draft' },
                attributes: [
                    'id', 'name', 'scope', 'description', 'install_count', 'listed', 'visibility',
                    'updated_at',
                ],
                raw: true,
            });
            const seen = new Set(rows.map((r: any) => r.id));
            for (const d of author_drafts) {
                if (!seen.has(d.id)) rows.push(d as any);
            }
        }
        if (params.status === 'draft') {
            rows = rows.filter((t: any) => t.visibility === 'draft');
        } else if (params.status === 'published') {
            rows = rows.filter((t: any) => t.visibility !== 'draft');
        }
        if (params.query) {
            const q = params.query.trim().toLowerCase();
            rows = rows.filter((t: any) =>
                String(t.name).toLowerCase().includes(q)
                || String(t.description || '').toLowerCase().includes(q),
            );
        }
        const tag_map = await this._build_tag_map(rows);
        return { teams: rows, tag_map };
    }

    private async _get_admin(_auth: AuthContext, params: {
        query?: string; scope?: string; listed?: boolean;
        limit?: number; offset?: number;
        sort_by?: TeamCatalogSortKey; sort_dir?: SortDir;
        org_id?: string; installed_realm_id?: string;
    }, limit: number, offset: number) {
        const conditions: WhereOptions[] = [];
        const esc = (v: string) => get_sequelize().escape(v);

        const query_where = team_query_where(params.query);
        if (query_where) conditions.push(query_where);
        if (params.scope !== undefined) { conditions.push({ scope: params.scope }); }
        if (params.listed !== undefined) { conditions.push({ listed: params.listed ? 1 : 0 }); }
        if (params.org_id) {
            conditions.push(literal(`"Team"."scope" IN (SELECT s.slug FROM scopes s WHERE s.org_id::text = ${esc(params.org_id)})`) as any);
        }
        // Installed = a daemon of the realm carries a team with this scope + name.
        if (params.installed_realm_id) {
            conditions.push(literal(`EXISTS (SELECT 1 FROM daemon_teams dt JOIN scopes s ON s.id::text = dt.scope_id::text JOIN realm_members rm ON rm.member_id::text = dt.daemon_id::text AND rm.member_type = 'daemon' WHERE rm.realm_id::text = ${esc(params.installed_realm_id)} AND dt.slug = "Team"."name" AND s.slug = "Team"."scope")`) as any);
        }

        const where: WhereOptions = conditions.length > 0 ? { [Op.and]: conditions } : {};

        const { total, rows } = await this._team_repo.list_admin(where, limit, offset, list_order(TEAM_SORT_COLUMNS, params, [['updated_at', 'DESC']]));
        const tag_map = await this._build_tag_map(rows);
        return { teams: rows, tag_map, total, limit, offset };
    }

    // ─── Single team detail (was: get) ──────────────────────────────

    async get_by_id(auth: AuthContext, params: {
        name?: string; scope?: string; version?: string; team_id?: string;
    }) {
        log.debug('get_by_id', { team_id: params.team_id, name: params.name, scope: params.scope });
        let team;
        if (params.team_id) {
            team = await this._team_repo.find_by_id(params.team_id);
        } else {
            if (!params.name) throw new ApiError('invalid_params', 'name is required', 422);
            const scope = params.scope || null;
            team = await this._team_repo.find_by_name_and_scope(params.name, scope);
        }
        if (!team || !can_read_team(auth, team)) throw new ApiError('not_found', 'Team not found', 404);

        const author = team.author_id ? await this._team_repo.find_author_username(team.author_id) : null;
        const versions = await this._version_repo.list_by_team_id(team.id);
        const tags = await this._tag_repo.find_by_team_id(team.id);

        const latest_ver = versions[0];

        /** Resolve which version to load detail for. */
        const target_version = params.version
            ? versions.find((v) => v.version === params.version)?.version
            : latest_ver?.version;

        if (params.version && !target_version) {
            throw new ApiError('not_found', `Version ${params.version} not found`, 404);
        }

        let roles: TeamRoleVO[] = [];
        let workflow: { phases: unknown[]; support?: unknown[] } = { phases: [] };
        let agents: unknown = {};
        let readme = ''; let cliq_version: string | null = null;
        let tools: string[] = []; let inputs: unknown[] | undefined;
        let use_when: string[] | undefined; let not_for: string[] | undefined;
        let version_manifest_yaml = '';

        if (target_version) {
            const ver_row = await this._version_repo.find_detail_by_team_and_version(team.id, target_version);
            if (ver_row) {
                try {
                    const parsed = JSON.parse(ver_row.workflow_json) as { phases?: unknown[]; support?: unknown[] };
                    workflow = {
                        phases: Array.isArray(parsed.phases) ? parsed.phases : [],
                        ...(Array.isArray(parsed.support) && parsed.support.length ? { support: parsed.support } : {}),
                    };
                } catch { /* default */ }
                try { agents = JSON.parse(ver_row.agents_json || '{}'); } catch { /* default */ }
                readme = ver_row.readme || '';
                cliq_version = ver_row.cliq_version || null;
                try { tools = JSON.parse(ver_row.tools); } catch { /* default */ }
                try { const raw = JSON.parse(ver_row.capability_json); if (raw) { inputs = raw.inputs; use_when = raw.use_when; not_for = raw.not_for; } } catch { /* default */ }
                try { roles = JSON.parse(ver_row.roles_json || '[]'); } catch { /* default */ }
                version_manifest_yaml = ver_row.manifest_yaml || '';
            }
        }

        // Compute caller permissions for this team.
        const permissions = await this._resolve_team_permissions(auth, team);
        const forked_from = await this._fork_summary(auth, team);
        const fork_count = await this._team_repo.count_forks(team.id);
        const working = team as { draft_manifest?: string | null; draft_description?: string | null; draft_saved_at?: Date | null };
        // Only people who can edit the team see its unversioned working copy.
        const draft = permissions.can_edit && working.draft_manifest
            ? { manifest: working.draft_manifest, description: working.draft_description ?? null, saved_at: working.draft_saved_at ?? null }
            : null;

        /**
         * Prefer version-specific manifest_yaml (from team_versions) when
         * viewing a published version. Fall back to the teams-table
         * raw manifest for the current installed version.
         */
        const team_row_manifest = (team as unknown as Record<string, unknown>).manifest;
        const raw_manifest = version_manifest_yaml
            || (typeof team_row_manifest === 'string' ? team_row_manifest : null)
            || null;

        return {
            id: team.id,
            name: team.name, scope: team.scope, description: team.description,
            license: team.license, visibility: team.visibility,
            status: team_status(team.visibility),
            author, author_id: team.author_id ?? null,
            latest_version: latest_ver?.version || '0.0.0',
            install_count: team.install_count, tags: tags.map((t) => t.tag),
            created_at: team.created_at, updated_at: team.updated_at,
            versions, roles, workflow, agents, readme, cliq_version, tools,
            inputs, use_when, not_for,
            listed: team.listed !== 0,
            raw_manifest,
            /** SPA builder compat — same payload as former drafts.team_json. */
            team_json: raw_manifest,
            forked_from,
            fork_count,
            draft,
            ...permissions,
        };
    }

    // ─── Version queries ────────────────────────────────────────────

    async get_versions(auth: AuthContext, params: { name: string; scope?: string; latest_only?: boolean }) {
        log.debug('get_versions', { name: params.name, scope: params.scope });
        const scope = params.scope || null;
        const team = await this._team_repo.find_by_name_and_scope(params.name, scope);
        // Same visibility as get_by_id (S14): private teams were readable here.
        if (!team || !can_read_team(auth, team)) throw new ApiError('not_found', 'Team not found', 404);

        if (params.latest_only) {
            const version = await this._version_repo.find_latest_version(team.id);
            return { name: params.name, scope, version };
        }

        const rows = await this._version_repo.list_by_team_id(team.id);
        const latest = rows.length > 0 ? rows[0].version : null;
        return {
            name: params.name, scope, latest,
            versions: rows.map((r) => ({ version: r.version, changelog: r.changelog || null, published_at: r.published_at, is_latest: r.version === latest })),
        };
    }

    /**
     * Workflow phases for a team version. Omit version_id → latest
     * semver. Echoes the resolved version_id so callers (SPA run detail)
     * can pin older runs via run.team_version_id.
     */
    async get_phases(
        auth: AuthContext,
        params: { team_id: string; version_id?: string },
    ) {
        log.debug('get_phases', { team_id: params.team_id, version_id: params.version_id });
        const team = await this._team_repo.find_by_id(params.team_id);
        // Same visibility as get_by_id (S14): workflow and prompts of private teams leaked here.
        if (!team || !can_read_team(auth, team)) throw new ApiError('not_found', 'Team not found', 404);

        let version_row: {
            id: string;
            version: string;
            workflow_json: string;
            manifest_yaml: string;
        } | null = null;

        if (params.version_id) {
            const row = await this._version_repo.find_by_id(params.version_id);
            if (!row || row.team_id !== params.team_id) {
                throw new ApiError('not_found', 'Team version not found', 404);
            }
            version_row = {
                id: row.id,
                version: row.version,
                workflow_json: row.workflow_json ?? '{}',
                manifest_yaml: row.manifest_yaml ?? '',
            };
        } else {
            const latest = await this._version_repo.find_latest_detail(params.team_id);
            if (!latest) {
                return {
                    team_id: params.team_id,
                    version_id: null,
                    version: null,
                    phases: [] as Array<Record<string, unknown>>,
                };
            }
            version_row = {
                id: latest.id,
                version: latest.version,
                workflow_json: latest.workflow_json ?? '{}',
                manifest_yaml: latest.manifest_yaml ?? '',
            };
        }

        let phases: unknown[] = [];
        try {
            const parsed = JSON.parse(version_row.workflow_json) as { phases?: unknown };
            if (Array.isArray(parsed.phases)) phases = parsed.phases;
        } catch { /* fall through */ }

        if (phases.length === 0 && version_row.manifest_yaml) {
            try {
                const doc = yaml.load(version_row.manifest_yaml) as { phases?: unknown } | null;
                if (doc && Array.isArray(doc.phases)) phases = doc.phases;
            } catch { /* empty */ }
        }

        return {
            team_id: params.team_id,
            version_id: version_row.id,
            version: version_row.version,
            phases,
        };
    }

    // ─── Write methods ──────────────────────────────────────────────

    /**
     * Create a team as draft (`visibility: draft`, `listed: 0`).
     * Seeds version `0.1.0` when a manifest is provided.
     */
    async create(auth: AuthContext, params: {
        name: string; scope: string; description?: string;
        forked_from?: { team_id: string; version?: string };
        manifest?: string | Record<string, unknown>; team_json?: string;
    }) {
        log.debug('create', { name: params.name, scope: params.scope });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');
        if (!SLUG_PATTERN.test(params.name)) {
            throw new ApiError('invalid_params', 'Team name must be lowercase letters, numbers, and hyphens, starting with a letter', 422);
        }
        if (!auth.scopes.some((s) => s.slug === params.scope)) {
            throw new ApiError('forbidden', `You don't have access to scope '@${params.scope}'`, 403);
        }

        const existing = await this._team_repo.find_by_name_and_scope(params.name, params.scope);
        if (existing) throw new ApiError('conflict', `Team @${params.scope}/${params.name} already exists`, 409);

        const origin = params.forked_from ? await this._fork_origin(auth, params.forked_from) : null;
        const description = params.description || origin?.description || '';
        const manifest_yaml = resolve_manifest_yaml(params)
            ?? (origin ? with_manifest_name(origin.manifest_yaml, params.name) : null);
        const scope_record = auth.scopes.find((s) => s.slug === params.scope);
        const scope_type = scope_record?.scope_type || null;

        let team_id = '';
        let version: string | undefined;

        await get_sequelize().transaction(async (t) => {
            team_id = await this._team_repo.create(
                params.name, params.scope, scope_type, description,
                auth.user!.id, 'MIT', 'draft', t, 0,
            );

            if (manifest_yaml) {
                version = '0.1.0';
                await this._seed_version_from_manifest(team_id, version, manifest_yaml, description, t);
            }
            if (origin) await this._team_repo.set_fork_origin(team_id, origin.team_id, origin.version, t);
        });

        log.info('team_created', { team_id, name: params.name, scope: params.scope, forked_from: origin ? `${origin.team_id}@${origin.version}` : null });
        return {
            id: team_id,
            name: params.name,
            scope: params.scope,
            status: 'draft' as const,
            version: version ?? null,
        };
    }

    /**
     * Edits a team. Versions are never changed: with `save_as: 'draft'` the
     * manifest is kept as the team's working copy; otherwise (`'version'`, the
     * default) the next version is minted — patch unless `bump` says minor or
     * major — from the manifest sent, or from the working copy when none is
     * sent, and the working copy is cleared.
     *
     * @throws ApiError 422 when saving a draft without a manifest.
     */
    async update(auth: AuthContext, params: {
        name?: string; scope?: string; team_id?: string;
        description?: string;
        manifest?: string | Record<string, unknown>; team_json?: string;
        bump?: 'minor' | 'major';
        save_as?: 'draft' | 'version' | 'discard';
        changelog?: string;
    }) {
        log.debug('update', { team_id: params.team_id, name: params.name, scope: params.scope });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');

        const team = await this._resolve_team_for_write(auth, params);
        const sent_manifest = resolve_manifest_yaml(params);

        if (params.save_as === 'discard') {
            await this._team_repo.clear_draft(team.id);
            return {
                id: team.id,
                name: team.name,
                scope: team.scope,
                status: team_status(team.visibility),
                version: null,
                draft_saved_at: null,
            };
        }

        if (params.save_as === 'draft') {
            if (!sent_manifest) throw new ApiError('invalid_params', 'A draft needs a manifest', 422, { field: 'manifest' });
            await this._team_repo.save_draft(team.id, sent_manifest, params.description ?? null);
            return {
                id: team.id,
                name: team.name,
                scope: team.scope,
                status: team_status(team.visibility),
                version: null,
                draft_saved_at: new Date().toISOString(),
            };
        }

        const working = team as { draft_manifest?: string | null; draft_description?: string | null };
        const manifest_yaml = sent_manifest ?? working.draft_manifest ?? null;
        const new_description = params.description ?? (sent_manifest ? undefined : working.draft_description ?? undefined);
        const description = new_description !== undefined ? new_description : team.description;

        let resolved_version: string | null = null;

        await get_sequelize().transaction(async (t) => {
            if (new_description !== undefined) {
                await this._team_repo.update_description(team.id, description, t);
            }

            if (manifest_yaml) {
                const latest = await this._version_repo.find_latest_version(team.id);
                const bump = params.bump || 'patch';
                resolved_version = compute_next_version(latest, bump);
                // First manifest on a create-without-manifest team → seed 0.1.0
                if (!latest) resolved_version = '0.1.0';
                await this._seed_version_from_manifest(
                    team.id, resolved_version, manifest_yaml, params.changelog ?? description, t,
                );
                if (working.draft_manifest) await this._team_repo.clear_draft(team.id, t);
            }
        });

        return {
            id: team.id,
            name: team.name,
            scope: team.scope,
            status: team_status(team.visibility),
            version: resolved_version,
            draft_saved_at: null,
        };
    }

    /** Return a draft team to draft status (visibility draft, listed 0). Versions kept. */
    async unpublish(auth: AuthContext, params: {
        name?: string; scope?: string; team_id?: string;
    }) {
        log.debug('unpublish', { team_id: params.team_id, name: params.name, scope: params.scope });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');

        const team = await this._resolve_team_for_write(auth, params);
        await this._team_repo.update_visibility_and_listed(team.id, 'draft', 0);

        if (auth.user.role === 'admin' && team.author_id !== auth.user.id && this._audit_repo) {
            await this._audit_repo.create(auth.user.id, 'team.unpublish', 'team', team.id, {
                name: team.name, scope: team.scope,
            });
        }

        return {
            id: team.id,
            name: team.name,
            scope: team.scope,
            status: 'draft' as const,
            listed: false,
        };
    }

    async publish(auth: AuthContext, params: {
        name?: string; scope?: string; team_id?: string;
        version?: string; bump?: 'patch' | 'minor' | 'major';
        changelog?: string; description?: string; license?: string;
        tags?: string[]; visibility?: 'public' | 'private';
        data_base64?: string; agents?: Record<string, unknown>;
    }) {
        log.debug('publish', { team_id: params.team_id, name: params.name, scope: params.scope });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');

        let team = null as Awaited<ReturnType<TeamRepository['find_by_id']>>;
        if (params.team_id) {
            team = await this._team_repo.find_by_id(params.team_id);
            if (!team) throw new ApiError('not_found', 'Team not found', 404);
            if (team.author_id !== auth.user.id && auth.user.role !== 'admin') {
                throw new ApiError('forbidden', 'You are not the author of this team', 403);
            }
        }

        const name = params.name || team?.name;
        if (!name) throw new ApiError('invalid_params', 'name is required', 422);
        if (!SLUG_PATTERN.test(name)) throw new ApiError('invalid_params', 'Team name must be lowercase letters, numbers, and hyphens, starting with a letter', 422);

        const scope = params.scope !== undefined ? (params.scope || null) : (team ? team.scope : null);
        if (scope && !auth.scopes.some((s) => s.slug === scope) && auth.user.role !== 'admin') {
            throw new ApiError('forbidden', `You don't have access to scope '@${scope}'`, 403);
        }

        if (!team) {
            team = await this._team_repo.find_by_name_and_scope(name, scope);
            if (team && team.author_id !== auth.user.id && auth.user.role !== 'admin') {
                throw new ApiError('forbidden', 'You are not the author of this team', 403);
            }
        }

        const visibility = params.visibility || 'public';

        // Status-only republish: flip draft → published without a new package.
        if (!params.data_base64) {
            if (!team) throw new ApiError('invalid_params', 'data_base64 is required for new teams', 422);
            const latest = await this._version_repo.find_latest_version(team.id);
            if (!latest) throw new ApiError('invalid_params', 'data_base64 is required when the team has no versions', 422);
            if (params.tags && params.tags.length > 20) throw new ApiError('invalid_params', 'Maximum 20 tags allowed', 422);
            await this._team_repo.update_visibility_and_listed(team.id, visibility, 1);
            if (params.tags) {
                const status_tags = normalize_tags(params.tags);
                await get_sequelize().transaction(async (t) => {
                    await this._tag_repo.delete_by_team_id(team!.id, t);
                    for (const tag of status_tags) await this._tag_repo.create(team!.id, tag, t);
                });
            }
            if (params.description !== undefined || params.license !== undefined) {
                await this._team_repo.update(
                    team.id,
                    params.description ?? team.description,
                    params.license ?? team.license,
                    visibility,
                );
            }
            return {
                name: team.name,
                scope: team.scope,
                version: latest,
                status: 'published' as const,
                listed: true,
            };
        }

        if (!params.version && !params.bump) {
            throw new ApiError('invalid_params', 'Either version or bump (patch|minor|major) is required', 422);
        }
        if (params.version && !SEMVER_PATTERN.test(params.version)) {
            throw new ApiError('invalid_params', 'Version must be valid semver (e.g. 1.0.0)', 422);
        }

        let tags = params.tags ? normalize_tags(params.tags) : undefined;
        if (params.tags && params.tags.length > 20) throw new ApiError('invalid_params', 'Maximum 20 tags allowed', 422);

        const zip_buffer = Buffer.from(params.data_base64, 'base64');
        if (zip_buffer.length > 10 * 1024 * 1024) throw new ApiError('invalid_params', 'Package too large (max 10MB)', 422);

        const { team_yml, manifest_yaml, roles, readme } = await extract_package(zip_buffer);
        if (!team_yml) throw new ApiError('invalid_package', 'Package must contain a valid team.yml', 422);

        if (!tags && team_yml.tags) tags = normalize_tags(team_yml.tags);

        const description = params.description || team_yml.description || '';
        const license = params.license || 'MIT';
        const workflow = workflow_from_team_yml(team_yml);
        const workflow_json = JSON.stringify(workflow);

        /** Validate HUG gate phases have mandatory review.reviewers. */
        validate_hug_reviewer_groups(workflow);

        const enriched_inputs = enrich_required_inputs(team_yml.inputs, workflow);
        const capability_json = JSON.stringify({ inputs: enriched_inputs, use_when: team_yml.use_when, not_for: team_yml.not_for });
        const agents_json = JSON.stringify(params.agents || team_yml.agents || {});
        const cliq_version = team_yml.cliq_version || null;
        const tools = JSON.stringify(team_yml.tools || []);
        const sorted_roles = [...roles].sort((a, b) => a.name.localeCompare(b.name));
        const roles_json = JSON.stringify(sorted_roles.map((r) => ({ name: r.name, content_md: r.content_md })));

        let resolved_version = params.version;
        if (!resolved_version && params.bump) {
            const latest = team ? await this._version_repo.find_latest_version(team.id) : null;
            resolved_version = compute_next_version(latest, params.bump);
        }
        if (!resolved_version) throw new ApiError('invalid_params', 'Could not determine version', 422);

        if (team) {
            const existing_ver = await this._version_repo.find_by_team_and_version(team.id, resolved_version);
            if (existing_ver) throw new ApiError('conflict', `Version ${resolved_version} already exists`, 409);

            const current_max = await this._version_repo.find_latest_version(team.id);
            if (current_max && SemVer.compare(resolved_version, current_max) < 0) {
                throw new ApiError(
                    'invalid_params',
                    `Version ${resolved_version} is older than the current latest (${current_max}). Publish a version >= ${current_max}.`,
                    422,
                );
            }
        }

        const pkg_key = package_key(name, resolved_version);
        const pkg_path = this._packages_path ? package_path(this._packages_path, name, resolved_version) : pkg_key;
        if (this._storage) await this._storage.write(pkg_key, zip_buffer);

        await get_sequelize().transaction(async (t) => {
            let effective_team_id: string;

            if (team) {
                await this._team_repo.update(team.id, description, license, visibility, t);
                // Must use the same transaction: a second connection UPDATE on the
                // locked team row deadlocks until the statement timeout → 500.
                await this._team_repo.update_listed(team.id, 1, t);
                // The published package supersedes any unversioned working copy.
                if ((team as { draft_manifest?: string | null }).draft_manifest) await this._team_repo.clear_draft(team.id, t);
                effective_team_id = team.id;
            } else {
                const scope_record = scope ? auth.scopes.find((s) => s.slug === scope) : null;
                const scope_type = scope_record?.scope_type || null;
                effective_team_id = await this._team_repo.create(
                    name, scope, scope_type, description, auth.user!.id, license, visibility, t, 1,
                );
            }

            await this._version_repo.create(
                effective_team_id, resolved_version!, params.changelog || '', pkg_path,
                cliq_version, tools, workflow_json, manifest_yaml,
                readme, capability_json, agents_json, roles_json, t,
            );

            if (tags) {
                await this._tag_repo.delete_by_team_id(effective_team_id, t);
                for (const tag of tags) {
                    await this._tag_repo.create(effective_team_id, tag, t);
                }
            }
        });

        return {
            name,
            scope,
            version: resolved_version,
            status: 'published' as const,
            listed: true,
        };
    }

    async download(auth: AuthContext, params: { name: string; scope?: string; version?: string }) {
        log.debug('download', { name: params.name, scope: params.scope, version: params.version });
        const scope = params.scope || null;
        const team = await this._team_repo.find_by_name_and_scope(params.name, scope);
        if (!team || !can_view_team(auth, team)) throw new ApiError('not_found', 'Team not found', 404);

        const ver = params.version
            ? await this._version_repo.find_package_by_version(team.id, params.version)
            : await this._version_repo.find_latest_package(team.id);
        if (!ver) throw new ApiError('not_found', 'No versions published', 404);

        const pkg_key_val = package_key(params.name, ver.version);
        const data = this._storage ? await this._storage.read(pkg_key_val) : null;
        if (!data) throw new ApiError('internal', `Package archive missing for v${ver.version}. It may need to be republished.`, 500);

        if (this._download_log_repo) {
            const download_key = auth.user ? `user:${auth.user.id}` : `anon:${Date.now()}`;
            const today = new Date().toISOString().slice(0, 10);
            const already = await this._download_log_repo.find_by_team_key_date(team.id, download_key, today);
            if (!already) {
                await this._download_log_repo.create(team.id, download_key, today);
                await this._team_repo.update_install_count(team.id);
            }
        }

        return { filename: `${team.name}-${ver.version}.zip`, data_base64: data.toString('base64'), version: ver.version };
    }

    async delete_team(auth: AuthContext, params: { name?: string; scope?: string; team_id?: string }) {
        log.debug('delete_team', { team_id: params.team_id, name: params.name, scope: params.scope });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');

        let team;
        if (params.team_id && auth.user.role === 'admin') {
            team = await this._team_repo.find_by_id(params.team_id);
            if (!team) throw new ApiError('not_found', 'Team not found', 404);
        }
        if (!team) {
            if (!params.name) throw new ApiError('invalid_params', 'name is required', 422);
            const scope = params.scope || null;
            team = await this._team_repo.find_by_name_and_scope(params.name, scope);
            if (!team) throw new ApiError('not_found', 'Team not found', 404);
            if (team.author_id !== auth.user.id && auth.user.role !== 'admin') {
                throw new ApiError('forbidden', 'You are not the author of this team', 403);
            }
        }

        const versions = await this._version_repo.list_packages_by_team(team.id);
        await get_sequelize().transaction(async (t) => {
            await this._team_repo.delete_by_id(team.id, t);
        });

        if (this._storage) {
            for (const v of versions) {
                const key = v.package_path.split('/').pop() || v.package_path;
                await this._storage.delete(key);
            }
        }

        // Cascade: remove from all realm team_lists and purge from cliq.teams
        await RealmTeamListService.remove_from_all_realms(
            team.scope || '',
            team.name,
        ).catch(() => { /* best-effort cascade */ });

        if (auth.user.role === 'admin' && team.author_id !== auth.user.id && this._audit_repo) {
            await this._audit_repo.create(auth.user.id, 'team.force_delete', 'team', team.id, {
                name: team.name, scope: team.scope, author_id: team.author_id,
            });
        }

        return { deleted: true };
    }

    async delete_version(auth: AuthContext, params: { name: string; scope?: string; version: string }) {
        log.debug('delete_version', { name: params.name, scope: params.scope, version: params.version });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');
        const scope = params.scope || null;
        const team = await this._team_repo.find_by_name_and_scope(params.name, scope);
        if (!team) throw new ApiError('not_found', 'Team not found', 404);
        if (team.author_id !== auth.user.id && auth.user.role !== 'admin') throw new ApiError('forbidden', 'You are not the author of this team', 403);

        const ver = await this._version_repo.find_id_and_package(team.id, params.version);
        if (!ver) throw new ApiError('not_found', `Version ${params.version} not found`, 404);

        await this._version_repo.delete_by_id(ver.id);
        if (this._storage && ver.package_path) {
            const key = ver.package_path.split('/').pop() || ver.package_path;
            await this._storage.delete(key);
        }
        return { deleted: true, version: params.version };
    }

    async rename_team(auth: AuthContext, params: { name: string; scope: string; new_name: string }) {
        log.debug('rename_team', { name: params.name, scope: params.scope, new_name: params.new_name });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');
        const new_name = (params.new_name || '').trim().toLowerCase();
        if (!new_name || !SLUG_PATTERN.test(new_name)) throw new ApiError('invalid_params', 'Name must be lowercase alphanumeric with hyphens (e.g. my-team)', 422);
        if (new_name === params.name) throw new ApiError('invalid_params', 'New name is the same as the current name', 422);

        const team = await this._team_repo.find_by_name_and_scope(params.name, params.scope);
        if (!team) throw new ApiError('not_found', 'Team not found', 404);
        if (team.author_id !== auth.user.id && auth.user.role !== 'admin') throw new ApiError('forbidden', 'You are not the author of this team', 403);

        const existing = await this._team_repo.find_by_name_and_scope(new_name, params.scope);
        if (existing) throw new ApiError('conflict', `Team @${params.scope}/${new_name} already exists`, 409);

        await this._team_repo.update_name(team.id, new_name);
        return { name: new_name, scope: params.scope };
    }

    // ─── Private helpers ────────────────────────────────────────────

    /**
     * The team version a new team is forked from: the caller must be able to
     * read the team, and the version must exist (latest when not given).
     *
     * @throws ApiError 404 when the team or version is not found; 409 when the team has no version yet.
     */
    private async _fork_origin(auth: AuthContext, ref: { team_id: string; version?: string }): Promise<{
        team_id: string; version: string; manifest_yaml: string; description: string;
    }> {
        const source = await this._team_repo.find_by_id(ref.team_id);
        if (!source || !can_read_team(auth, source)) throw new ApiError('not_found', 'Team to fork not found', 404);
        const version = ref.version ?? await this._version_repo.find_latest_version(source.id);
        if (!version) throw new ApiError('conflict', `@${source.scope}/${source.name} has no version to fork yet`, 409);
        const detail = await this._version_repo.find_detail_by_team_and_version(source.id, version);
        const manifest_yaml = (detail as { manifest_yaml?: string | null } | null)?.manifest_yaml;
        if (!detail || !manifest_yaml) throw new ApiError('not_found', `Version ${version} not found`, 404);
        return { team_id: source.id, version, manifest_yaml, description: source.description };
    }

    /**
     * Where `team` was forked from, for its detail: the origin team (null name
     * and scope when it was deleted or the caller cannot see it), the version
     * the fork started from, and the origin's latest version when visible.
     */
    private async _fork_summary(auth: AuthContext, team: { forked_from_team_id?: string | null; forked_from_version?: string | null }) {
        if (!team.forked_from_team_id) return null;
        const origin = await this._team_repo.find_by_id(team.forked_from_team_id);
        const visible = Boolean(origin && can_read_team(auth, origin));
        return {
            team_id: team.forked_from_team_id,
            scope: visible ? origin!.scope : null,
            name: visible ? origin!.name : null,
            version: team.forked_from_version ?? null,
            latest_version: visible ? await this._version_repo.find_latest_version(origin!.id) : null,
        };
    }

    private async _resolve_team_for_write(
        auth: AuthContext,
        params: { name?: string; scope?: string; team_id?: string },
    ) {
        let team;
        if (params.team_id) {
            team = await this._team_repo.find_by_id(params.team_id);
            if (!team) throw new ApiError('not_found', 'Team not found', 404);
            if (team.author_id !== auth.user!.id && auth.user!.role !== 'admin') {
                throw new ApiError('forbidden', 'You are not the author of this team', 403);
            }
            return team;
        }
        if (!params.name) throw new ApiError('invalid_params', 'name is required', 422);
        const scope = params.scope || null;
        team = await this._team_repo.find_by_name_and_scope(params.name, scope);
        if (!team) throw new ApiError('not_found', 'Team not found', 404);
        if (team.author_id !== auth.user!.id && auth.user!.role !== 'admin') {
            throw new ApiError('forbidden', 'You are not the author of this team', 403);
        }
        return team;
    }

    /** Seed a draft version row from raw manifest YAML/JSON (no zip package). */
    private async _seed_version_from_manifest(
        team_id: string,
        version: string,
        manifest_yaml: string,
        description: string,
        transaction?: import('sequelize').Transaction,
    ): Promise<void> {
        const team_yml = parse_manifest_yaml(manifest_yaml);
        const workflow = workflow_from_team_yml(team_yml);
        const workflow_json = JSON.stringify(workflow);
        const enriched_inputs = enrich_required_inputs(team_yml?.inputs, workflow);
        const capability_json = JSON.stringify({
            inputs: enriched_inputs,
            use_when: team_yml?.use_when,
            not_for: team_yml?.not_for,
        });
        const agents_json = JSON.stringify(team_yml?.agents || {});
        const tools = JSON.stringify(team_yml?.tools || []);
        const roles_json = '[]';
        const pkg_path = `draft://${team_id}/${version}`;

        await this._version_repo.create(
            team_id, version, description || '', pkg_path,
            team_yml?.cliq_version || null, tools, workflow_json, manifest_yaml,
            '', capability_json, agents_json, roles_json, transaction,
        );
    }

    /**
     * Compute the caller's permissions for a team.
     *
     * Permission hierarchy:
     *   - Site admin → full access
     *   - Org admin (scope owned by an org the user admins) → full access
     *   - Author (user authored the team) → edit + toggle listing
     *   - Everyone else → read only
     */
    private async _resolve_team_permissions(
        auth: AuthContext,
        team: { author_id: string | null; scope: string | null },
    ): Promise<{ can_edit: boolean; can_delete: boolean; can_toggle_listing: boolean }> {
        if (!auth.user) {
            return { can_edit: false, can_delete: false, can_toggle_listing: false };
        }

        const is_site_admin = auth.user.role === 'admin';
        if (is_site_admin) {
            return { can_edit: true, can_delete: true, can_toggle_listing: true };
        }

        const is_author = team.author_id != null && auth.user.id === team.author_id;

        // Check if the user is an admin of the org that owns this scope.
        let is_org_admin = false;
        if (team.scope) {
            const scope_row = await _scope_repo_ts.find_one_q({ where: { slug: team.scope }, attributes: ['org_id'], raw: true });
            if (scope_row?.org_id) {
                const membership = await _org_member_repo_ts.find_one_q({ where: { org_id: scope_row.org_id, user_id: auth.user.id, status: 'active', deleted_at: null }, attributes: ['role'],
                    raw: true,
                });
                if (membership?.role === 'admin' || membership?.role === 'owner') {
                    is_org_admin = true;
                }
            }
        }

        if (is_org_admin) {
            return { can_edit: true, can_delete: true, can_toggle_listing: true };
        }

        if (is_author) {
            return { can_edit: true, can_delete: false, can_toggle_listing: true };
        }

        return { can_edit: false, can_delete: false, can_toggle_listing: false };
    }

    /**
     * Marketplace details for a page of catalog teams: the latest version's
     * phases, version count, last update, fork count and whether the
     * publisher scope is verified (a platform scope). One query per kind of
     * detail, not per team.
     */
    async catalog_details(rows: Array<{ id: string; latest_version: string | null; scope: string | null }>): Promise<Map<string, {
        phases: Array<{ name: string; type: string | null; agent: string | null }>;
        version_count: number; updated_at?: number; fork_count: number; verified: boolean;
    }>> {
        const out = new Map<string, { phases: Array<{ name: string; type: string | null; agent: string | null }>; version_count: number; updated_at?: number; fork_count: number; verified: boolean }>();
        const ids = rows.map((r) => r.id).filter(Boolean);
        if (ids.length === 0) return out;
        const sequelize = get_sequelize();
        const [versions, teams, forks, platform] = await Promise.all([
            sequelize.query<{ team_id: string; version: string; workflow_json: string | null }>(
                'SELECT "team_id", "version", "workflow_json" FROM cliq."team_versions" WHERE "team_id" IN (:ids)',
                { replacements: { ids }, type: QueryTypes.SELECT },
            ),
            sequelize.query<{ id: string; updated_at: Date | string | null }>(
                'SELECT "id", "updated_at" FROM cliq."teams" WHERE "id" IN (:ids)',
                { replacements: { ids }, type: QueryTypes.SELECT },
            ),
            sequelize.query<{ forked_from_team_id: string; n: string }>(
                'SELECT "forked_from_team_id", COUNT(*) AS n FROM cliq."teams" WHERE "forked_from_team_id" IN (:ids) GROUP BY 1',
                { replacements: { ids }, type: QueryTypes.SELECT },
            ),
            sequelize.query<{ slug: string }>(
                `SELECT "slug" FROM cliq."scopes" WHERE "scope_type" = 'platform'`,
                { type: QueryTypes.SELECT },
            ),
        ]);
        const verified_scopes = new Set(platform.map((p) => p.slug));
        const updated = new Map(teams.map((t) => [String(t.id), t.updated_at ? new Date(t.updated_at).getTime() : undefined]));
        const fork_counts = new Map(forks.map((f) => [String(f.forked_from_team_id), Number(f.n)]));
        for (const row of rows) {
            const mine = versions.filter((v) => String(v.team_id) === row.id);
            const latest = mine.find((v) => v.version === row.latest_version);
            let phases: Array<{ name: string; type: string | null; agent: string | null }> = [];
            try {
                const wf = JSON.parse(latest?.workflow_json ?? '{}') as { phases?: Array<Record<string, unknown>> };
                phases = (wf.phases ?? []).map((p) => ({
                    name: String(p.name ?? ''),
                    type: typeof p.type === 'string' ? p.type : null,
                    agent: typeof p.agent === 'string' ? p.agent : null,
                }));
            } catch { /* no workflow: no phases */ }
            out.set(row.id, {
                phases,
                version_count: mine.length,
                ...(updated.get(row.id) !== undefined ? { updated_at: updated.get(row.id) } : {}),
                fork_count: fork_counts.get(row.id) ?? 0,
                verified: Boolean(row.scope && verified_scopes.has(row.scope)),
            });
        }
        return out;
    }

    private async _build_tag_map(rows: TeamListItemVO[]): Promise<Map<string, string[]>> {
        const ids = rows.map((r) => r.id);
        if (ids.length === 0) return new Map();
        const tag_rows = await this._tag_repo.find_by_team_ids(ids);
        const map = new Map<string, string[]>();
        for (const row of tag_rows) {
            const list = map.get(row.team_id) || [];
            list.push(row.tag);
            map.set(row.team_id, list);
        }
        return map;
    }
}

// ── Publish-time validation ─────────────────────────────────────────

/**
 * Validate that HUG gate phases have well-formed `review.reviewers`.
 *
 * Rules:
 * - `agent: hug` phases MUST have `review.reviewers` with ≥1 group.
 * - Each group MUST have `policy` ('any' or 'all') and non-empty `channels`.
 *
 * @throws ApiError (422) on validation failure.
 */
function validate_hug_reviewer_groups(workflow: NormalizedWorkflow): void {
    const all_phases = [
        ...(workflow.phases ?? []),
        ...(workflow.support ?? []),
    ] as Array<{
        name?: string;
        type?: string;
        agent?: string;
        review?: {
            reviewers?: Array<{ policy?: string; channels?: string[] }>;
            [k: string]: unknown;
        };
    }>;

    for (const phase of all_phases) {
        if (phase.agent !== 'hug') continue;

        const phase_label = phase.name ? `'${phase.name}'` : 'unnamed';
        const reviewers = phase.review?.reviewers;

        if (!Array.isArray(reviewers) || reviewers.length === 0) {
            throw new ApiError(
                'invalid_package',
                `HUG gate phase ${phase_label} must declare review.reviewers with at least one group`,
                422,
            );
        }

        for (let i = 0; i < reviewers.length; i++) {
            const group = reviewers[i];

            if (group.policy !== 'any' && group.policy !== 'all') {
                throw new ApiError(
                    'invalid_package',
                    `HUG gate phase ${phase_label}, reviewer group ${i}: policy must be 'any' or 'all'`,
                    422,
                );
            }

            if (!Array.isArray(group.channels) || group.channels.length === 0) {
                throw new ApiError(
                    'invalid_package',
                    `HUG gate phase ${phase_label}, reviewer group ${i}: channels must be a non-empty array`,
                    422,
                );
            }
        }
    }
}
