import { ApiToken } from '../db/models/index.js';
import { User } from '../db/models/user.js';
import { RealmInvite } from '../db/models/realm_invite.js';
import { default_daemon_grant, type Token_grant } from '../auth/grants.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Op, fn, col, type WhereOptions } from 'sequelize';

import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { AgentCatalog, Daemon, Realm, RealmMember, RealmDispatchQueue, Run, Team, Scope } from '../models/index.js';
import { Team as RegistryTeam } from '../db/models/team.js';
import { TeamVersion } from '../db/models/team_version.js';
import { extract_agents_from_workflow, parse_agent_ref } from '../lib/agent_catalog_usage.js';
import { max_semver } from '../lib/semver.js';
import type { RealmModel } from '../models/realm.model.js';
import type { RealmMemberModel, Realm_member_role, Realm_member_type } from '../models/realm_member.model.js';
import { TokenRepository } from '../repositories/token_repository.js';
import { RealmAgentSettingRepository } from '../repositories/realm_agent_setting_repository.js';
import { NotificationService } from './notification.service.js';
import { RealmDispatchKeyService } from './realm_dispatch_key.service.js';
import { EventSubmitService } from '../events/submit.service.js';
import { legacy_personal_realm_slugs } from '../lib/personal_realm.js';
import {
    account_default_realm_slug,
    account_default_realm_name,
    primary_account_slug_for_user,
} from '../lib/account_realm.js';

const log = get_logger('realm');

/** Dots are reserved for the org.slug qualified separator. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const TOKEN_PREFIX = 'cliq_dt_';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function escape_like(input: string): string {
    return input.replace(/[%_\\]/g, '\\$&');
}

function hash_invite_token(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export interface Realm_dto {
    id: string;
    slug: string;
    /** Owning org slug — enables `org_slug.slug` qualified form. */
    org_slug: string | null;
    /** Qualified slug in `org.realm` format (null if org unknown). */
    qualified_slug: string | null;
    name: string;
    owner_user_id: string;
    created_by: string;
    /** Resolved Hub username for created_by when available. */
    created_by_username: string | null;
    created_at: number;
    updated_at: number;
}

export interface Realm_member_dto {
    id: string;
    realm_id: string;
    member_type: Realm_member_type;
    member_id: string;
    /** Resolved Hub username for user members (null for daemons/groups). */
    username: string | null;
    role: Realm_member_role;
    created_at: number;
}

export interface Realm_token_dto {
    id: string;
    realm_id: string;
    name: string;
    created_by: string;
    created_at: number;
    revoked_at: number | null;
    permissions: Record<string, unknown>;
}

export interface Realm_token_created extends Realm_token_dto {
    /** Plaintext secret — returned only at create time. */
    token: string;
}

export interface Personal_realm_result {
    realm: Realm_dto;
    default_realm_id: string;
    default_realm_slug: string;
    /** Plaintext enroll token — only when the personal realm is first created. */
    enroll_token: string | null;
}

function now_ms(): number {
    return Date.now();
}

/** BIGINT columns often arrive as strings — coerce for JSON clients. */
function as_ms(value: number | string | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function hash_token(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
}

function mint_plaintext_token(): string {
    return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function assert_slug(slug: string): void {
    if (SLUG_RE.test(slug)) return;
    throw ApiError.bad_request(
        `Invalid realm slug '${slug}' — use lowercase letters, digits, ., _ or - (max 63)`,
    );
}

const ALIVE = { deleted: false } as const;

async function emit_member_removed(params: {
    realm_id: string;
    actor_id: string;
    member_type: Realm_member_type;
    member_id: string;
    reason: 'manual' | 'realm_deleted';
}): Promise<void> {
    try {
        await EventSubmitService.submit({
            type: 'realm.member_removed',
            realm_id: params.realm_id,
            actor_id: params.actor_id,
            title: 'Realm member removed',
            message: `${params.member_type} ${params.member_id} removed from realm`,
            payload: {
                member_type: params.member_type,
                member_id: params.member_id,
                reason: params.reason,
            },
        });
    } catch (err) {
        log.warn('realm_member_removed_event_failed', {
            realm_id: params.realm_id,
            member_id: params.member_id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

function to_realm_dto(
    row: RealmModel,
    created_by_username: string | null = null,
    org_slug: string | null = null,
): Realm_dto {
    return {
        id: row.id,
        slug: row.slug,
        org_slug,
        qualified_slug: org_slug ? `${org_slug}.${row.slug}` : null,
        name: row.name,
        owner_user_id: row.owner_user_id || row.created_by,
        created_by: row.created_by,
        created_by_username,
        created_at: as_ms(row.created_at),
        updated_at: as_ms(row.updated_at),
    };
}

async function username_by_user_ids(user_ids: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(
        user_ids
            .map((id) => String(id).trim())
            .filter((id) => id.length > 0),
    )];
    if (ids.length === 0) return new Map();
    if (!User.sequelize) return new Map();

    try {
        const rows = await User.findAll({
            where: { id: { [Op.in]: ids } },
            attributes: ['id', 'username'],
        });
        const map = new Map<string, string>();
        for (const row of rows) {
            map.set(String(row.id), row.username);
        }
        return map;
    } catch {
        return new Map();
    }
}

/** Bulk-resolve org slugs by org_id. */
export async function org_slug_by_ids(org_ids: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(org_ids.filter((n) => typeof n === 'string' && n.length > 0))];
    if (ids.length === 0) return new Map();

    try {
        const { Org } = await import('../db/models/index.js');
        const rows = await Org.findAll({
            where: { id: { [Op.in]: ids } },
            attributes: ['id', 'slug'],
        });
        const map = new Map<string, string>();
        for (const row of rows) {
            map.set(row.id, row.slug);
        }
        return map;
    } catch {
        return new Map();
    }
}

async function to_realm_dtos(rows: RealmModel[]): Promise<Realm_dto[]> {
    const usernames = await username_by_user_ids(rows.map((r) => r.created_by));
    const org_slugs = await org_slug_by_ids(rows.map((r) => r.org_id));
    return rows.map((row) => to_realm_dto(
        row,
        usernames.get(row.created_by) ?? null,
        org_slugs.get(row.org_id) ?? null,
    ));
}

async function to_realm_dto_enriched(row: RealmModel): Promise<Realm_dto> {
    const [dto] = await to_realm_dtos([row]);
    return dto;
}

function to_member_dto(row: RealmMemberModel, username?: string | null): Realm_member_dto {
    return {
        id: row.id,
        realm_id: row.realm_id,
        member_type: row.member_type,
        member_id: row.member_id,
        username: username ?? null,
        role: row.role,
        created_at: as_ms(row.created_at),
    };
}

function primary_realm_id(permissions: Record<string, unknown> | null | undefined): string {
    const domains = (permissions as Token_grant | undefined)?.domains;
    const realms = domains?.realms;
    if (Array.isArray(realms)) {
        const first = realms.find((r): r is string => typeof r === 'string' && r !== '*');
        if (first) return first;
    }
    return '';
}

function to_token_dto(row: {
    id: string;
    user_id: string;
    name: string;
    permissions: Record<string, unknown> | null;
    created_at: Date | string | number;
    revoked_at: Date | string | number | null;
}, realm_id_hint?: string): Realm_token_dto {
    const permissions = (row.permissions as Record<string, unknown>) ?? {};
    const created = row.created_at instanceof Date
        ? row.created_at.getTime()
        : as_ms(row.created_at as number);
    const revoked = row.revoked_at == null
        ? null
        : row.revoked_at instanceof Date
            ? row.revoked_at.getTime()
            : as_ms(row.revoked_at as number);
    return {
        id: row.id,
        realm_id: realm_id_hint || primary_realm_id(permissions),
        name: row.name,
        created_by: String(row.user_id),
        created_at: created,
        revoked_at: revoked,
        permissions,
    };
}

export class RealmService {
    static async create(
        user_id: string,
        slug: string,
        name: string,
        opts?: { org_id?: string | null },
    ): Promise<Realm_dto> {
        assert_slug(slug);
        const trimmed_name = name.trim();
        if (!trimmed_name) throw ApiError.bad_request('name is required');

        // Resolve org_id before the duplicate check so we can scope it.
        let org_id: string | undefined = opts?.org_id ?? undefined;
        if (org_id == null) {
            const { User } = await import('../db/models/index.js');
            const {
                ensure_personal_org_for_user,
            } = await import('../db/migrate_ensure_user_orgs.js');
            const user = await User.findByPk(user_id, { attributes: ['id', 'username'] });
            if (!user?.username) {
                throw ApiError.bad_request('Cannot create realm: user not found for org resolution');
            }
            const org = await ensure_personal_org_for_user(user.id, user.username);
            org_id = org.id;
        }
        if (!org_id) {
            throw ApiError.bad_request('Cannot create realm: org_id is required');
        }

        // Duplicate check scoped to the org (UNIQUE(org_id, slug)).
        const dup_where: Record<string, unknown> = { slug, ...ALIVE };
        if (org_id) dup_where.org_id = org_id;
        const dup = await Realm.findOne({ where: dup_where });
        if (dup) throw ApiError.conflict(`Realm slug '${slug}' already exists in this org`);

        const ts = now_ms();
        const realm = await Realm.create({
            id: randomUUID(),
            slug,
            name: trimmed_name,
            owner_user_id: user_id,
            created_by: user_id,
            org_id,
            deleted: false,
            deleted_at: null,
            created_at: ts,
            updated_at: ts,
        });
        await RealmMember.create({
            id: randomUUID(),
            realm_id: realm.id,
            member_type: 'user',
            member_id: user_id,
            role: 'admin',
            created_at: ts,
        });
        await NotificationService.ensure_realm_cliqhub_channel(realm.id);

        // Snapshot org-level agent credentials into the fresh realm so
        // it starts pre-populated with sensible defaults.
        try {
            if (user_id && org_id) {
                const repo = new RealmAgentSettingRepository();
                await repo.snapshot_from_org(String(org_id), String(user_id), realm.id);
            }
        } catch (err) {
            log.warn('realm_create_agent_settings_snapshot_failed', {
                realm_id: realm.id,
                user_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // Pre-populate realm team_list with built-in teams so the first
        // daemon to register gets them installed through the proper flow
        // (DispatchService.install_team), wiring all scope/realm associations.
        try {
            const { RealmTeamListService } = await import('./realm_team_list.service.js');
            await RealmTeamListService.seed_builtin_teams(realm.id);
        } catch (err) {
            log.warn('realm_create_builtin_team_list_failed', {
                realm_id: realm.id,
                user_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        try {
            const { MeshLifecycleService } = await import('./mesh_lifecycle.service.js');
            await MeshLifecycleService.on_realm_created(realm.id, user_id);
        } catch (err) {
            log.warn('realm_create_mesh_auto_enable_failed', {
                realm_id: realm.id,
                user_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        return to_realm_dto_enriched(realm);
    }

    /**
     * Ensure the account has a default realm.
     * Migrates legacy `{user}-default-realm` / `r-*` / `u-*` slugs in place to
     * `{account_slug}.default` so realm id (tokens, daemon members) is preserved.
     */
    static async ensure_personal_realm(
        user_id: string,
        username: string,
    ): Promise<Personal_realm_result> {
        const account_slug = await primary_account_slug_for_user(String(user_id), username);
        return RealmService.ensure_account_default_realm(user_id, account_slug);
    }

    /**
     * Ensure the caller has a personal default realm.
     *
     * Dumb by design: find one this user owns, else create one. Never
     * renames an existing realm and never reassigns ownership — those
     * paths were how three users (sapan, bharat, krupali) ended up
     * sharing the same physical realm row (see prod 99a2f0f1).
     *
     * Slug preference is `<account_slug>.default`. If that slug is
     * already taken by another user (data corruption from the old
     * self-renaming code), fall back to a unique variant so we never
     * touch someone else's row.
     */
    static async ensure_account_default_realm(
        user_id: string,
        account_slug: string,
    ): Promise<Personal_realm_result> {
        const preferred_slug = account_default_realm_slug(account_slug);
        const display_name = account_default_realm_name(account_slug);
        assert_slug(preferred_slug);

        const user = await User.findByPk(user_id);
        if (!user) throw ApiError.not_found(`User '${user_id}' not found`);

        // Resolve the personal org — needed for org-scoped slug lookups.
        let personal_org_id: string | undefined;
        try {
            const { ensure_personal_org_for_user } = await import('../db/migrate_ensure_user_orgs.js');
            const org = await ensure_personal_org_for_user(String(user_id), account_slug);
            personal_org_id = org.id;
        } catch { /* best-effort */ }

        // 1. Owned realm at user.default_realm_id? Use it as-is.
        //    Never touch slug/name/owner even if drifted.
        let realm_row: RealmModel | null = null;
        if (user.default_realm_id) {
            const current = await Realm.findByPk(user.default_realm_id);
            if (current && !current.deleted && String(current.owner_user_id) === user_id) {
                realm_row = current;
            } else if (current && (current.deleted || String(current.owner_user_id) !== user_id)) {
                // Stale or soft-deleted pointer — detach and recreate below.
                user.default_realm_id = null as unknown as string;
                await user.save();
            }
        }

        // 2. Any personal realm we already own? Prefer the preferred
        //    slug within the personal org, else any 'default' we own,
        //    else legacy *.default we own.
        if (!realm_row && personal_org_id) {
            realm_row = await Realm.findOne({
                where: { owner_user_id: user_id, slug: preferred_slug, org_id: personal_org_id, ...ALIVE },
            });
        }
        if (!realm_row) {
            realm_row = await Realm.findOne({
                where: { owner_user_id: user_id, slug: 'default', ...ALIVE },
                order: [['created_at', 'ASC']],
            });
        }
        if (!realm_row) {
            // Legacy fallback: old {account}.default slugs that haven't been renamed yet.
            realm_row = await Realm.findOne({
                where: {
                    owner_user_id: user_id,
                    slug: { [Op.like]: '%-default' },
                    ...ALIVE,
                },
                order: [['created_at', 'ASC']],
            });
        }

        // 2b. Personal-org default already exists but ownership drifted
        //     (e.g. UUID remint left owner_user_id as a bare int). Reclaim
        //     orphans only — never steal from a living user (see regression
        //     ensure_account_default_realm.regression.test.ts).
        if (!realm_row && personal_org_id) {
            const existing = await Realm.findOne({
                where: { slug: preferred_slug, org_id: personal_org_id, ...ALIVE },
            });
            if (existing) {
                const owner_id = String(existing.owner_user_id);
                const owner_alive = UUID_RE.test(owner_id)
                    ? await User.findByPk(owner_id, { attributes: ['id'] })
                    : null;
                if (!owner_alive) {
                    existing.owner_user_id = user_id;
                    existing.created_by = user_id;
                    existing.updated_at = now_ms();
                    await existing.save();
                    realm_row = existing;
                } else if (owner_id === user_id) {
                    realm_row = existing;
                }
            }
        }

        // 3. Still nothing — mint a fresh realm. Slug is just 'default',
        //    scoped to the personal org via UNIQUE(org_id, slug).
        if (!realm_row) {
            const created = await RealmService.create(
                user_id, preferred_slug, display_name,
                { org_id: personal_org_id },
            );
            const loaded = await Realm.findByPk(created.id);
            if (!loaded) throw ApiError.internal('Failed to load account default realm after create');
            realm_row = loaded;
        }

        // Post-conditions we're willing to enforce (all idempotent, no
        // rename, no reown):
        //   - caller is an admin member
        //   - created_by matches owner (repair prod fossils where
        //     ownership was fixed but created_by still showed @sapan)
        //   - dispatch key exists
        //   - default enroll token exists
        //   - user.default_realm_id points at this row
        await RealmService.ensure_user_admin(realm_row.id, user_id);
        if (String(realm_row.created_by) !== user_id) {
            realm_row.created_by = user_id;
            realm_row.updated_at = now_ms();
            await realm_row.save();
        }
        await RealmDispatchKeyService.get_or_create_public_key(realm_row.id);
        const enroll_token = await RealmService.ensure_default_enroll_token(
            realm_row.id,
            user_id,
        );

        if (user.default_realm_id !== realm_row.id) {
            user.default_realm_id = realm_row.id;
            await user.save();
        }


        return {
            realm: await to_realm_dto_enriched(realm_row),
            default_realm_id: realm_row.id,
            default_realm_slug: realm_row.slug,
            enroll_token,
        };
    }

    /**
     * Ensure the org's `default` realm exists and grant membership.
     * Org default realms are user-owned (creator admin) and shared via
     * membership. Slug is just `default`, scoped by UNIQUE(org_id, slug).
     * Idempotent. Never steals ownership.
     */
    static async ensure_org_default_realm(
        org_slug: string,
        actor_user_id: string,
        member_user_id?: string,
    ): Promise<Realm_dto> {
        const preferred_slug = account_default_realm_slug(org_slug);
        const display_name = account_default_realm_name(org_slug);
        assert_slug(preferred_slug);

        // Resolve org for org-scoped slug lookup.
        let org_id: string | null = null;
        try {
            const { Org } = await import('../db/models/index.js');
            const org = await Org.findOne({ where: { slug: org_slug.trim().toLowerCase() } });
            org_id = org?.id ?? null;
        } catch { /* ignore */ }

        // Look up by org-scoped slug first, then fall back to legacy
        // {org}.default slug for in-flight migrations.
        let realm_row: RealmModel | null = null;
        if (org_id) {
            realm_row = await Realm.findOne({
                where: { slug: preferred_slug, org_id, ...ALIVE },
            });
        }
        if (!realm_row) {
            // Legacy fallback: old {org_slug}.default slug.
            const legacy_slug = `${org_slug.trim().toLowerCase()}.default`.slice(0, 63);
            realm_row = await Realm.findOne({ where: { slug: legacy_slug, ...ALIVE } });
        }

        if (!realm_row) {
            const created = await RealmService.create(
                actor_user_id,
                preferred_slug,
                display_name,
                { org_id },
            );
            const loaded = await Realm.findByPk(created.id);
            if (!loaded) {
                throw ApiError.internal('Failed to load org default realm after create');
            }
            realm_row = loaded;
        }

        const grant_user = member_user_id ?? actor_user_id;
        if (realm_row.owner_user_id === grant_user) {
            await RealmService.ensure_user_admin(realm_row.id, grant_user);
        } else {
            await RealmService.upsert_user_member(realm_row.id, grant_user, 'member');
        }
        if (
            member_user_id
            && member_user_id !== actor_user_id
            && realm_row.owner_user_id === actor_user_id
        ) {
            await RealmService.ensure_user_admin(realm_row.id, actor_user_id);
        }
        await RealmDispatchKeyService.get_or_create_public_key(realm_row.id);

        return to_realm_dto_enriched(realm_row);
    }

    /** True when an active `type=realm` enroll token grants this realm. */
    static async realm_has_active_enroll_token(realm_id: string): Promise<boolean> {
        const rows = await ApiToken.findAll({
            where: { type: 'realm', revoked_at: null },
        });
        return rows.some((row) => {
            const realms = (row.permissions as Token_grant | undefined)?.domains?.realms;
            if (realms === '*') return true;
            return Array.isArray(realms) && realms.includes(realm_id);
        });
    }

    /**
     * Mint the personal-default enroll token if the realm has none.
     * Uses {@link create_token} only — no parallel mint path.
     * Returns plaintext once when minted; null when a token already exists.
     */
    static async ensure_default_enroll_token(
        realm_id: string,
        user_id: string,
    ): Promise<string | null> {
        if (await RealmService.realm_has_active_enroll_token(realm_id)) return null;
        const minted = await RealmService.create_token(realm_id, user_id, 'default');
        return minted.token;
    }

    /**
     * List realms the user belongs to.
     * Filters are POST-body only (never HTTP query-string).
     * `filters` may be a legacy slug string, or an options object:
     * - `query` — case-insensitive substring on slug/name
     * - `owned` — `me` (owner/creator) or `default` (personal default realm)
     * - `limit` / `offset` — pagination (omit limit to return all matches)
     * - `sort_by` / `sort_dir` — server-side order (default slug ASC)
     * Always membership-scoped — never returns realms the user is not a member of.
     */
    static async list_for_user(
        user_id: string,
        filters?: string | {
            slug?: string;
            query?: string;
            owned?: 'me' | 'default';
            /** Filter realms to those belonging to this org. */
            org_id?: string;
            limit?: number;
            offset?: number;
            sort_by?: 'slug' | 'name' | 'created_at' | 'updated_at' | 'created_by';
            sort_dir?: 'asc' | 'desc';
        },
    ): Promise<{ realms: Realm_dto[]; total: number }> {
        const opts = typeof filters === 'string' ? { slug: filters } : (filters ?? {});
        const query = opts.query?.trim();
        const pattern = query ? `%${escape_like(query)}%` : null;
        const query_clause = pattern
            ? {
                [Op.or]: [
                    { slug: { [Op.iLike]: pattern } },
                    { name: { [Op.iLike]: pattern } },
                ],
            }
            : null;

        const owned_clause = await RealmService._owned_where(user_id, opts.owned);
        if (owned_clause === false) return { realms: [], total: 0 };

        const memberships = await RealmMember.findAll({
            where: { member_type: 'user', member_id: user_id },
        });
        if (memberships.length === 0) return { realms: [], total: 0 };

        const realm_ids = memberships.map((m) => m.realm_id);
        const sort_by = opts.sort_by ?? 'slug';
        const sort_dir = (opts.sort_dir ?? 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        const limit = opts.limit;
        const offset = opts.offset ?? 0;

        const { rows, count } = await Realm.findAndCountAll({
            where: {
                id: { [Op.in]: realm_ids },
                ...ALIVE,
                ...(opts.slug ? { slug: opts.slug } : {}),
                ...(opts.org_id ? { org_id: opts.org_id } : {}),
                ...(query_clause ?? {}),
                ...(owned_clause ?? {}),
            },
            order: [[sort_by, sort_dir]],
            ...(limit != null ? { limit, offset } : {}),
        });
        return { realms: await to_realm_dtos(rows), total: count };
    }

    /**
     * Ownership filter for list_for_user.
     * Returns `false` when the filter can never match (caller should short-circuit).
     */
    private static async _owned_where(
        user_id: string,
        owned: 'me' | 'default' | undefined,
    ): Promise<WhereOptions | false | null> {
        if (!owned) return null;

        if (owned === 'me') {
            return {
                [Op.or]: [
                    { owner_user_id: user_id },
                    { created_by: user_id },
                ],
            };
        }

        const user = await User.findByPk(user_id, { attributes: ['id', 'username', 'default_realm_id'] });

        if (user?.default_realm_id) {
            return { id: user.default_realm_id };
        }

        const username = (user?.username ?? '').trim().toLowerCase().replace(/^@/, '');
        if (!username) return false;

        const slugs = [
            account_default_realm_slug(username),
            username,
            ...legacy_personal_realm_slugs(username),
        ];
        return { slug: { [Op.in]: [...new Set(slugs)] } };
    }

    static async list_daemon_ids_in_realm(realm_id: string): Promise<string[]> {
        const rows = await RealmMember.findAll({
            where: { realm_id, member_type: 'daemon' },
            attributes: ['member_id'],
        });
        return rows.map((r) => r.member_id);
    }

    /** Realms a daemon belongs to (membership rows + realm slug/name). */
    static async list_realms_for_daemon(daemon_id: string): Promise<Array<{
        id: string;
        slug: string;
        name: string;
        role: Realm_member_role;
    }>> {
        const map = await RealmService.list_realms_by_daemon_ids([daemon_id]);
        return map.get(daemon_id) ?? [];
    }

    /** Batch: daemon_id → realm memberships. */
    static async list_realms_by_daemon_ids(daemon_ids: string[]): Promise<Map<string, Array<{
        id: string;
        slug: string;
        name: string;
        role: Realm_member_role;
    }>>> {
        const result = new Map<string, Array<{
            id: string;
            slug: string;
            name: string;
            role: Realm_member_role;
        }>>();
        if (daemon_ids.length === 0) return result;

        const members = await RealmMember.findAll({
            where: {
                member_type: 'daemon',
                member_id: { [Op.in]: daemon_ids },
            },
        });
        if (members.length === 0) return result;

        const realm_ids = [...new Set(members.map((m) => m.realm_id))];
        const realms = await Realm.findAll({
            where: { id: { [Op.in]: realm_ids }, ...ALIVE },
        });
        const realm_by_id = new Map(realms.map((r) => [r.id, r]));

        for (const member of members) {
            const realm = realm_by_id.get(member.realm_id);
            if (!realm) continue;
            const list = result.get(member.member_id) ?? [];
            list.push({
                id: realm.id,
                slug: realm.slug,
                name: realm.name,
                role: member.role,
            });
            result.set(member.member_id, list);
        }
        return result;
    }

    static async get(realm_id: string, user_id: string, opts?: { site_admin?: boolean }): Promise<Realm_dto> {
        if (opts?.site_admin) {
            const realm = await Realm.findByPk(realm_id);
            if (!realm || realm.deleted) throw ApiError.not_found(`Realm '${realm_id}' not found`);
            return to_realm_dto_enriched(realm);
        }
        const realm = await RealmService.require_member(realm_id, user_id);
        return to_realm_dto_enriched(realm);
    }

    static async get_by_slug(
        slug: string,
        user_id: string,
        opts?: { site_admin?: boolean; org_id?: string },
    ): Promise<Realm_dto> {
        // Org-scoped lookup when org_id is provided.
        const where: Record<string, unknown> = { slug, ...ALIVE };
        if (opts?.org_id) where.org_id = opts.org_id;

        let realm = await Realm.findOne({ where });
        if (!realm && UUID_RE.test(slug)) {
            realm = await Realm.findByPk(slug);
            if (realm?.deleted) realm = null;
        }
        if (!realm) throw ApiError.not_found(`Realm '${slug}' not found`);
        if (!opts?.site_admin) {
            await RealmService.require_member_row(realm.id, user_id);
        }
        return to_realm_dto_enriched(realm);
    }

    static async update(
        realm_id: string,
        user_id: string,
        patch: { name?: string },
    ): Promise<Realm_dto> {
        await RealmService.require_admin(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) throw ApiError.not_found(`Realm '${realm_id}' not found`);

        if (patch.name !== undefined) {
            const trimmed = patch.name.trim();
            if (!trimmed) throw ApiError.bad_request('name is required');
            realm.name = trimmed;
        }
        realm.updated_at = now_ms();
        await realm.save();
        return to_realm_dto_enriched(realm);
    }

    /**
     * Soft-delete a realm. Blocks while runs (or dispatch jobs) are still
     * active. Revokes enroll tokens, fires member_removed + realm.deleted
     * events, clears memberships so daemon heartbeats fail auth.
     */
    static async remove(realm_id: string, user_id: string): Promise<void> {
        await RealmService.require_admin(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) throw ApiError.not_found(`Realm '${realm_id}' not found`);

        // Personal default realm cannot be deleted.
        const owner_id = realm.owner_user_id ? String(realm.owner_user_id) : '';
        if (owner_id) {
            const owner = await User.findByPk(owner_id, {
                attributes: ['id', 'username', 'default_realm_id'],
            });
            if (owner?.default_realm_id === realm_id) {
                throw ApiError.conflict(
                    'Cannot delete your personal default realm. Create another realm for day-to-day work instead.',
                );
            }
            const username = (owner?.username ?? '').trim().toLowerCase().replace(/^@/, '');
            if (username && realm.slug === account_default_realm_slug(username)) {
                throw ApiError.conflict(
                    'Cannot delete your personal default realm. Create another realm for day-to-day work instead.',
                );
            }
        }

        const active_runs = await Run.count({
            where: {
                realm_id,
                state: { [Op.in]: ['running', 'awaiting_input'] },
            },
        });
        if (active_runs > 0) {
            throw ApiError.conflict(
                `Cannot delete realm while ${active_runs} run(s) are still in progress `
                + `(running or awaiting input). Finish or cancel them first.`,
            );
        }

        const active_dispatch = await RealmDispatchQueue.count({
            where: {
                realm_id,
                status: { [Op.in]: ['queued', 'offered', 'claimed', 'running', 'dispatching'] },
            },
        });
        if (active_dispatch > 0) {
            throw ApiError.conflict(
                `Cannot delete realm while ${active_dispatch} dispatch job(s) are still active. `
                + `Wait for them to finish or cancel them first.`,
            );
        }

        try {
            const { MeshLifecycleService } = await import('./mesh_lifecycle.service.js');
            await MeshLifecycleService.on_realm_deleting(realm_id, user_id);
        } catch (err) {
            log.warn('realm_remove_mesh_cleanup_failed', {
                realm_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        const members = await RealmMember.findAll({ where: { realm_id } });
        const original_slug = realm.slug;
        const ts = now_ms();

        // Revoke enroll tokens so the next heartbeat is 401.
        const token_repo = new TokenRepository();
        await token_repo.revoke_all_for_realm(realm_id);

        // Fire member_removed for every member (users + daemons), then detach.
        for (const member of members) {
            await emit_member_removed({
                realm_id,
                actor_id: user_id,
                member_type: member.member_type,
                member_id: member.member_id,
                reason: 'realm_deleted',
            });
        }

        const daemon_ids = members
            .filter((m) => m.member_type === 'daemon')
            .map((m) => m.member_id);
        if (daemon_ids.length > 0) {
            try {
                await Daemon.update(
                    { status: 'offline' },
                    { where: { id: { [Op.in]: daemon_ids } } },
                );
            } catch (err) {
                log.warn('realm_remove_daemon_offline_failed', {
                    realm_id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        await RealmMember.destroy({ where: { realm_id } });

        try {
            await new RealmAgentSettingRepository().remove_all_for_realm(realm_id);
        } catch (err) {
            log.warn('realm_remove_agent_settings_cleanup_failed', {
                realm_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // Free the slug so a new realm can reuse the name.
        const freed_slug = `${original_slug}.deleted.${realm.id.replace(/-/g, '').slice(0, 8)}`.slice(0, 63);
        realm.deleted = true;
        realm.deleted_at = ts;
        realm.slug = freed_slug;
        realm.updated_at = ts;
        await realm.save();

        // Clear default pointer if any user still pointed here.
        try {
            await User.update(
                { default_realm_id: null },
                { where: { default_realm_id: realm_id } },
            );
        } catch (err) {
            log.warn('realm_remove_clear_default_failed', {
                realm_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        try {
            await EventSubmitService.submit({
                type: 'realm.deleted',
                realm_id,
                actor_id: user_id,
                title: 'Realm deleted',
                message: `Realm '${original_slug}' was deleted`,
                payload: {
                    slug: original_slug,
                    name: realm.name,
                    deleted_at: ts,
                    soft_delete: true,
                },
            });
        } catch (err) {
            log.warn('realm_deleted_event_failed', {
                realm_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        log.info('realm_soft_deleted', {
            realm_id,
            slug: original_slug,
            actor_id: user_id,
            members_removed: members.length,
        });
    }

    /** Idempotent user membership (org join / on-demand realm invites). */
    static async upsert_user_member(
        realm_id: string,
        user_id: string,
        role: Realm_member_role = 'operator',
    ): Promise<void> {
        const existing = await RealmMember.findOne({
            where: { realm_id, member_type: 'user', member_id: user_id },
        });
        if (existing) {
            if (existing.role === 'admin' || existing.role === role) return;
            existing.role = role;
            await existing.save();
            return;
        }
        await RealmMember.create({
            id: randomUUID(),
            realm_id,
            member_type: 'user',
            member_id: user_id,
            role,
            created_at: now_ms(),
        });
    }

    /** Drop membership if present (org leave). */
    static async remove_member_silent(
        realm_id: string,
        member_type: Realm_member_type,
        member_id: string,
    ): Promise<void> {
        await RealmMember.destroy({ where: { realm_id, member_type, member_id } });
    }

    static async list_members(
        realm_id: string,
        user_id: string,
        member_type?: Realm_member_type,
    ): Promise<Realm_member_dto[]> {
        await RealmService.require_member_row(realm_id, user_id);
        return RealmService.list_members_unscoped(realm_id, member_type);
    }

    /** Internal: list members without membership gate (enroll ACL / sync). */
    static async list_members_unscoped(
        realm_id: string,
        member_type?: Realm_member_type,
    ): Promise<Realm_member_dto[]> {
        const where: Record<string, unknown> = { realm_id };
        if (member_type) where.member_type = member_type;
        const rows = await RealmMember.findAll({
            where,
            order: [['created_at', 'ASC']],
        });

        const user_ids = rows
            .filter((r) => r.member_type === 'user' && /^\d+$/.test(r.member_id))
            .map((r) => r.member_id);

        const username_map = new Map<string, string>();
        if (user_ids.length > 0) {
            const users = await User.findAll({
                where: { id: user_ids },
                attributes: ['id', 'username'],
                raw: true,
            });
            for (const u of users) {
                username_map.set(String(u.id), u.username);
            }
        }

        return rows.map((r) => to_member_dto(r, username_map.get(r.member_id)));
    }

    static async add_member(
        realm_id: string,
        actor_user_id: string,
        input: {
            member_type: Realm_member_type;
            member_id: string;
            role?: Realm_member_role;
        },
    ): Promise<Realm_member_dto> {
        await RealmService.require_admin(realm_id, actor_user_id);
        if (input.member_type !== 'user' && input.member_type !== 'daemon' && input.member_type !== 'group') {
            throw ApiError.bad_request(`Invalid member_type '${input.member_type}'`);
        }
        if (!input.member_id.trim()) throw ApiError.bad_request('member_id is required');

        const member_id = input.member_type === 'user'
            ? await RealmService.resolve_user_member_id(input.member_id)
            : input.member_id.trim();

        /** Resolve username for user members so the returned DTO is display-ready. */
        let username: string | null = null;
        if (input.member_type === 'user' && /^\d+$/.test(member_id)) {
            const u = await User.findByPk(member_id, { attributes: ['username'], raw: true });
            if (u) username = u.username;
        }

        const role: Realm_member_role = input.role ?? (input.member_type === 'user' ? 'operator' : 'member');
        const existing = await RealmMember.findOne({
            where: {
                realm_id,
                member_type: input.member_type,
                member_id,
            },
        });
        if (existing) {
            if (existing.role === role) return to_member_dto(existing, username);
            existing.role = role;
            await existing.save();
            return to_member_dto(existing, username);
        }

        const row = await RealmMember.create({
            id: randomUUID(),
            realm_id,
            member_type: input.member_type,
            member_id,
            role,
            created_at: now_ms(),
        });
        return to_member_dto(row, username);
    }

    /**
     * Canonical Hub user id string for realm_members.member_id.
     * Accepts UUID id, legacy numeric id, username, or @username.
     */
    static async resolve_user_member_id(raw: string): Promise<string> {
        const trimmed = raw.trim().replace(/^@+/, '');
        if (!trimmed) throw ApiError.bad_request('user is required');

        const uuid_re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuid_re.test(trimmed) || /^\d+$/.test(trimmed)) {
            const lookup_id = /^\d+$/.test(trimmed)
                ? (await import('../lib/hub_legacy_uuid.js')).hub_legacy_uuid(Number(trimmed))
                : trimmed;
            const by_id = await User.findByPk(lookup_id);
            if (!by_id) throw ApiError.not_found(`User '${trimmed}' not found`);
            return String(by_id.id);
        }

        const by_name = await User.findOne({
            where: { username: trimmed.toLowerCase() },
        });
        if (!by_name) throw ApiError.not_found(`User '@${trimmed.toLowerCase()}' not found`);
        return String(by_name.id);
    }

    static async remove_member(
        realm_id: string,
        actor_user_id: string,
        member_type: Realm_member_type,
        member_id: string,
    ): Promise<void> {
        await RealmService.require_admin(realm_id, actor_user_id);
        const resolved_id = member_type === 'user'
            ? await RealmService.resolve_user_member_id(member_id)
            : member_id.trim();
        if (member_type === 'user' && resolved_id === actor_user_id) {
            const admins = await RealmMember.count({
                where: { realm_id, member_type: 'user', role: 'admin' },
            });
            if (admins <= 1) {
                throw ApiError.bad_request('Cannot remove the last admin from a realm');
            }
        }

        const row = await RealmMember.findOne({
            where: { realm_id, member_type, member_id: resolved_id },
        });
        if (!row) throw ApiError.not_found('Member not found');
        await row.destroy();
        await emit_member_removed({
            realm_id,
            actor_id: actor_user_id,
            member_type,
            member_id: resolved_id,
            reason: 'manual',
        });
    }

    static async create_token(
        realm_id: string,
        user_id: string,
        name: string,
    ): Promise<Realm_token_created> {
        return RealmService.create_token_for_realms([realm_id], user_id, name);
    }

    /** Mint a daemon token granted to one or more realms (unified `tokens` table). */
    static async create_token_for_realms(
        realm_ids: string[],
        user_id: string,
        name: string,
        permissions_override?: Record<string, unknown>,
    ): Promise<Realm_token_created> {
        if (realm_ids.length === 0) {
            throw ApiError.bad_request('At least one realm is required');
        }
        for (const realm_id of realm_ids) {
            await RealmService.assert_member(realm_id, user_id);
        }
        const trimmed = name.trim();
        if (!trimmed) throw ApiError.bad_request('token name is required');

        const plaintext = mint_plaintext_token();
        const fallback = default_daemon_grant(realm_ids);
        const merged = permissions_override
            ? {
                domains: {
                    ...fallback.domains,
                    ...((permissions_override as unknown as Token_grant).domains ?? {}),
                    realms: realm_ids,
                },
                access: {
                    ...fallback.access,
                    ...((permissions_override as unknown as Token_grant).access ?? {}),
                },
            }
            : fallback;
        const permissions = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>;
        if (permissions_override?.auto_enrolled === true) {
            permissions.auto_enrolled = true;
        }
        const token_hash = hash_token(plaintext);
        const row = await ApiToken.create({
            id: randomUUID(),
            type: 'realm',
            user_id,
            name: trimmed,
            token_hash,
            token_prefix: token_hash.slice(0, 16),
            permissions,
            revoked_at: null,
        });
        return {
            ...to_token_dto(row as unknown as Parameters<typeof to_token_dto>[0], realm_ids[0]),
            token: plaintext,
        };
    }

    static async list_tokens(realm_id: string, user_id: string): Promise<Realm_token_dto[]> {
        await RealmService.require_admin(realm_id, user_id);
        const rows = await ApiToken.findAll({
            where: { type: 'realm' },
            order: [['created_at', 'DESC']],
        });
        return rows
            .filter((row) => {
                const realms = (row.permissions as Token_grant | undefined)?.domains?.realms;
                if (realms === '*') return true;
                return Array.isArray(realms) && realms.includes(realm_id);
            })
            .map((row) => to_token_dto(row as unknown as Parameters<typeof to_token_dto>[0], realm_id));
    }

    static async revoke_token(realm_id: string, user_id: string, token_id: string): Promise<void> {
        await RealmService.require_admin(realm_id, user_id);
        const row = await ApiToken.findOne({ where: { id: token_id, type: 'realm' } });
        if (!row) throw ApiError.not_found('Token not found');
        const grant = row.permissions as Token_grant;
        const realms = grant?.domains?.realms;
        const allows = realms === '*'
            || (Array.isArray(realms) && realms.includes(realm_id));
        if (!allows) throw ApiError.not_found('Token not found');
        if (row.revoked_at) return;
        row.revoked_at = new Date();
        await row.save();
    }

    /** Resolve a plaintext realm/daemon token (daemon enroll / Hub auth). */
    static async resolve_token(plaintext: string): Promise<{
        token_id: string;
        realm_id: string;
        created_by: string;
        permissions: Record<string, unknown>;
    }> {
        if (!plaintext.startsWith(TOKEN_PREFIX)) {
            throw ApiError.unauthorized('Invalid realm token');
        }
        const token_hash = hash_token(plaintext);
        const row = await ApiToken.findOne({
            where: {
                token_hash,
                type: { [Op.in]: ['realm', 'daemon'] },
            },
        });
        if (!row || row.revoked_at) {
            throw ApiError.unauthorized('Invalid or revoked realm token');
        }
        const permissions = (row.permissions as Record<string, unknown>) ?? {};
        return {
            token_id: row.id,
            realm_id: primary_realm_id(permissions),
            created_by: String(row.user_id),
            permissions,
        };
    }

    static is_daemon_token(plaintext: string): boolean {
        return plaintext.startsWith(TOKEN_PREFIX);
    }

    /** Bind a daemon into a realm (idempotent). */
    static async upsert_daemon_member(realm_id: string, daemon_id: string): Promise<void> {
        const existing = await RealmMember.findOne({
            where: { realm_id, member_type: 'daemon', member_id: daemon_id },
        });
        if (existing) return;
        await RealmMember.create({
            id: randomUUID(),
            realm_id,
            member_type: 'daemon',
            member_id: daemon_id,
            role: 'member',
            created_at: now_ms(),
        });
    }

    /**
     * Bind a daemon to exactly one realm (enroll/register move semantics).
     * Removes memberships in any other realms so a token switch does not
     * leave the daemon visible in both places.
     * @returns realm ids the daemon left
     */
    static async bind_daemon_to_realm(realm_id: string, daemon_id: string): Promise<string[]> {
        const existing = await RealmMember.findAll({
            where: { member_type: 'daemon', member_id: daemon_id },
            attributes: ['id', 'realm_id'],
        });
        const left = existing
            .map((row) => row.realm_id)
            .filter((id) => id !== realm_id);

        if (left.length > 0) {
            await RealmMember.destroy({
                where: {
                    member_type: 'daemon',
                    member_id: daemon_id,
                    realm_id: { [Op.in]: left },
                },
            });
            log.info(
                `daemon moved: ${daemon_id} → realm=${realm_id} left=[${left.join(',')}]`,
            );
        }

        await RealmService.upsert_daemon_member(realm_id, daemon_id);
        return left;
    }

    /** Realm ids where this user is a member. */
    static async list_realm_ids_for_user(user_id: string): Promise<string[]> {
        const rows = await RealmMember.findAll({
            where: { member_type: 'user', member_id: user_id },
            attributes: ['realm_id'],
        });
        return rows.map((r) => r.realm_id);
    }

    /**
     * Realm ids where this user is a member AND the realm belongs to
     * the given org. Used by list endpoints that must respect the
     * X-Org-Id header (dashboard runs list, etc). Two queries by
     * design — the user's realm-membership set is usually small and
     * we don't want to build a JOIN policy on the members table.
     */
    static async list_realm_ids_for_user_in_org(
        user_id: string,
        org_id: string,
    ): Promise<string[]> {
        const member_realm_ids = await RealmService.list_realm_ids_for_user(user_id);
        if (member_realm_ids.length === 0) return [];
        const rows = await Realm.findAll({
            where: { id: { [Op.in]: member_realm_ids }, org_id, ...ALIVE },
            attributes: ['id'],
        });
        return rows.map((r) => r.id);
    }

    /** Daemon ids that share at least one realm with the user. */
    static async list_daemon_ids_for_user(user_id: string): Promise<string[]> {
        const realm_ids = await RealmService.list_realm_ids_for_user(user_id);
        if (realm_ids.length === 0) return [];
        const rows = await RealmMember.findAll({
            where: {
                member_type: 'daemon',
                realm_id: { [Op.in]: realm_ids },
            },
            attributes: ['member_id'],
        });
        return [...new Set(rows.map((r) => r.member_id))];
    }

    /** Daemon ids visible to a user within a specific org boundary. */
    static async list_daemon_ids_for_user_in_org(
        user_id: string,
        org_id: string,
    ): Promise<string[]> {
        const realm_ids = await RealmService.list_realm_ids_for_user_in_org(user_id, org_id);
        if (realm_ids.length === 0) return [];
        const rows = await RealmMember.findAll({
            where: {
                member_type: 'daemon',
                realm_id: { [Op.in]: realm_ids },
            },
            attributes: ['member_id'],
        });
        return [...new Set(rows.map((r) => r.member_id))];
    }

    static async assert_user_can_access_daemon(
        user_id: string,
        daemon_id: string,
        opts?: { site_admin?: boolean },
    ): Promise<void> {
        if (opts?.site_admin) return;
        const ids = await RealmService.list_daemon_ids_for_user(user_id);
        if (ids.includes(daemon_id)) return;
        throw ApiError.forbidden(`Daemon '${daemon_id}' is not in any of your realms`);
    }

    static async assert_daemon_in_realm(realm_id: string, daemon_id: string): Promise<void> {
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) {
            throw ApiError.forbidden(`Daemon '${daemon_id}' is not a member of this realm`);
        }
        const row = await RealmMember.findOne({
            where: { realm_id, member_type: 'daemon', member_id: daemon_id },
        });
        if (row) return;
        throw ApiError.forbidden(`Daemon '${daemon_id}' is not a member of this realm`);
    }

    /** Online daemon members of a realm the user belongs to (for install fan-out). */
    static async list_online_daemon_ids_in_realm(
        realm_id: string,
        user_id: string,
    ): Promise<string[]> {
        await RealmService.require_member_row(realm_id, user_id);
        const members = await RealmMember.findAll({
            where: { realm_id, member_type: 'daemon' },
            attributes: ['member_id'],
        });
        if (members.length === 0) return [];

        const online = await Daemon.findAll({
            where: {
                id: { [Op.in]: members.map((m) => m.member_id) },
                status: 'online',
            },
            attributes: ['id'],
            order: [['last_heartbeat', 'DESC']],
        });
        return online.map((d) => d.id);
    }

    private static async ensure_user_admin(realm_id: string, user_id: string): Promise<void> {
        const existing = await RealmMember.findOne({
            where: { realm_id, member_type: 'user', member_id: user_id },
        });
        if (existing) {
            if (existing.role === 'admin') return;
            existing.role = 'admin';
            await existing.save();
            return;
        }
        await RealmMember.create({
            id: randomUUID(),
            realm_id,
            member_type: 'user',
            member_id: user_id,
            role: 'admin',
            created_at: now_ms(),
        });
    }

    private static async require_member(realm_id: string, user_id: string): Promise<RealmModel> {
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) throw ApiError.not_found(`Realm '${realm_id}' not found`);
        await RealmService.require_member_row(realm_id, user_id);
        return realm;
    }

    private static async require_member_row(realm_id: string, user_id: string): Promise<RealmMemberModel> {
        const row = await RealmMember.findOne({
            where: { realm_id, member_type: 'user', member_id: user_id },
        });
        if (!row) throw ApiError.forbidden('Not a member of this realm');
        return row;
    }

    /** Public membership check for cross-service AuthZ (e.g. notification bindings). */
    static async assert_member(realm_id: string, user_id: string): Promise<void> {
        await RealmService.require_member_row(realm_id, user_id);
    }

    static async require_admin(realm_id: string, user_id: string): Promise<void> {
        const row = await RealmService.require_member_row(realm_id, user_id);
        if (row.role === 'admin') return;
        throw ApiError.forbidden('Realm admin role required');
    }

    /** Search Hub users by handle / email / name; exclude current realm members. */
    static async search_users(
        realm_id: string,
        actor_user_id: string,
        query: string,
        limit = 20,
    ): Promise<Array<{ id: string; username: string; display_name: string; email: string }>> {
        await RealmService.require_admin(realm_id, actor_user_id);

        const q = query.trim().replace(/^@+/, '');
        if (q.length < 2) return [];

        const members = await RealmMember.findAll({
            where: { realm_id, member_type: 'user' },
            attributes: ['member_id'],
        });
        const member_ids = members
            .map((m) => String(m.member_id))
            .filter((id) => id.length > 0);

        const pattern = `%${escape_like(q)}%`;
        const where: Record<string, unknown> = {
            suspended_at: null,
            [Op.or]: [
                { username: { [Op.iLike]: pattern } },
                { email: { [Op.iLike]: pattern } },
                { display_name: { [Op.iLike]: pattern } },
            ],
        };
        if (member_ids.length > 0) {
            where.id = { [Op.notIn]: member_ids };
        }

        const users = await User.findAll({
            where,
            attributes: ['id', 'username', 'display_name', 'email'],
            order: [['username', 'ASC']],
            limit: Math.min(limit, 50),
            raw: true,
        });

        return users.map((u) => ({
            id: u.id,
            username: u.username,
            display_name: u.display_name,
            email: u.email,
        }));
    }

    static async create_invite(
        realm_id: string,
        actor_user_id: string,
        params: { email: string; role?: Realm_member_role },
    ): Promise<
        | { status: 'added'; user_id: string; username: string; role: Realm_member_role }
        | {
            status: 'pending';
            invite_id: string;
            email: string;
            role: Realm_member_role;
            expires_at: string;
            token: string;
        }
    > {
        await RealmService.require_admin(realm_id, actor_user_id);

        const email = params.email.trim().toLowerCase();
        if (!EMAIL_PATTERN.test(email)) {
            throw ApiError.bad_request('Invalid email address');
        }

        const role: Realm_member_role = params.role ?? 'member';
        const existing = await User.findOne({
            where: { email },
            attributes: ['id', 'username'],
            raw: true,
        });
        if (existing) {
            await RealmService.add_member(realm_id, actor_user_id, {
                member_type: 'user',
                member_id: String(existing.id),
                role,
            });
            return {
                status: 'added',
                user_id: existing.id,
                username: existing.username,
                role,
            };
        }

        const pending = await RealmInvite.findOne({
            where: { realm_id, email, status: 'pending' },
            attributes: ['id'],
            raw: true,
        });
        if (pending) {
            throw ApiError.conflict('A pending invite already exists for that email');
        }

        const token = randomBytes(32).toString('hex');
        const expires_at = new Date(Date.now() + INVITE_TTL_MS);
        const invite = await RealmInvite.create({
            realm_id,
            email,
            invited_by: actor_user_id,
            token_hash: hash_invite_token(token),
            role,
            status: 'pending',
            expires_at,
        });

        return {
            status: 'pending',
            invite_id: invite.id,
            email,
            role,
            expires_at: expires_at.toISOString(),
            token,
        };
    }

    static async list_invites(
        realm_id: string,
        actor_user_id: string,
    ): Promise<Array<{
        id: string;
        email: string;
        role: string;
        invited_by: string;
        created_at: string;
        expires_at: string;
    }>> {
        await RealmService.require_admin(realm_id, actor_user_id);

        const invites = await RealmInvite.findAll({
            where: { realm_id, status: 'pending' },
            attributes: ['id', 'email', 'role', 'created_at', 'expires_at', 'invited_by'],
            order: [['created_at', 'DESC']],
            raw: true,
        });

        return invites.map((row) => ({
            id: row.id,
            email: row.email,
            role: row.role,
            invited_by: row.invited_by,
            created_at: row.created_at instanceof Date
                ? row.created_at.toISOString()
                : String(row.created_at),
            expires_at: row.expires_at instanceof Date
                ? row.expires_at.toISOString()
                : String(row.expires_at),
        }));
    }

    static async revoke_invite(
        invite_id: string,
        actor_user_id: string,
    ): Promise<void> {
        const invite = await RealmInvite.findByPk(invite_id, {
            attributes: ['id', 'realm_id', 'status'],
            raw: true,
        });
        if (!invite) throw ApiError.not_found('Invite not found');
        await RealmService.require_admin(invite.realm_id, actor_user_id);
        if (invite.status !== 'pending') {
            throw ApiError.conflict('Invite is not pending');
        }
        await RealmInvite.update({ status: 'revoked' }, { where: { id: invite.id } });
    }

    static async get_invite_by_token(token: string): Promise<{
        email: string;
        role: string;
        realm_id: string;
        realm_slug: string;
        realm_name: string;
        expires_at: string;
    }> {
        const invite = await RealmService._load_pending_invite(token);
        const realm = await Realm.findByPk(invite.realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');

        return {
            email: invite.email,
            role: invite.role,
            realm_id: realm.id,
            realm_slug: realm.slug,
            realm_name: realm.name,
            expires_at: invite.expires_at instanceof Date
                ? invite.expires_at.toISOString()
                : String(invite.expires_at),
        };
    }

    /** Accept a realm invite while signed in (email must match). */
    static async accept_invite(
        token: string,
        actor_user_id: string,
        actor_email: string,
    ): Promise<{
        accepted: true;
        realm_id: string;
        realm_slug: string;
        user_id: string;
        role: Realm_member_role;
    }> {
        const invite = await RealmService._load_pending_invite(token);
        if (actor_email.trim().toLowerCase() !== invite.email) {
            throw ApiError.forbidden('Signed-in email does not match this invite');
        }

        const realm = await Realm.findByPk(invite.realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');

        const role = invite.role as Realm_member_role;
        await RealmService.upsert_user_member(invite.realm_id, actor_user_id, role);

        await RealmInvite.update(
            {
                status: 'accepted',
                accepted_at: new Date(),
                accepted_user_id: String(actor_user_id),
            },
            { where: { id: invite.id } },
        );

        return {
            accepted: true,
            realm_id: realm.id,
            realm_slug: realm.slug,
            user_id: String(actor_user_id),
            role,
        };
    }

    private static async _load_pending_invite(token: string) {
        const trimmed = token.trim();
        if (!trimmed) throw ApiError.bad_request('token is required');

        const invite = await RealmInvite.findOne({
            where: { token_hash: hash_invite_token(trimmed), status: 'pending' },
            raw: true,
        });
        if (!invite) throw ApiError.not_found('Invite not found');

        const expires_at = invite.expires_at instanceof Date
            ? invite.expires_at
            : new Date(invite.expires_at);
        if (expires_at.getTime() < Date.now()) {
            await RealmInvite.update({ status: 'revoked' }, { where: { id: invite.id } });
            throw ApiError.conflict('Invite has expired');
        }

        return invite;
    }

    // ─── Team coverage (realm-scoped installed teams) ──────────────────

    /**
     * Return teams installed on daemons in this realm, aggregated by
     * scope/slug with coverage stats, with server-side search, filter,
     * sort, and pagination. Powers the realm Teams tab.
     */
    static async list_team_coverage(
        params: {
            realm_id: string;
            query?: string;
            origin?: 'published' | 'local';
            coverage?: 'full' | 'partial' | 'none';
            sort_by?: 'team' | 'origin' | 'coverage';
            sort_dir?: 'asc' | 'desc';
            limit?: number;
            offset?: number;
        },
        user_id: string,
    ): Promise<{
        rows: Array<{
            scope: string;
            slug: string;
            label: string;
            installed_daemon_ids: string[];
            installed_count: number;
            online_daemon_count: number;
            coverage_label: string;
            version: string | null;
            sample_team_id: string | null;
            origin: 'published' | 'local';
            in_team_list: boolean;
            last_run_at: number | null;
            /** Agent names referenced by this team's workflow that are not registered in the org. */
            missing_agents: string[];
        }>;
        total: number;
        online_daemon_count: number;
    }> {
        await RealmService.assert_member(params.realm_id, user_id);

        // Realm + team-list.
        const realm = await Realm.findByPk(params.realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');
        const team_list_set = new Set(
            (((realm as unknown as { team_list?: Array<{ scope: string; slug: string }> })
                .team_list) ?? []).map((e) => `${e.scope}/${e.slug}`),
        );

        // Daemons in realm — online count is the denominator for coverage.
        // Even with zero daemons we still surface realm.team_list rows below
        // (coverage 0/0) so a freshly created realm is not an empty table.
        const daemon_ids = await RealmService.list_daemon_ids_in_realm(params.realm_id);
        const daemons = daemon_ids.length === 0
            ? []
            : await Daemon.findAll({
                where: { id: { [Op.in]: daemon_ids } },
                attributes: ['id', 'status'],
                raw: true,
            }) as unknown as Array<{ id: string; status: string }>;
        const online_daemon_ids = new Set(daemons.filter((d) => d.status === 'online').map((d) => d.id));
        const online_daemon_count = online_daemon_ids.size;

        // Team coverage in a realm is the UNION of any team the realm's
        // daemons touch:
        //   (A) control-plane installs — teams.daemon_id ∈ realm daemons
        //   (B) runs — team_runs.daemon_id ∈ realm daemons (team may be
        //       registry-owned, i.e. teams.daemon_id NULL, but the run still
        //       proves the team is "in use" on this daemon)
        //   (C) assembled workspaces — workspace_teams for a workspace whose
        //       daemon_id ∈ realm daemons
        // For each source we credit the referring daemon_id as "installed"
        // for coverage math, then look the team records up by id.

        // (team_id → daemons that have it INSTALLED right now)
        // Only source (A) counts toward coverage numerator.
        const team_daemons: Map<string, Set<string>> = new Map();
        const _add_installed = (team_id: string | null | undefined, did: string | null | undefined) => {
            if (!team_id || !did) return;
            let set = team_daemons.get(team_id);
            if (!set) {
                set = new Set<string>();
                team_daemons.set(team_id, set);
            }
            set.add(did);
        };

        // (A) Control-plane installs — the ONLY source for the teams list.
        if (daemon_ids.length > 0) {
            const cp_teams = await Team.findAll({
                where: { daemon_id: { [Op.in]: daemon_ids } },
                attributes: ['id', 'daemon_id'],
                raw: true,
            }) as unknown as Array<{ id: string; daemon_id: string | null }>;
            for (const t of cp_teams) _add_installed(t.id, t.daemon_id);
        }

        // Fetch team records (with scope) for every id we care about.
        type Agg = {
            scope: string;
            slug: string;
            installed_daemon_ids: Set<string>;
            version: string | null;
            sample_team_id: string | null;
        };
        const agg: Map<string, Agg> = new Map();
        const all_team_ids = [...team_daemons.keys()];
        if (all_team_ids.length > 0) {
            const team_records = await Team.findAll({
                where: { id: { [Op.in]: all_team_ids } },
                include: [{ model: Scope, as: 'scope', attributes: ['slug'] }],
            });
            for (const t of team_records) {
                const plain = t.toJSON() as unknown as {
                    id: string;
                    slug: string;
                    version: string | null;
                    scope?: { slug: string };
                };
                const scope = plain.scope?.slug ?? '';
                const slug = plain.slug ?? '';
                if (!scope || !slug) continue;
                const key = `${scope}/${slug}`;
                let row = agg.get(key);
                if (!row) {
                    row = {
                        scope, slug,
                        installed_daemon_ids: new Set<string>(),
                        version: plain.version ?? null,
                        sample_team_id: plain.id ?? null,
                    };
                    agg.set(key, row);
                }
                const daemons_for_team = team_daemons.get(plain.id);
                if (daemons_for_team) {
                    for (const d of daemons_for_team) row.installed_daemon_ids.add(d);
                }
                if (!row.version && plain.version) row.version = plain.version;
                if (!row.sample_team_id && plain.id) row.sample_team_id = plain.id;
            }
        }

        // Fold in realm.team_list declarations even if no daemon has yet
        // installed/run/assembled them — the realm has declared these teams
        // as part of its fleet, so the UI should show them (with coverage 0).
        for (const key of team_list_set) {
            if (agg.has(key)) continue;
            const [scope, slug] = key.split('/', 2);
            if (!scope || !slug) continue;
            agg.set(key, {
                scope,
                slug,
                installed_daemon_ids: new Set<string>(),
                version: null,
                sample_team_id: null,
            });
        }

        // Bulk registry lookup — one query for all (scope, name) pairs. Used
        // to classify origin (published vs. local) on the row.
        let published_set = new Set<string>();
        if (agg.size > 0) {
            const pairs = [...agg.values()].map((r) => ({ scope: r.scope, name: r.slug }));
            const published_rows = await RegistryTeam.findAll({
                where: { [Op.or]: pairs.map((p) => ({ scope: p.scope, name: p.name })) },
                attributes: ['scope', 'name'],
                raw: true,
            }) as unknown as Array<{ scope: string; name: string }>;
            published_set = new Set(published_rows.map((r) => `${r.scope}/${r.name}`));
        }

        // Last run timestamp per team — MAX(started_at) grouped by team_id.
        const last_run_map = new Map<string, number>();
        if (all_team_ids.length > 0 && daemon_ids.length > 0) {
            try {
                const last_runs = await Run.findAll({
                    where: {
                        team_id: { [Op.in]: all_team_ids },
                        daemon_id: { [Op.in]: daemon_ids },
                    },
                    attributes: [
                        'team_id',
                        [fn('MAX', col('started_at')), 'last_started_at'],
                    ],
                    group: ['team_id'],
                    raw: true,
                }) as unknown as Array<{ team_id: string; last_started_at: number | null }>;
                for (const r of last_runs) {
                    if (r.last_started_at) last_run_map.set(r.team_id, r.last_started_at);
                }
            } catch {
                // Run table may not exist in local/dev environments without sync.
            }
        }

        // ── Missing agent detection ────────────────────────────────
        // For each team, extract agent names from the latest published
        // workflow and check against the org's agent_catalog.
        const missing_agents_map = new Map<string, string[]>();
        try {
            const org_id = realm?.org_id;
            if (org_id && published_set.size > 0) {
                // Batch-fetch registry team ids for all published teams.
                const registry_rows = await RegistryTeam.findAll({
                    where: {
                        [Op.or]: [...published_set].map((k) => {
                            const [scope, name] = k.split('/', 2);
                            return { scope, name };
                        }),
                    },
                    attributes: ['id', 'scope', 'name'],
                    raw: true,
                }) as unknown as Array<{ id: string; scope: string; name: string }>;

                const registry_id_to_key = new Map<string, string>();
                const registry_ids: string[] = [];
                for (const r of registry_rows) {
                    registry_id_to_key.set(r.id, `${r.scope}/${r.name}`);
                    registry_ids.push(r.id);
                }

                // Fetch all versions for these teams in one query.
                if (registry_ids.length > 0) {
                    const all_versions = await TeamVersion.findAll({
                        where: { team_id: { [Op.in]: registry_ids } },
                        attributes: ['team_id', 'version', 'workflow_json'],
                        raw: true,
                    });

                    // Group by team_id, pick latest version's workflow.
                    const by_team = new Map<string, typeof all_versions>();
                    for (const v of all_versions) {
                        let arr = by_team.get(v.team_id);
                        if (!arr) { arr = []; by_team.set(v.team_id, arr); }
                        arr.push(v);
                    }

                    // Collect all unique agent names across all teams.
                    const all_agent_names = new Set<string>();
                    const team_agents = new Map<string, Set<string>>();

                    for (const [team_id, versions] of by_team) {
                        const latest_ver = max_semver(versions.map((v) => v.version));
                        const target = latest_ver
                            ? versions.find((v) => v.version === latest_ver)
                            : versions[0];
                        if (!target) continue;

                        const refs = extract_agents_from_workflow(target.workflow_json);
                        const names = new Set<string>();
                        for (const ref of refs) {
                            const name = parse_agent_ref(ref).name;
                            names.add(name);
                            all_agent_names.add(name);
                        }
                        const key = registry_id_to_key.get(team_id);
                        if (key) team_agents.set(key, names);
                    }

                    // One bulk query: which of these agent names are registered?
                    if (all_agent_names.size > 0) {
                        const registered_rows = await AgentCatalog.findAll({
                            where: {
                                name: { [Op.in]: [...all_agent_names] },
                                deleted: false,
                                [Op.or]: [{ org_id }, { is_system: true }],
                            },
                            attributes: ['name'],
                            raw: true,
                        });
                        const registered_names = new Set(registered_rows.map((r) => r.name));

                        for (const [key, agents] of team_agents) {
                            const missing = [...agents].filter((n) => !registered_names.has(n));
                            if (missing.length > 0) missing_agents_map.set(key, missing);
                        }
                    }
                }
            }
        } catch {
            // Best-effort — missing agent detection should never block coverage.
        }

        // Materialise coverage rows.
        let rows = [...agg.values()].map((r) => {
            const installed_count = [...r.installed_daemon_ids].filter((id) => online_daemon_ids.has(id)).length;
            const key = `${r.scope}/${r.slug}`;
            const origin: 'published' | 'local' = published_set.has(key) ? 'published' : 'local';
            const coverage_label = _coverage_label(installed_count, online_daemon_count);
            const last_run_at = r.sample_team_id ? (last_run_map.get(r.sample_team_id) ?? null) : null;
            return {
                scope: r.scope,
                slug: r.slug,
                label: `@${r.scope}/${r.slug}`,
                installed_daemon_ids: [...r.installed_daemon_ids],
                installed_count,
                online_daemon_count,
                coverage_label,
                version: r.version,
                sample_team_id: r.sample_team_id,
                origin,
                in_team_list: team_list_set.has(key),
                last_run_at,
                missing_agents: missing_agents_map.get(key) ?? [],
            };
        });

        // Query filter (substring, case-insensitive over label).
        const q = (params.query ?? '').trim().toLowerCase();
        if (q) rows = rows.filter((r) => r.label.toLowerCase().includes(q));

        // Origin filter.
        if (params.origin) rows = rows.filter((r) => r.origin === params.origin);

        // Coverage filter.
        if (params.coverage) {
            rows = rows.filter((r) => {
                if (params.coverage === 'full') {
                    return r.online_daemon_count > 0 && r.installed_count >= r.online_daemon_count;
                }
                if (params.coverage === 'partial') {
                    return r.installed_count > 0 && r.installed_count < r.online_daemon_count;
                }
                // 'none'
                return r.online_daemon_count === 0 || r.installed_count === 0;
            });
        }

        // Sort.
        const dir = params.sort_dir === 'desc' ? -1 : 1;
        const sort_by = params.sort_by ?? 'team';
        rows.sort((a, b) => {
            if (sort_by === 'origin') return a.origin.localeCompare(b.origin) * dir;
            if (sort_by === 'coverage') {
                const sa = a.online_daemon_count > 0 ? a.installed_count / a.online_daemon_count : -1;
                const sb = b.online_daemon_count > 0 ? b.installed_count / b.online_daemon_count : -1;
                return (sa - sb) * dir;
            }
            return a.label.localeCompare(b.label) * dir;
        });

        // Paginate.
        const total = rows.length;
        const offset = Math.max(0, params.offset ?? 0);
        const limit = Math.min(Math.max(1, params.limit ?? 50), 200);
        const paginated = rows.slice(offset, offset + limit);

        return { rows: paginated, total, online_daemon_count };
    }
}

function _coverage_label(installed: number, online: number): string {
    return `${installed}/${online}`;
}
