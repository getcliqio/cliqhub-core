import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Op } from 'sequelize';

import { Daemon } from '../models/index.js';
import { get_logger } from '../lib/log.js';
import { default_daemon_grant } from '../auth/grants.js';
import { RealmService } from './realm.service.js';
import { RealmDispatchKeyService } from './realm_dispatch_key.service.js';
import { RealmTeamListService } from './realm_team_list.service.js';

const log = get_logger('daemon-service');

export type DaemonStatus = 'online' | 'stale' | 'offline' | 'removed';

const STALE_THRESHOLD_MS = 90_000;
const DEREGISTER_THRESHOLD_MS = 3_600_000; // 1 hour — auto-remove expired daemons

export interface DaemonAclBundle {
    realm_id: string;
    allowed: string[];
    dispatch_public_key: string;
}

export interface DaemonRegistrationResult {
    daemon_id: string;
    name: string | null;
    user_id: string;
    user_email: string;
    hostname: string | null;
    ip: string | null;
    port: number | null;
    public_url: string | null;
    status: DaemonStatus;
    created_at: number;
    last_registered_at: number;
    /** Enroll bundle — realm + ACL principals + dispatch public key. */
    realm_id?: string;
    acl?: DaemonAclBundle;
    dispatch_public_key?: string;
}

export interface DaemonRegistrationPayload {
    /** Verified Hub identity (from req.auth — not decoded from the token). */
    user_id: string;
    user_email: string;
    /** Realm the registering token belongs to — daemon is bound here. */
    realm_id: string;
    /** Grant copied from the realm token (or default daemon grant). */
    permissions?: Record<string, unknown>;
    daemon_id?: string;
    hostname?: string;
    ip?: string;
    port?: number;
    public_url?: string;
    /** Optional user-friendly display name for the daemon. */
    name?: string;
}

export interface DaemonRealmInfo {
    id: string;
    slug: string;
    name: string;
    role: string;
}

export interface DaemonInfo {
    id: string;
    name: string | null;
    user_id: string | null;
    user_email: string | null;
    hostname: string | null;
    ip: string | null;
    port: number | null;
    public_url: string | null;
    status: DaemonStatus;
    last_heartbeat: number | null;
    capacity: number;
    created_at: number;
    last_registered_at: number;
    /** Enroll-token grant copied onto the daemon row (domains + access). */
    permissions: Record<string, unknown>;
    /** Realm memberships (grant/revoke), separate from token domains. */
    realms: DaemonRealmInfo[];
}

function hash_key(api_key: string): string {
    return createHash('sha256').update(api_key).digest('hex');
}

/** Normalize public_url for logical-runtime coalescing (strip trailing slash). */
export function normalize_public_url(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

function compute_base_url(d: Daemon): string | null {
    if (d.public_url) return d.public_url;
    if (d.ip && d.port) return `http://${d.ip}:${d.port}`;
    if (d.hostname && d.port) return `http://${d.hostname}:${d.port}`;
    return null;
}

function to_registration_result(existing: Daemon): DaemonRegistrationResult {
    return {
        daemon_id: existing.id,
        name: (existing as any).name ?? null,
        user_id: existing.user_id ?? '',
        user_email: existing.user_email ?? '',
        hostname: existing.hostname,
        ip: existing.ip,
        port: existing.port,
        public_url: existing.public_url,
        status: existing.status,
        created_at: existing.created_at,
        last_registered_at: existing.last_registered_at,
    };
}

/** ACL + dispatch key for a realm (used at register and ACL refresh). */
export async function build_daemon_acl_bundle(realm_id: string): Promise<DaemonAclBundle> {
    const members = await RealmService.list_members_unscoped(realm_id, 'user');
    const allowed = members.map((m) => m.member_id);
    const key = await RealmDispatchKeyService.get_or_create_public_key(realm_id);
    return {
        realm_id,
        allowed,
        dispatch_public_key: key.public_key_pem,
    };
}

async function with_enroll_bundle(
    result: DaemonRegistrationResult,
    realm_id: string,
): Promise<DaemonRegistrationResult> {
    const acl = await build_daemon_acl_bundle(realm_id);
    return {
        ...result,
        realm_id,
        acl,
        dispatch_public_key: acl.dispatch_public_key,
    };
}

async function refresh_daemon(
    existing: Daemon,
    key_hash: string,
    token_info: { user_id: string; email: string },
    payload: DaemonRegistrationPayload,
    now: number,
): Promise<DaemonRegistrationResult> {
    existing.last_registered_at = now;
    existing.last_heartbeat = now;
    existing.api_key_hash = key_hash;
    existing.user_id = token_info.user_id;
    existing.user_email = token_info.email;
    existing.hostname = payload.hostname ?? existing.hostname;
    existing.ip = payload.ip ?? existing.ip;
    existing.port = payload.port ?? existing.port;
    if (payload.name !== undefined) {
        existing.name = payload.name;
    }
    if (payload.public_url !== undefined) {
        existing.public_url = payload.public_url
            ? normalize_public_url(payload.public_url)
            : existing.public_url;
    }
    existing.status = 'online';
    // Re-enroll always replaces grant so a realm-token switch does not leave
    // the old domains.realms / ACL on the row.
    (existing as Daemon & { permissions: Record<string, unknown> }).permissions =
        resolve_enroll_permissions(payload);
    await existing.save();
    log.info(`daemon re-registered: ${existing.id}`);
    return to_registration_result(existing);
}

function resolve_enroll_permissions(
    payload: DaemonRegistrationPayload,
): Record<string, unknown> {
    if (payload.permissions && Object.keys(payload.permissions).length > 0) {
        return payload.permissions;
    }
    return default_daemon_grant(payload.realm_id) as unknown as Record<string, unknown>;
}

/**
 * Postgres returns BIGINT as string by default (pg node driver dodges the
 * 2^53 precision cliff). Sequelize's `number | null` type on the model
 * lies about that. Callers (UI clients, tests) rely on numbers — the
 * realm daemons page silently rendered "never" for every daemon because
 * `typeof last_heartbeat === 'number'` was false for the string value.
 * Coerce here so every downstream consumer gets what the type promises.
 */
function _to_ms(value: number | string | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function to_info(d: Daemon): DaemonInfo {
    const perms = (d as Daemon & { permissions?: Record<string, unknown> }).permissions ?? {};
    return {
        id: d.id,
        name: d.name ?? null,
        user_id: d.user_id,
        user_email: d.user_email,
        hostname: d.hostname,
        ip: d.ip,
        port: d.port,
        public_url: d.public_url ?? compute_base_url(d),
        status: d.status,
        last_heartbeat: _to_ms(d.last_heartbeat),
        capacity: d.capacity,
        created_at: _to_ms(d.created_at) ?? 0,
        last_registered_at: _to_ms(d.last_registered_at) ?? 0,
        permissions: perms,
        realms: [],
    };
}

async function with_realms(infos: DaemonInfo[]): Promise<DaemonInfo[]> {
    if (infos.length === 0) return infos;
    const by_daemon = await RealmService.list_realms_by_daemon_ids(infos.map((i) => i.id));
    return infos.map((info) => ({
        ...info,
        realms: by_daemon.get(info.id) ?? [],
    }));
}

export class DaemonService {
    /**
     * Register/refresh a daemon. Identity must already be Hub-verified
     * (`payload.user_id` / `user_email` from `req.auth`).
     */
    static async register(api_key: string, payload: DaemonRegistrationPayload): Promise<DaemonRegistrationResult> {
        const token_info = { user_id: payload.user_id, email: payload.user_email };
        const key_hash = hash_key(api_key);
        const now = Date.now();
        const normalized_url = payload.public_url
            ? normalize_public_url(payload.public_url)
            : null;

        let result: DaemonRegistrationResult;

        // Sticky id (laptop / CLIQ_DAEMON_ID) — reuse row if present,
        // otherwise create a NEW row with this exact id below. We do
        // NOT fall through to URL-coalesce when a sticky id is provided —
        // that would silently rebind the caller to some other daemon's
        // row (e.g. an old zombie sharing `http://127.0.0.1:4900`) and
        // then `adopt_id` on the client would overwrite settings.json,
        // orphaning every historical run keyed to the sticky id.
        if (payload.daemon_id) {
            const existing = await Daemon.findByPk(payload.daemon_id);
            if (existing) {
                const refreshed = await refresh_daemon(existing, key_hash, token_info, {
                    ...payload,
                    public_url: normalized_url ?? payload.public_url,
                }, now);
                await RealmService.bind_daemon_to_realm(payload.realm_id, refreshed.daemon_id);
                result = await with_enroll_bundle(refreshed, payload.realm_id);
                // inject_for_daemon also uninstalls teams not on the new realm list
                void DaemonService._inject_team_list(payload.realm_id, refreshed.daemon_id, token_info.user_id);
                return result;
            }
        }

        // Only when the caller has no sticky id do we coalesce logical
        // runtime pods sharing the same Ingress public_url.
        if (!payload.daemon_id && normalized_url) {
            const by_url = await Daemon.findOne({
                where: { public_url: normalized_url },
                order: [['last_heartbeat', 'DESC']],
            });
            if (by_url) {
                const refreshed = await refresh_daemon(by_url, key_hash, token_info, {
                    ...payload,
                    public_url: normalized_url,
                }, now);
                await RealmService.bind_daemon_to_realm(payload.realm_id, refreshed.daemon_id);
                result = await with_enroll_bundle(refreshed, payload.realm_id);
                void DaemonService._inject_team_list(payload.realm_id, refreshed.daemon_id, token_info.user_id);
                return result;
            }
        }

        const daemon_id = payload.daemon_id ?? randomUUID();
        await Daemon.create({
            id: daemon_id,
            api_key_hash: key_hash,
            user_id: token_info.user_id,
            user_email: token_info.email,
            hostname: payload.hostname ?? null,
            ip: payload.ip ?? null,
            port: payload.port ?? null,
            public_url: normalized_url,
            name: payload.name ?? null,
            status: 'online',
            last_heartbeat: now,
            capacity: 5,
            created_at: now,
            last_registered_at: now,
            permissions: resolve_enroll_permissions(payload),
        } as never);

        await RealmService.bind_daemon_to_realm(payload.realm_id, daemon_id);

        log.info(`daemon registered: ${daemon_id} realm=${payload.realm_id}`);
        result = await with_enroll_bundle({
            daemon_id,
            name: payload.name ?? null,
            user_id: token_info.user_id,
            user_email: token_info.email,
            hostname: payload.hostname ?? null,
            ip: payload.ip ?? null,
            port: payload.port ?? null,
            public_url: normalized_url,
            status: 'online',
            created_at: now,
            last_registered_at: now,
        }, payload.realm_id);

        void DaemonService._inject_team_list(payload.realm_id, daemon_id, token_info.user_id);
        return result;
    }

    /** Fire-and-forget: install the realm's team list onto a newly registered daemon. */
    private static _inject_team_list(realm_id: string, daemon_id: string, user_id: string): void {
        RealmTeamListService.inject_for_daemon(realm_id, daemon_id, user_id).catch((err) => {
            log.warn(
                `team list inject failed: realm=${realm_id} daemon=${daemon_id}: `
                + (err instanceof Error ? err.message : String(err)),
            );
        });
    }

    static async heartbeat(daemon_id: string): Promise<void> {
        const now = Date.now();
        const [count] = await Daemon.update(
            { last_heartbeat: now, status: 'online' },
            { where: { id: daemon_id } },
        );
        if (count === 0) {
            log.warn('heartbeat_unknown_daemon', { daemon_id });
        }
    }

    /**
     * Persist teams_hash on a daemon after a successful sync.
     * Separated from heartbeat() so the hash is only committed once
     * we know the team roster was actually written to the DB.
     */
    static async deregister(daemon_id: string): Promise<void> {
        const [count] = await Daemon.update(
            { status: 'offline' },
            { where: { id: daemon_id } },
        );
        if (count === 0) {
            throw new Error(`Daemon '${daemon_id}' not found`);
        }
        log.info(`daemon deregistered: ${daemon_id}`);
    }

    /**
     * Ensure a daemon row exists and is a realm member.
     * Same identity as later `register` with the same daemon_id (upsert).
     * Status stays offline/pending until the daemon process registers.
     */
    static async ensure_for_realm(input: {
        realm_id: string;
        daemon_id: string;
        user_id: string;
        user_email?: string;
    }): Promise<DaemonRegistrationResult> {
        const now = Date.now();
        const existing = await Daemon.findByPk(input.daemon_id);
        if (existing) {
            await RealmService.bind_daemon_to_realm(input.realm_id, existing.id);
            return to_registration_result(existing);
        }

        await Daemon.create({
            id: input.daemon_id,
            api_key_hash: hash_key(`pending:${input.daemon_id}`),
            user_id: input.user_id,
            user_email: input.user_email ?? null,
            hostname: null,
            ip: null,
            port: null,
            public_url: null,
            status: 'offline',
            last_heartbeat: 0,
            capacity: 5,
            created_at: now,
            last_registered_at: now,
            permissions: default_daemon_grant(input.realm_id) as unknown as Record<string, unknown>,
        } as never);

        await RealmService.bind_daemon_to_realm(input.realm_id, input.daemon_id);
        log.info(`daemon ensured: ${input.daemon_id} realm=${input.realm_id}`);

        const created = await Daemon.findByPk(input.daemon_id);
        if (!created) throw new Error(`Failed to ensure daemon '${input.daemon_id}'`);
        return to_registration_result(created);
    }

    /** List daemons visible via realm intersection when user_id is set.
     * Pass `site_admin: true` to skip membership filtering (all daemons).
     * When `org_id` is set, only daemons in realms belonging to that org are returned.
     */
    static async list(
        user_id?: string,
        filters?: {
            realm_id?: string;
            org_id?: string;
            status?: DaemonStatus;
            query?: string;
            limit?: number;
            offset?: number;
            site_admin?: boolean;
        },
    ): Promise<{ daemons: DaemonInfo[]; total: number }> {
        await DaemonService._mark_stale();

        let daemon_ids: string[] | undefined;
        if (filters?.realm_id) {
            daemon_ids = await RealmService.list_daemon_ids_in_realm(filters.realm_id);
            if (daemon_ids.length === 0) return { daemons: [], total: 0 };
        }
        if (!filters?.realm_id && user_id && !filters?.site_admin) {
            daemon_ids = filters?.org_id
                ? await RealmService.list_daemon_ids_for_user_in_org(user_id, filters.org_id)
                : await RealmService.list_daemon_ids_for_user(user_id);
            if (daemon_ids.length === 0) return { daemons: [], total: 0 };
        }

        const status_filter = filters?.status;
        const query = filters?.query?.trim();
        const pattern = query ? `%${query.replace(/[%_]/g, '\\$&')}%` : null;
        const query_clause = pattern
            ? {
                [Op.or]: [
                    { id: { [Op.iLike]: pattern } },
                    { hostname: { [Op.iLike]: pattern } },
                    { name: { [Op.iLike]: pattern } },
                ],
            }
            : null;

        const where: Record<string, unknown> = {};
        if (daemon_ids) where.id = { [Op.in]: daemon_ids };
        if (status_filter) {
            where.status = status_filter;
        } else if (!filters?.site_admin) {
            where.status = { [Op.in]: ['online', 'stale'] };
        }
        if (query_clause) Object.assign(where, query_clause);

        const limit = filters?.limit != null
            ? Math.min(Math.max(1, filters.limit), 200)
            : undefined;
        const offset = Math.max(0, filters?.offset ?? 0);

        const total = await Daemon.count({ where });
        const rows = await Daemon.findAll({
            where,
            order: [['last_registered_at', 'DESC']],
            ...(limit != null ? { limit, offset } : {}),
        });
        return { daemons: await with_realms(rows.map(to_info)), total };
    }

    static async list_by_ids(daemon_ids: string[]): Promise<DaemonInfo[]> {
        await DaemonService._mark_stale();
        if (daemon_ids.length === 0) return [];
        const rows = await Daemon.findAll({
            where: { id: { [Op.in]: daemon_ids } },
            order: [['last_registered_at', 'DESC']],
        });
        return with_realms(rows.map(to_info));
    }

    static async get(daemon_id: string): Promise<DaemonInfo | null> {
        const row = await Daemon.findByPk(daemon_id);
        if (!row) return null;
        const [info] = await with_realms([to_info(row)]);
        return info;
    }

    static async find_online_for_workspace(daemon_id: string): Promise<DaemonInfo | null> {
        const row = await Daemon.findByPk(daemon_id);
        if (!row) return null;
        if (row.status === 'offline') return null;
        const [info] = await with_realms([to_info(row)]);
        return info;
    }

    /**
     * Remove a daemon record. Called from manual "Remove" button on stale
     * daemons or from the auto-deregister sweep.
     */
    static async remove(daemon_id: string): Promise<void> {
        const row = await Daemon.findByPk(daemon_id);
        if (!row) return;
        await row.destroy();
        log.info(`daemon removed: ${daemon_id}`);
    }

    private static async _mark_stale(): Promise<void> {
        const now = Date.now();
        const stale_cutoff = now - STALE_THRESHOLD_MS;
        const deregister_cutoff = now - DEREGISTER_THRESHOLD_MS;

        await Daemon.update(
            { status: 'stale' },
            {
                where: {
                    status: 'online',
                    last_heartbeat: { [Op.lt]: stale_cutoff },
                },
            },
        );

        try {
            await Daemon.destroy({
                where: {
                    status: { [Op.in]: ['stale', 'offline'] },
                    last_heartbeat: { [Op.lt]: deregister_cutoff },
                },
            });
        } catch {
            // FK cascade on teams may hit unique constraint for orphaned rows;
            // non-fatal — stale daemons stay until data is cleaned up.
        }
    }
}
