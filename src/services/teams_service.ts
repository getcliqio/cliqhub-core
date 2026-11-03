import { ApiError } from '../errors/api_error.js';
import { can_read_team, can_view_team } from '../auth/access.js';
import { assert_access, assert_admin_access } from '../auth/assert_grant.js';
import { require_permission } from '../auth/permissions.js';

import yaml from 'js-yaml';
import { dependencies_problems, derive_version_content, normalize_tags, parse_team_yml_text } from './package_parser.js';
import type { ParsedTeamYml } from './package_parser.js';
import { SemVer } from '../lib/semver.js';
import { SLUG_PATTERN } from '../config/env.js';
import type { TeamRepository } from '../repositories/team_repository.js';
import type { TeamVersionRepository } from '../repositories/team_version_repository.js';
import type { TagRepository } from '../repositories/tag_repository.js';
import type { DownloadLogRepository } from '../repositories/download_log_repository.js';
import type { ScopeRepository } from '../repositories/scope_repository.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { PackageStorage } from '../storage/package_storage.js';
import { stored_key, version_zip_key } from '../storage/package_storage.js';
import { TeamFileRepository } from '../repositories/team_file_repository.js';
import { read_team_files, write_team_file_objects } from './team_file_objects.js';
import { latest_version_content, version_content, version_contents } from './version_content.js';
import type { AuthContext } from '../schemas/auth_types.js';
import type { TeamCatalogSortKey, TeamListItemVO, TeamRoleVO } from '../schemas/team_types.js';
import { Op, QueryTypes, col, fn, literal, type WhereOptions } from 'sequelize';
import { list_order, type SortColumns, type SortDir } from '../lib/list_sort.js';
import type { NormalizedWorkflow } from './package_parser.js';
import { RealmTeamListService } from '../services/realm_team_list.service.js';
import { get_sequelize } from '../lib/sequelize.js';
import { ScopeRepository as ScopeRepoClass } from '../repositories/scope_repository.js';

import { get_logger } from '../lib/log.js';
import { escape_like } from '../lib/search.js';
import { is_bundle_path, lint_team, MAX_BUNDLE_FILES, MAX_BUNDLE_UNPACKED, pack_bundle, set_identity, TEAM_YML, TeamIdentityError, unknown_paths, type AgentInputs, type TeamInputDef } from '@getcliqio/cliq-sdk';
import { AgentCatalog } from '../models/agent_catalog.model.js';
import { Team } from '../models/team.model.js';
import { TeamVersionRepository as TeamVersionRepoClass } from '../repositories/team_version_repository.js';

const log = get_logger('svc.teams');

const _scope_repo_ts = new ScopeRepoClass();

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


/**
 * Refuse a team whose phases carry lines cliq would silently ignore (cliq-sdk `lint_team`, shared with cliqd): a line
 * that's neither a phase field nor an input its agent declares, a required agent input missing, or
 * a field a team input doesn't have, or a `type: team` phase whose `args` miss an input its sub-team
 * requires (PLAN-hug-requests §14). Agent inputs come from the agent catalog (built-in and custom);
 * sub-team inputs from the catalog's latest version of each sub-team.
 *
 * @throws ApiError 422 `invalid_team` with `details.problems` (phase, line, message) when there are any.
 */
export async function assert_team_lints(team_yml: ParsedTeamYml | Record<string, unknown> | null, role_files: Array<{ name: string }> = []): Promise<void> {
    if (!team_yml) return;
    const team = team_yml as Record<string, unknown>;
    const names = new Set<string>();
    for (const p of [...(Array.isArray(team['phases']) ? team['phases'] : []), ...(Array.isArray(team['support']) ? team['support'] : [])]) {
        const agent = (p as Record<string, unknown> | null)?.['agent'];
        if (typeof agent === 'string' && agent) names.add(agent);
    }
    const agents = new Map<string, AgentInputs>();
    if (names.size) {
        const rows = await AgentCatalog.findAll({ where: { name: { [Op.in]: [...names] }, deleted: false }, attributes: ['name', 'org_id', 'version', 'manifest'], raw: true });
        // The catalog keeps a row per version: only the newest of each (name, org) counts, so an input an
        // older version required (hug 1.0.0's `role`) doesn't outlive it.
        const newest = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
            const key = `${row.name}\u0000${row.org_id ?? ''}`;
            const seen = newest.get(key);
            if (!seen || SemVer.compare(row.version ?? '', seen.version ?? '') > 0) newest.set(key, row);
        }
        // A name can exist as a built-in and as custom agents in several orgs: any of them accepting a line is enough.
        for (const row of newest.values()) {
            const inputs = ((row.manifest ?? {}) as { inputs?: AgentInputs }).inputs ?? {};
            agents.set(row.name, { ...(agents.get(row.name) ?? {}), ...inputs });
        }
    }
    // roles/<phase>.md is that phase's role brief.
    const briefs = new Set(role_files.map((r) => r.name.replace(/^.*\//, '').replace(/\.md$/, '')));
    const problems = lint_team(team, agents, briefs, await sub_team_inputs(team));
    if (!problems.length) return;
    throw new ApiError('invalid_team', `This team has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.map((p) => p.message).join('; ')}`, 422, { problems });
}

/**
 * The declared inputs of the catalog teams this team's `type: team` phases run (latest version), by
 * ref (`@scope/slug`). A sub-team not in the catalog is left out (not checked here).
 */
async function sub_team_inputs(team: Record<string, unknown>): Promise<Map<string, TeamInputDef[]>> {
    const out = new Map<string, TeamInputDef[]>();
    for (const p of Array.isArray(team['phases']) ? team['phases'] : []) {
        const phase = p as { type?: unknown; team?: unknown } | null;
        if (phase?.type !== 'team' || typeof phase.team !== 'string' || out.has(phase.team)) continue;
        const ref = /^@?([^/\s@]+)\/([^/\s@]+)$/.exec(phase.team);
        if (!ref) continue;
        const row = await Team.findOne({ where: { scope: ref[1], name: ref[2] }, attributes: ['id'], raw: true });
        const content = row ? await latest_version_content(row.id) : null;
        const manifest = content?.team_yml as { inputs?: unknown } | null | undefined;
        if (!manifest) continue;
        const decls = (Array.isArray(manifest.inputs) ? manifest.inputs : [])
            .filter((i): i is { name: string; required?: boolean; default?: unknown } => !!i && typeof (i as { name?: unknown }).name === 'string')
            .map((i) => ({ name: i.name, required: i.required, default: i.default }));
        out.set(phase.team, decls);
    }
    return out;
}

/**
 * Check a team's files before anything is stored: team files only, at most 10 MB, a team.yml that parses,
 * a valid dependencies.yml, and the lint. Returns what the version row is filled from.
 *
 * @throws ApiError 422 `invalid_package` / `invalid_team`.
 */
async function check_team_files(files: Record<string, string>) {
    const total = Object.values(files).reduce((n, text) => n + Buffer.byteLength(text, 'utf8'), 0);
    if (total > MAX_BUNDLE_UNPACKED) throw new ApiError('invalid_package', `Team files total more than ${MAX_BUNDLE_UNPACKED / 1024 / 1024} MB`, 422);
    const unknown = unknown_paths({ files });
    if (unknown.length) throw new ApiError('invalid_package', `Not part of a team: ${unknown.join(', ')} (team.yml, roles/<name>.md, dependencies.yml, README.md)`, 422, { paths: unknown });
    // A team is text: a NUL character means binary content sent as a string.
    const binary = Object.keys(files).filter((p) => files[p].includes('\u0000')).sort();
    if (binary.length) throw new ApiError('invalid_package', `Not text: ${binary.join(', ')} (a team's files are UTF-8 text)`, 422, { paths: binary });
    const manifest_yaml = files[TEAM_YML] ?? '';
    const team_yml = manifest_yaml ? parse_team_yml_text(manifest_yaml) : null;
    if (!team_yml) throw new ApiError('invalid_package', 'Package must contain a valid team.yml', 422);
    // Role briefs are the .md files directly in roles/ (a nested folder is not a role).
    const roles = Object.keys(files)
        .filter((p) => p.startsWith('roles/') && p.endsWith('.md') && !p.slice('roles/'.length).includes('/'))
        .sort()
        .map((p) => ({ name: p.slice('roles/'.length, -'.md'.length), content_md: files[p] }));
    const dependencies_yml = files['dependencies.yml'] ?? '';
    const dep_problems = dependencies_problems(dependencies_yml);
    if (dep_problems.length) throw new ApiError('invalid_package', dep_problems.join('; '), 422, { field: 'dependencies.yml', problems: dep_problems });
    await assert_team_lints(team_yml, roles);
    return { team_yml, manifest_yaml, roles, readme: files['README.md'] ?? '', dependencies_yml };
}

function build_visibility_where(auth: AuthContext): WhereOptions {
    if (!auth.user) {
        return { visibility: 'public', listed: 1 };
    }
    // Private teams: the scopes the caller is a member of (PLAN-team-visibility §3.2).
    const scope_slugs = auth.member_scopes.map((s) => s.slug);
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
        private _file_repo: TeamFileRepository = new TeamFileRepository(),
    ) {}

    // ─── Team files (PLAN-team-bundle §2.2 / §2.6) ───

    /**
     * Upload files into a draft version: into the draft named by `version_id`, or a new draft when none is
     * named. Each file gets an id, its bytes go to `teams/<team_id>/files/<file_id>` (never overwritten), and
     * all the rows are written in one transaction, replacing paths the draft already has.
     *
     * A new draft can name the published version it starts from (`based_on_version_id`, PLAN-team-bundle S3).
     *
     * @throws ApiError 422 for a path that isn't a team path, a path twice, or a draft over 10 MB / 1000 files;
     *   404 for a draft that isn't this team's open draft, or a `based_on_version_id` that isn't one of its versions.
     */
    async upload_files(auth: AuthContext, params: {
        team_id: string; version_id?: string; based_on_version_id?: string;
        files: Array<{ path: string; content_type: string; data: Buffer }>;
    }): Promise<{ version_id: string; files: Array<{ id: string; path: string; size: number; sha256: string }> }> {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');
        const team = await this._resolve_team_for_write(auth, { team_id: params.team_id });
        if (params.files.length === 0) throw new ApiError('invalid_params', 'No files to upload', 422);
        const paths = params.files.map((f) => f.path);
        const not_team = paths.filter((p) => !is_bundle_path(p));
        if (not_team.length) throw new ApiError('invalid_package', `Not part of a team: ${not_team.join(', ')} (team.yml, roles/<name>.md, dependencies.yml, README.md)`, 422, { paths: not_team });
        const twice = paths.filter((p, i) => paths.indexOf(p) !== i);
        if (twice.length) throw new ApiError('invalid_params', `Sent twice: ${[...new Set(twice)].join(', ')}`, 422, { paths: twice });

        if (params.version_id) {
            const draft = await this._version_repo.find_draft(params.version_id);
            if (!draft || draft.team_id !== team.id) throw new ApiError('not_found', 'Draft not found (a published version can\'t change)', 404);
        } else if (params.based_on_version_id) {
            const base = await this._version_repo.find_by_id(params.based_on_version_id);
            if (!base || base.team_id !== team.id) throw new ApiError('not_found', `Version ${params.based_on_version_id} isn't one of this team's versions`, 404);
        }
        const out = await this._store_files(team.id, params.version_id, params.files, params.version_id ? undefined : params.based_on_version_id);
        log.info('team_files_uploaded', { team_id: team.id, version_id: out.version_id, files: out.files.length });
        return out;
    }

    /**
     * Store files into a draft (a new one when `draft_id` is absent): the draft stays within 10 MB / 1000 files,
     * each file gets an id and its bytes go to storage first, then all rows are written in one transaction,
     * replacing paths the draft has, and the draft is marked saved.
     */
    private async _store_files(team_id: string, draft_id: string | undefined, files: Array<{ path: string; content_type: string; data: Buffer }>, based_on_version_id?: string) {
        const paths = files.map((f) => f.path);
        const kept = draft_id ? (await this._file_repo.list_by_version(draft_id)).filter((r) => !paths.includes(r.path)) : [];
        const total = kept.reduce((n, r) => n + r.size, 0) + files.reduce((n, f) => n + f.data.length, 0);
        if (total > MAX_BUNDLE_UNPACKED) throw new ApiError('invalid_package', `A team's files total more than ${MAX_BUNDLE_UNPACKED / 1024 / 1024} MB`, 422);
        if (kept.length + files.length > MAX_BUNDLE_FILES) throw new ApiError('invalid_package', `A team has more than ${MAX_BUNDLE_FILES} files`, 422);
        if (!this._storage) throw new ApiError('internal', 'No storage configured', 500);

        const rows = await write_team_file_objects(this._storage, team_id, files);
        let version_id = draft_id;
        await get_sequelize().transaction(async (t) => {
            if (!version_id) version_id = await this._version_repo.create_draft(team_id, t, based_on_version_id);
            for (const r of rows) r.version_id = version_id;
            if (rows.length) await this._file_repo.replace_paths(version_id, rows, t);
            await this._version_repo.touch_draft(version_id, t);
        });
        return { version_id: version_id!, files: rows.map((r) => ({ id: r.id, path: r.path, size: r.size, sha256: r.sha256 })) };
    }

    /** Take paths out of a draft (their bytes stay for the cleanup). */
    async remove_files(auth: AuthContext, params: { team_id: string; version_id: string; paths: string[] }): Promise<{ removed: number }> {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');
        const team = await this._resolve_team_for_write(auth, { team_id: params.team_id });
        const draft = await this._version_repo.find_draft(params.version_id);
        if (!draft || draft.team_id !== team.id) throw new ApiError('not_found', 'Draft not found (a published version can\'t change)', 404);
        const removed = await this._file_repo.delete_paths(params.version_id, params.paths);
        await this._version_repo.touch_draft(params.version_id);
        return { removed };
    }

    /**
     * A version's files (path, size, sha256, id). A published version: anyone who can see the team; a draft:
     * only someone who can edit it.
     */
    async get_files(auth: AuthContext, params: { team_id: string; version_id: string; content?: boolean }) {
        const team = await this._team_repo.find_by_id(params.team_id);
        if (!team || !can_view_team(auth, team)) throw new ApiError('not_found', 'Team not found', 404);
        const draft = await this._version_repo.find_draft(params.version_id);
        if (draft) {
            if (draft.team_id !== team.id) throw new ApiError('not_found', 'Version not found', 404);
            await this._resolve_team_for_write(auth, { team_id: team.id });
        } else {
            const published = await this._version_repo.find_package_by_id(params.version_id);
            if (!published || published.team_id !== team.id) throw new ApiError('not_found', 'Version not found', 404);
        }
        const rows = await this._file_repo.list_by_version(params.version_id);
        // With content: each file's text, checked against its sha256 (the builder rebuilds its canvas from these).
        const texts = params.content ? await this._read_version_files(params.version_id) : null;
        return {
            version_id: params.version_id,
            files: rows.map((r) => ({
                id: r.id, path: r.path, size: r.size, sha256: r.sha256, content_type: r.content_type,
                ...(texts ? { content: texts[r.path] } : {}),
            })),
        };
    }

    // ─── Unified list (replaces list, search, list_mine, list_all_mine, admin_list_teams) ───

    async get(auth: AuthContext, params: {
        query?: string; tag?: string; scope?: string;
        mine?: boolean; listed?: boolean;
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

    /**
     * "Mine" (PLAN-team-visibility §3.2): the published teams of my orgs' scopes and of the scopes I'm a
     * member of, each one I can see (public, or private in a scope I'm a member of), plus my drafts.
     * With `scope`, that one scope's teams I can see (a scope's page), plus my drafts there.
     */
    private async _get_mine(auth: AuthContext, params: {
        scope?: string; query?: string;
        tag?: string; limit?: number; offset?: number;
        status?: 'draft' | 'published';
    }) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);

        const members = new Set(auth.member_scopes.map((s) => s.slug));
        let scope_slugs: string[];
        if (params.scope) {
            scope_slugs = [params.scope];
        } else {
            const org_scopes = auth.org_ids.length > 0 ? await _scope_repo_ts.find_by_org_ids(auth.org_ids) : [];
            scope_slugs = [...new Set([...org_scopes.map((s) => s.slug), ...members])];
        }
        // Drafts come only from the author query below, so others' drafts never show.
        let rows = (await this._team_repo.list_by_scope_list(scope_slugs))
            .filter((t: any) => t.visibility === 'public' || (t.visibility === 'private' && members.has(t.scope)));
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
                if (!seen.has(d.id) && (!params.scope || d.scope === params.scope)) rows.push(d as any);
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
            conditions.push(literal(`EXISTS (SELECT 1 FROM daemon_teams dt JOIN scopes s ON s.id::text = dt.scope_id::text JOIN realm_members rm ON rm.member_id::text = dt.daemon_id::text AND rm.member_type = 'daemon' WHERE rm.realm_id::text = ${esc(params.installed_realm_id)} AND dt.uninstalled_at IS NULL AND dt.slug = "Team"."name" AND s.slug = "Team"."scope")`) as any);
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

        // What the version's files say (PLAN-team-bundle S1.4b).
        const ver_row = target_version ? await this._version_repo.find_by_team_and_version(team.id, target_version) : null;
        const content = ver_row ? await version_content(ver_row.id) : null;
        const roles: TeamRoleVO[] = content?.roles ?? [];

        // Compute caller permissions for this team.
        const permissions = await this._resolve_team_permissions(auth, team);
        const forked_from = await this._fork_summary(auth, team);
        const fork_count = await this._team_repo.count_forks(team.id);
        // Only people who can edit the team see its open draft (the builder reopens it from its files).
        const open_draft = permissions.can_edit ? await this._version_repo.find_open_draft(team.id) : null;
        const based_on = open_draft?.based_on_version_id ? await this._version_repo.find_by_id(open_draft.based_on_version_id) : null;
        const draft = open_draft ? {
            version_id: open_draft.id, saved_at: open_draft.saved_at,
            // The published version it started from ("Draft · based on 1.2.0"), when it did.
            based_on: based_on ? { version_id: based_on.id, version: based_on.version } : null,
        } : null;

        const raw_manifest = content?.manifest_yaml || null;

        return {
            id: team.id,
            name: team.name, scope: team.scope, description: team.description,
            license: team.license, visibility: team.visibility,
            status: team_status(team.visibility),
            author, author_id: team.author_id ?? null,
            latest_version: latest_ver?.version || '0.0.0',
            install_count: team.install_count, tags: tags.map((t) => t.tag),
            created_at: team.created_at, updated_at: team.updated_at,
            /** The version shown (its files: `teams/files/get`); null when the team has none. */
            version_id: ver_row?.id ?? null,
            versions, roles,
            workflow: content?.workflow ?? { phases: [] },
            agents: content?.agents ?? {},
            readme: content?.readme ?? '', cliq_version: content?.cliq_version ?? null, tools: content?.tools ?? [],
            inputs: content?.inputs, use_when: content?.use_when, not_for: content?.not_for,
            listed: team.listed !== 0,
            raw_manifest,
            /** dependencies.yml of this version ('' when the team has none). */
            dependencies: content?.dependencies_yml ?? '',
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

        let version_row: { id: string; version: string } | null = null;
        if (params.version_id) {
            const row = await this._version_repo.find_by_id(params.version_id);
            if (!row || row.team_id !== params.team_id) {
                throw new ApiError('not_found', 'Team version not found', 404);
            }
            version_row = { id: row.id, version: row.version };
        } else {
            version_row = await this._version_repo.find_latest_ref(params.team_id);
            if (!version_row) {
                return {
                    team_id: params.team_id,
                    version_id: null,
                    version: null,
                    phases: [] as Array<Record<string, unknown>>,
                };
            }
        }
        // The version's team.yml phases (PLAN-team-bundle S1.4b).
        const phases: unknown[] = (await version_content(version_row.id))?.workflow.phases ?? [];

        return {
            team_id: params.team_id,
            version_id: version_row.id,
            version: version_row.version,
            phases,
        };
    }

    // ─── Write methods ──────────────────────────────────────────────

    /**
     * Create a team (`visibility: draft`, `listed: 0`) with its first draft (PLAN-team-bundle §2.6): seeded with a
     * `team.yml` (its name, description, no phases) and a `README.md`; a fork's draft starts from the origin
     * version's files, with `team.yml` named for the fork.
     */
    async create(auth: AuthContext, params: {
        name: string; scope: string; description?: string;
        forked_from?: { team_id: string; version?: string };
        /** The visibility the new team is meant for; a fork of a private team checks it here (and again at publish). */
        visibility?: 'public' | 'private';
    }) {
        log.debug('create', { name: params.name, scope: params.scope });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');
        if (!SLUG_PATTERN.test(params.name)) {
            throw new ApiError('invalid_params', 'Team name must be lowercase letters, numbers, and hyphens, starting with a letter', 422);
        }
        await this._assert_can_publish(auth, params.scope);

        const existing = await this._team_repo.find_by_name_and_scope(params.name, params.scope);
        if (existing) throw new ApiError('conflict', `Team @${params.scope}/${params.name} already exists`, 409);

        const origin = params.forked_from ? await this._fork_origin(auth, params.forked_from) : null;
        if (origin) await this._assert_fork_visibility(auth, origin.team_id, params.visibility ?? 'private');
        const description = params.description || origin?.description || '';
        const label = `@${params.scope}/${params.name}`;
        const seed: Record<string, string> = origin
            ? { ...origin.files, [TEAM_YML]: with_manifest_name(origin.files[TEAM_YML] ?? '', JSON.stringify(label)) }
            : { [TEAM_YML]: `name: ${JSON.stringify(label)}\ndescription: ${JSON.stringify(description)}\nphases: []\n`, 'README.md': `# ${label}\n\n${description}\n` };

        let team_id = '';
        await get_sequelize().transaction(async (t) => {
            team_id = await this._team_repo.create(params.name, params.scope, description, auth.user!.id, 'MIT', 'draft', t, 0);
            if (origin) await this._team_repo.set_fork_origin(team_id, origin.team_id, origin.version, t);
        });
        const draft = await this._store_files(team_id, undefined, Object.entries(seed).map(([path, text]) => ({
            path, content_type: path.endsWith('.md') ? 'text/markdown' : 'text/yaml', data: Buffer.from(text, 'utf8'),
        })));

        log.info('team_created', { team_id, name: params.name, scope: params.scope, version_id: draft.version_id, forked_from: origin ? `${origin.team_id}@${origin.version}` : null });
        return { id: team_id, name: params.name, scope: params.scope, status: 'draft' as const, version: null, version_id: draft.version_id };
    }

    /**
     * The origin version's files for a fork: its `team_files` (read and checked), or — for a version published before
     * team_files (S1.5 gives those rows) — its stored team.yml and role briefs.
     */
    /**
     * A team's settings (its description), or `save_as: 'discard'` with a `version_id`: delete that draft and its
     * files' rows. Files change only through `teams/files/upload` / `remove`, and a draft becomes a version only
     * through `teams/publish` (PLAN-team-bundle §2.6).
     */
    async update(auth: AuthContext, params: {
        name?: string; scope?: string; team_id?: string;
        description?: string;
        save_as?: 'discard';
        version_id?: string;
    }) {
        log.debug('update', { team_id: params.team_id, name: params.name, scope: params.scope });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');

        const team = await this._resolve_team_for_write(auth, params);
        if (params.save_as === 'discard') {
            if (!params.version_id) throw new ApiError('invalid_params', 'version_id (the draft to discard) is required', 422, { field: 'version_id' });
            const draft = await this._version_repo.find_draft(params.version_id);
            if (!draft || draft.team_id !== team.id) throw new ApiError('not_found', 'Draft not found', 404);
            await this._version_repo.delete_draft(params.version_id);
        } else if (params.description !== undefined) {
            await this._team_repo.update_description(team.id, params.description);
        }
        return { id: team.id, name: team.name, scope: team.scope, status: team_status(team.visibility), version: null };
    }

    /** Return a draft team to draft status (visibility draft, listed 0). Versions kept. */
    /**
     * Unpublish: back to draft, and off every realm that has it — all or nothing. Every realm whose
     * team list has the team is checked first against the same rule as `realms/remove_team`
     * (operate + realms.teams.manage). If the caller can't remove it from any one of them, nothing
     * changes (403 `unpublish_blocked`, naming the realms they can see and counting the rest).
     * Otherwise the team leaves every team list and goes back to draft in one transaction; the
     * daemons are then told to uninstall it (best effort, like `realms/remove_team`).
     *
     * @throws ApiError 403 `unpublish_blocked` when the caller can't remove it from a realm that has it.
     */
    async unpublish(auth: AuthContext, params: {
        name?: string; scope?: string; team_id?: string;
    }) {
        log.debug('unpublish', { team_id: params.team_id, name: params.name, scope: params.scope });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');

        const team = await this._resolve_team_for_write(auth, params);
        const scope = team.scope ?? '';
        const slug = team.name;
        const sq = get_sequelize();
        // The live realms that run it, through the realm list's service (PLAN-team-bundle S4.1).
        const on_realms = await RealmTeamListService.realms_with(team.id);
        const realms = on_realms.length ? await sq.query<{ id: string; slug: string }>(
            `SELECT r."id", r."slug" FROM cliq."realms" r WHERE NOT r."deleted" AND r."id" IN (:ids) ORDER BY r."slug"`,
            { replacements: { ids: on_realms }, type: QueryTypes.SELECT },
        ) : [];

        // Pre-flight: the caller must be able to remove it from every one of them.
        const [{ ROUTE_POLICY }, { decide }, { SequelizeAccessStore }] = await Promise.all([
            import('../auth/route_policy/table.js'), import('../auth/route_policy/engine.js'), import('../auth/route_policy/store.js'),
        ]);
        const policy = ROUTE_POLICY['POST /v1/realms/remove_team'];
        const store = new SequelizeAccessStore();
        const blocked: Array<{ realm_id: string; realm_slug: string }> = [];
        let hidden = 0;
        for (const r of realms) {
            const d = await decide(policy, { method: 'POST', path: '/v1/realms/remove_team', body: { realm_id: r.id, scope, slug }, auth }, store, { allow_pat_daemon_writes: false });
            if (d.allow) continue;
            if (d.status === 404) hidden += 1; else blocked.push({ realm_id: r.id, realm_slug: r.slug });
        }
        if (blocked.length || hidden) {
            const parts = [
                ...(blocked.length ? [`you can't remove it from ${blocked.map((b) => b.realm_slug).join(', ')}`] : []),
                ...(hidden ? [`it's installed in ${hidden} realm${hidden === 1 ? '' : 's'} you can't see`] : []),
            ];
            log.info('team_unpublish_blocked', { team_id: team.id, realms: realms.length, blocked: blocked.length, hidden });
            throw new ApiError('unpublish_blocked', `Not unpublished: ${parts.join(', and ')}. Ask someone who can remove it there, then try again.`, 403, { blocked, hidden });
        }

        await sq.transaction(async (t) => {
            if (realms.length) await RealmTeamListService.take_off_realms(team.id, realms.map((r) => r.id), t);
            await this._team_repo.update_visibility_and_listed(team.id, 'draft', 0, t);
        });

        // After commit: tell each realm's daemons to uninstall it (as realms/remove_team does).
        const { DispatchService } = await import('./dispatch.service.js');
        for (const r of realms) {
            await DispatchService.uninstall_team({ scope, slug, realm_id: r.id, user_id: auth.user.id, org_ids: auth.org_ids })
                .catch((err) => log.warn('team_unpublish_uninstall_failed', { team_id: team.id, realm_id: r.id, error: err instanceof Error ? err.message : String(err) }));
            void import('./mesh_lifecycle.service.js')
                .then(({ MeshLifecycleService }) => MeshLifecycleService.on_skills_changed(r.id))
                .catch(() => {});
        }
        log.info('team_unpublished', { team_id: team.id, uninstalled_from: realms.length });

        if (auth.user.role === 'admin' && team.author_id !== auth.user.id && this._audit_repo) {
            await this._audit_repo.create(auth.user.id, 'team.unpublish', 'team', team.id, {
                name: team.name, scope: team.scope, uninstalled_from: realms.map((r) => r.slug),
            });
        }

        return {
            id: team.id,
            name: team.name,
            scope: team.scope,
            status: 'draft' as const,
            version: null,
            listed: false,
            /** Realms it was removed from. */
            uninstalled_from: realms.map((r) => ({ realm_id: r.id, realm_slug: r.slug })),
        };
    }

    async publish(auth: AuthContext, params: {
        name?: string; scope?: string; team_id?: string;
        version?: string;
        changelog?: string; description?: string; license?: string;
        tags?: string[]; visibility?: 'public' | 'private';
        version_id?: string;
    }) {
        log.debug('publish', { team_id: params.team_id, name: params.name, scope: params.scope });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');

        let team = null as Awaited<ReturnType<TeamRepository['find_by_id']>>;
        if (params.team_id) {
            team = await this._team_repo.find_by_id(params.team_id);
            if (!team) throw new ApiError('not_found', 'Team not found', 404);
        }

        const name = params.name || team?.name;
        if (!name) throw new ApiError('invalid_params', 'name is required', 422);
        if (!SLUG_PATTERN.test(name)) throw new ApiError('invalid_params', 'Team name must be lowercase letters, numbers, and hyphens, starting with a letter', 422);

        const scope = params.scope !== undefined ? (params.scope || null) : (team ? team.scope : null);
        // A team's scope is fixed and always set (PLAN-team-bundle S2): no moving it, no team without one.
        if (team && scope !== team.scope) {
            throw new ApiError('scope_mismatch', `@${team.scope}/${team.name} is in @${team.scope}, not @${scope ?? '(none)'}: a team can't change scope (fork it into the other scope instead)`, 409);
        }
        if (!scope) throw new ApiError('invalid_params', 'A scope is required: name the team @scope/name in team.yml, or pass --scope', 422);
        // `teams.publish` in the scope's org, for a new team or anyone's (PLAN-team-visibility §3.3).
        const scope_row = await this._assert_can_publish(auth, scope);

        if (!team) team = await this._team_repo.find_by_name_and_scope(name, scope);

        // New teams are private unless published as public; a republish keeps the team's visibility.
        const visibility: 'public' | 'private' = params.visibility
            ?? (team && team.visibility !== 'draft' ? team.visibility as 'public' | 'private' : 'private');
        const visibility_was = team && team.visibility !== 'draft' ? team.visibility : null;
        if (team?.forked_from_team_id) await this._assert_fork_visibility(auth, team.forked_from_team_id, visibility);

        // Status-only republish: list the team again without a new version.
        if (!params.version_id) {
            if (!team) throw new ApiError('invalid_params', 'files are required for new teams', 422);
            const latest = await this._version_repo.find_latest_version(team.id);
            if (!latest) throw new ApiError('invalid_params', 'files are required when the team has no versions', 422);
            // Only the latest version is re-listed; a new number needs its files (cliq 1.15.10 and older send none).
            if (params.version && params.version !== latest) {
                throw new ApiError('files_required', `Version ${params.version} needs its files: upload them and publish the draft (on cliq 1.15.10 or older, upgrade cliq and publish again)`, 422);
            }
            if (params.tags && params.tags.length > 20) throw new ApiError('invalid_params', 'Maximum 20 tags allowed', 422);
            // Publishing (or re-listing) the latest version: its team.yml gets the same check as a new package.
            const row = await this._version_repo.find_by_team_and_version(team.id, latest);
            const content = row ? await version_content(row.id) : null;
            await assert_team_lints(content?.team_yml ?? null, content?.roles ?? []);
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
            await this._visibility_changed(auth, scope_row, team.scope, team.name, visibility_was, visibility);
            return {
                id: team.id,
                name: team.name,
                scope: team.scope,
                version: latest,
                status: 'published' as const,
                listed: true,
                visibility,
            };
        }

        // Every publish names its version (PLAN-team-bundle S2): no bump, no automatic number.
        if (!params.version) throw new ApiError('invalid_params', 'version is required (e.g. 1.0.0)', 422);
        if (!SEMVER_PATTERN.test(params.version)) {
            throw new ApiError('invalid_params', 'Version must be valid semver (e.g. 1.0.0)', 422);
        }

        let tags = params.tags ? normalize_tags(params.tags) : undefined;
        if (params.tags && params.tags.length > 20) throw new ApiError('invalid_params', 'Maximum 20 tags allowed', 422);

        // The draft to publish (PLAN-team-bundle §2.6): its files are read from storage and checked; nothing is copied.
        if (!team) throw new ApiError('not_found', 'Team not found', 404);
        const draft = await this._version_repo.find_draft(params.version_id);
        if (!draft || draft.team_id !== team.id) throw new ApiError('not_found', 'Draft not found (upload the files first: teams/files/upload)', 404);
        const files = await this._read_version_files(draft.id);
        // The stored team.yml says what is published: its scope and version are set to the team's and this one.
        if (files[TEAM_YML] !== undefined) {
            let with_identity: string;
            try {
                with_identity = set_identity(files[TEAM_YML], { scope: team.scope ?? undefined, version: params.version });
            } catch (err) {
                if (err instanceof TeamIdentityError) throw new ApiError('invalid_package', err.message, 422);
                throw err;
            }
            if (with_identity !== files[TEAM_YML]) {
                await this._store_files(team.id, draft.id, [{ path: TEAM_YML, content_type: 'text/yaml', data: Buffer.from(with_identity, 'utf8') }]);
                files[TEAM_YML] = with_identity;
            }
        }
        const { team_yml } = await check_team_files(files);
        // The same derivation every read uses (PLAN-team-bundle S1.4b); the version's content is its files.
        const { workflow } = derive_version_content(files);

        if (!tags && team_yml.tags) tags = normalize_tags(team_yml.tags);

        const description = params.description || team_yml.description || '';
        const license = params.license || 'MIT';

        /** Validate HUG gate phases have mandatory review.reviewers. */
        validate_hug_reviewer_groups(workflow);

        const resolved_version = params.version;

        if (team) {
            const existing_ver = await this._version_repo.find_by_team_and_version(team.id, resolved_version);
            if (existing_ver) throw new ApiError('conflict', `Version ${resolved_version} already exists`, 409);

            // Higher than every number used so far, withdrawn versions included.
            const current_max = await this._version_repo.find_highest_version(team.id);
            if (current_max && SemVer.compare(resolved_version, current_max) < 0) {
                throw new ApiError(
                    'invalid_params',
                    `Version ${resolved_version} is older than ${current_max}, the highest version so far (withdrawn ones count): publish a higher version (cliq team publish <dir> --version x.y.z)`,
                    422,
                );
            }
        }


        const published_team_id = team.id;
        await get_sequelize().transaction(async (t) => {
            const effective_team_id = team.id;
            await this._team_repo.update(team.id, description, license, visibility, t);
            // Must use the same transaction: a second connection UPDATE on the
            // locked team row deadlocks until the statement timeout → 500.
            await this._team_repo.update_listed(team.id, 1, t);

            const flipped = await this._version_repo.publish_draft(draft.id, { version: resolved_version!, changelog: params.changelog || '' }, t);
            if (!flipped) throw new ApiError('conflict', 'That draft was published or discarded meanwhile', 409);

            if (tags) {
                await this._tag_repo.delete_by_team_id(effective_team_id, t);
                for (const tag of tags) {
                    await this._tag_repo.create(effective_team_id, tag, t);
                }
            }
        });
        await this._visibility_changed(auth, scope_row, scope, name, visibility_was, visibility);

        return {
            id: published_team_id,
            name,
            scope,
            version: resolved_version,
            status: 'published' as const,
            listed: true,
            visibility,
        };
    }

    /**
     * A published version's zip: the cached one if it's there, else built from the version's `team_files`, stored at
     * `teams/<team_id>/versions/<version_id>.zip`, and pointed at (PLAN-team-bundle §2.6). Null when the version has
     * neither (it never had files).
     */
    private async _version_zip(team_id: string, version_id: string, package_path: string): Promise<Buffer | null> {
        if (!this._storage) return null;
        const cached_key = stored_key(package_path);
        const cached = cached_key ? await this._storage.read(cached_key) : null;
        if (cached) return cached;
        const files = await this._read_version_files(version_id);
        if (Object.keys(files).length === 0) return null;
        const zip = await pack_bundle({ files });
        const key = version_zip_key(team_id, version_id);
        await this._storage.write(key, zip);
        await this._version_repo.update_package_path(version_id, key);
        return zip;
    }

    async download(auth: AuthContext, params: { name?: string; scope?: string; version?: string; version_id?: string }) {
        log.debug('download', { name: params.name, scope: params.scope, version: params.version, version_id: params.version_id });
        let team: Awaited<ReturnType<TeamRepository['find_by_id']>>;
        let ver: { id: string; package_path: string; version: string } | null;
        if (params.version_id) {
            // A version by its id (what cliqd installs from, S5).
            const row = await this._version_repo.find_package_by_id(params.version_id);
            team = row ? await this._team_repo.find_by_id(row.team_id) : null;
            if (!row || !team || !can_view_team(auth, team)) throw new ApiError('not_found', 'Version not found', 404);
            ver = row;
        } else {
            if (!params.name) throw new ApiError('invalid_params', 'name or version_id is required', 422);
            team = await this._team_repo.find_by_name_and_scope(params.name, params.scope || null);
            if (!team || !can_view_team(auth, team)) throw new ApiError('not_found', 'Team not found', 404);
            ver = params.version
                ? await this._version_repo.find_package_by_version(team.id, params.version)
                : await this._version_repo.find_latest_package(team.id);
        }
        if (!ver) throw new ApiError('not_found', 'No versions published', 404);

        const data = await this._version_zip(team.id, ver.id, ver.package_path);
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

        return { filename: `${team.name}-${ver.version}.zip`, data_base64: data.toString('base64'), version: ver.version, version_id: ver.id };
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
            // Deleting a published team deletes its published versions (PLAN-team-visibility §3.3).
            await this._assert_can_publish(auth, team.scope, team.visibility === 'draft' ? 'teams.publish' : 'teams.publish.delete');
        }

        const versions = await this._version_repo.list_packages_by_team(team.id);
        await get_sequelize().transaction(async (t) => {
            await this._team_repo.delete_by_id(team.id, t);
        });

        if (this._storage) {
            for (const v of versions) {
                const key = stored_key(v.package_path);
                if (key) await this._storage.delete(key);
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

    /** Withdraw a published version (the route keeps its name, `teams/delete_version`). */
    async delete_version(auth: AuthContext, params: { name: string; scope?: string; version: string }) {
        log.debug('delete_version', { name: params.name, scope: params.scope, version: params.version });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_access(auth, 'teams', 'write');
        const scope = params.scope || null;
        const team = await this._team_repo.find_by_name_and_scope(params.name, scope);
        if (!team) throw new ApiError('not_found', 'Team not found', 404);
        await this._assert_can_publish(auth, team.scope, 'teams.publish.delete');

        const ver = await this._version_repo.find_id_and_package(team.id, params.version);
        if (!ver) throw new ApiError('not_found', `Version ${params.version} not found`, 404);

        // Withdraw, not delete (PLAN-team-bundle S2): out of "latest", lists and installs by name; its files and zip
        // stay so runs and installed trees that use it keep working; its number can't be published again.
        if (!(await this._version_repo.withdraw(ver.id))) throw new ApiError('conflict', `Version ${params.version} is already withdrawn`, 409);
        return { withdrawn: true, version: params.version };
    }

    // ─── Private helpers ────────────────────────────────────────────

    /**
     * A fork of a private team may be public only for someone who can publish in the origin's scope
     * (PLAN-team-bundle S2): otherwise its content would leave the scope that keeps it private.
     *
     * @throws ApiError 403 when the fork would be public and the caller can't publish in the origin's scope.
     */
    private async _assert_fork_visibility(auth: AuthContext, origin_team_id: string, visibility: 'public' | 'private'): Promise<void> {
        if (visibility !== 'public') return;
        const origin = await this._team_repo.find_by_id(origin_team_id);
        if (!origin || origin.visibility !== 'private') return;
        try {
            await this._assert_can_publish(auth, origin.scope);
        } catch {
            throw new ApiError('forbidden', `@${origin.scope}/${origin.name} is private: its fork can be public only for someone who can publish in @${origin.scope}`, 403);
        }
    }

    /**
     * The team version a new team is forked from: the caller must be able to
     * read the team, and the version must exist (latest when not given).
     *
     * @throws ApiError 404 when the team or version is not found; 409 when the team has no version yet.
     */
    private async _fork_origin(auth: AuthContext, ref: { team_id: string; version?: string }): Promise<{
        team_id: string; version: string; version_id: string; description: string;
        /** The version's files, copied into the fork's draft. */
        files: Record<string, string>;
    }> {
        const source = await this._team_repo.find_by_id(ref.team_id);
        if (!source || !can_read_team(auth, source)) throw new ApiError('not_found', 'Team to fork not found', 404);
        const version = ref.version ?? await this._version_repo.find_latest_version(source.id);
        if (!version) throw new ApiError('conflict', `@${source.scope}/${source.name} has no version to fork yet`, 409);
        const row = await this._version_repo.find_by_team_and_version(source.id, version);
        const files = row ? await this._read_version_files(row.id) : {};
        if (!row || !files[TEAM_YML]) throw new ApiError('not_found', `Version ${version} not found`, 404);
        return { team_id: source.id, version, version_id: row.id, description: source.description, files };
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
        } else {
            if (!params.name) throw new ApiError('invalid_params', 'name is required', 422);
            team = await this._team_repo.find_by_name_and_scope(params.name, params.scope || null);
            if (!team) throw new ApiError('not_found', 'Team not found', 404);
        }
        await this._assert_can_publish(auth, team.scope);
        return team;
    }

    /**
     * Who may write a team in `scope` (PLAN-team-visibility §3.3): `permission` (default
     * `teams.publish`) in the scope's org, whoever wrote the team; site admins always. A scope
     * with no org (a legacy personal scope) is its owner's.
     *
     * @returns the scope row (its org decides who publishes)
     * @throws ApiError 403 without the permission; 404 for an unknown scope
     */
    private async _assert_can_publish(auth: AuthContext, scope: string | null, permission = 'teams.publish') {
        const row = scope ? await (this._scope_repo ?? _scope_repo_ts).find_by_slug(scope) : null;
        if (auth.user!.role === 'admin') return row;
        if (!row) throw new ApiError(scope ? 'not_found' : 'forbidden', scope ? `Scope '@${scope}' not found` : 'A team needs a scope', scope ? 404 : 403);
        if (!row.org_id) {
            if (row.owner_id === auth.user!.id) return row;
            throw new ApiError('forbidden', `You can't publish to @${scope}`, 403);
        }
        if (!(await this._has_permission(auth, row.org_id, permission))) {
            throw new ApiError('forbidden', `Publishing to @${scope} needs '${permission}' in its org`, 403, { scope, permission });
        }
        return row;
    }

    /** Whether the caller's role in `org_id` grants `permission` (owners have all). */
    private async _has_permission(auth: AuthContext, org_id: string, permission: string): Promise<boolean> {
        try {
            await require_permission(org_id, auth.user!.id, permission);
            return true;
        } catch {
            // require_permission throws for a non-member or a role without the permission: both mean no.
            return false;
        }
    }

    /** Raise `team.visibility_changed` when a publish changed a published team's visibility. */
    private async _visibility_changed(
        auth: AuthContext, scope_row: { org_id?: string | null } | null, scope: string | null, name: string,
        from: string | null, to: string,
    ): Promise<void> {
        if (!from || from === to) return;
        try {
            const { EventSubmitService } = await import('./events_service.js');
            await EventSubmitService.submit({
                type: 'team.visibility_changed',
                ...(scope_row?.org_id ? { org_id: scope_row.org_id } : {}),
                team: scope ? `${scope}/${name}` : name,
                title: `@${scope}/${name} is now ${to}`,
                payload: { from, to, actor_id: auth.user!.id },
            });
        } catch (err) {
            log.warn('team_visibility_event_failed', { scope, name, error: err instanceof Error ? err.message : String(err) });
        }
    }

    /**
     * A version's files from storage, each checked against its row's sha256 and decoded as UTF-8 text.
     *
     * @throws ApiError 500 when bytes are missing or don't match their row; 422 when a file isn't text.
     */
    private async _read_version_files(version_id: string): Promise<Record<string, string>> {
        if (!this._storage) throw new ApiError('internal', 'No storage configured', 500);
        return read_team_files(this._storage, await this._file_repo.list_by_version(version_id));
    }


    /**
     * Compute the caller's permissions for a team.
     *
     * Permissions (PLAN-team-visibility §3.3):
     *   - Site admin → full access
     *   - `teams.publish` in the scope's org → edit + toggle listing
     *   - `teams.publish.delete` there → delete
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

        // The same rule the writes enforce (PLAN-team-visibility §3.3): the permission in the scope's org.
        const scope_row = team.scope ? await (this._scope_repo ?? _scope_repo_ts).find_by_slug(team.scope) : null;
        if (!scope_row) return { can_edit: false, can_delete: false, can_toggle_listing: false };
        if (!scope_row.org_id) {
            const own = scope_row.owner_id === auth.user.id;
            return { can_edit: own, can_delete: own, can_toggle_listing: own };
        }
        const [publish, del] = await Promise.all([
            this._has_permission(auth, scope_row.org_id, 'teams.publish'),
            this._has_permission(auth, scope_row.org_id, 'teams.publish.delete'),
        ]);
        return { can_edit: publish, can_delete: del, can_toggle_listing: publish };
    }

    /**
     * Marketplace details for a page of catalog teams: the latest version's
     * phases, version count, last update and fork count. One query per kind of
     * detail, not per team.
     */
    async catalog_details(rows: Array<{ id: string; latest_version: string | null; scope: string | null }>): Promise<Map<string, {
        phases: Array<{ name: string; type: string | null; agent: string | null }>;
        version_count: number; updated_at?: number; fork_count: number;
    }>> {
        const out = new Map<string, { phases: Array<{ name: string; type: string | null; agent: string | null }>; version_count: number; updated_at?: number; fork_count: number }>();
        const ids = rows.map((r) => r.id).filter(Boolean);
        if (ids.length === 0) return out;
        const sequelize = get_sequelize();
        const [versions, teams, forks] = await Promise.all([
            sequelize.query<{ team_id: string; id: string; version: string }>(
                'SELECT "team_id", "id", "version" FROM cliq."team_versions" WHERE "team_id" IN (:ids) AND "status" = \'published\' AND "withdrawn_at" IS NULL',
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
        ]);
        const updated = new Map(teams.map((t) => [String(t.id), t.updated_at ? new Date(t.updated_at).getTime() : undefined]));
        // The latest version's phases, from its files (PLAN-team-bundle S1.4b; cached by version).
        const latest_ids = rows.map((row) => versions.find((v) => String(v.team_id) === row.id && v.version === row.latest_version)?.id).filter((id): id is string => Boolean(id));
        const contents = await version_contents(latest_ids.map(String));
        const fork_counts = new Map(forks.map((f) => [String(f.forked_from_team_id), Number(f.n)]));
        for (const row of rows) {
            const mine = versions.filter((v) => String(v.team_id) === row.id);
            const latest = mine.find((v) => v.version === row.latest_version);
            const workflow_phases = (latest ? contents.get(String(latest.id))?.workflow.phases : undefined) ?? [];
            const phases = (workflow_phases as Array<Record<string, unknown>>).map((p) => ({
                name: String(p?.name ?? ''),
                type: typeof p?.type === 'string' ? p.type : null,
                agent: typeof p?.agent === 'string' ? p.agent : null,
            }));
            out.set(row.id, {
                phases,
                version_count: mine.length,
                ...(updated.get(row.id) !== undefined ? { updated_at: updated.get(row.id) } : {}),
                fork_count: fork_counts.get(row.id) ?? 0,
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
export function validate_hug_reviewer_groups(workflow: NormalizedWorkflow): void {
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
