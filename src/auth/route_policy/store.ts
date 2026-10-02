/**
 * Sequelize-backed {@link AccessStore} for the route policy engine.
 * Reads only ids and scope columns; never record contents.
 */

import {
    AccountInvite, CustomEvent, HubEvent, NotificationChannel, NotificationRule,
    Org, OrgMember, OrgRole, Realm, RealmInvite, RealmMember, Review, ReviewNotification, Run,
    StoredArtifact, Team, Workspace,
} from '../../models/index.js';
import { DEFAULT_ROLES } from '../permissions.js';
import type { AccessStore, OrgRoleInfo, RealmInfo, RecordScope, RequestLike } from './engine.js';
import { read_field } from './engine.js';
import type { RecordKind } from './policy.js';

type Row = Record<string, unknown> | null;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const raw = { raw: true } as const;

function realm_info(r: Row): RealmInfo | null {
    if (!r) return null;
    return {
        id: String(r.id),
        org_id: (r.org_id as string | null) ?? null,
        owner_user_id: (r.owner_user_id as string | null) ?? null,
        deleted: Boolean(r.deleted),
    };
}

async function daemon_realm_ids(daemon_id: string): Promise<string[]> {
    const rows = await RealmMember.findAll({
        where: { member_type: 'daemon', member_id: daemon_id },
        attributes: ['realm_id'],
        ...raw,
    }) as unknown as Array<{ realm_id: string }>;
    return rows.map((r) => r.realm_id);
}

async function run_scope(run_id: string): Promise<RecordScope | null> {
    const r = await Run.findOne({ where: { run_id }, attributes: ['realm_id', 'org_id'], ...raw }) as Row;
    return r ? { realm_id: r.realm_id as string | null, org_id: r.org_id as string | null } : null;
}

export class SequelizeAccessStore implements AccessStore {
    async realm(realm_id: string): Promise<RealmInfo | null> {
        return realm_info(await Realm.findOne({
            where: { id: realm_id }, attributes: ['id', 'org_id', 'owner_user_id', 'deleted'], ...raw,
        }) as Row);
    }

    async realm_by_slug(org_id: string, slug: string): Promise<RealmInfo | null> {
        const attributes = ['id', 'org_id', 'owner_user_id', 'deleted'];
        const by_slug = await Realm.findOne({ where: { org_id, slug, deleted: false }, attributes, ...raw }) as Row;
        if (by_slug) return realm_info(by_slug);
        // RealmService.get_by_slug also accepts the realm id in `slug`.
        if (!UUID_RE.test(slug)) return null;
        return realm_info(await Realm.findOne({ where: { id: slug, org_id, deleted: false }, attributes, ...raw }) as Row);
    }

    async realm_role(realm_id: string, user_id: string) {
        const r = await RealmMember.findOne({
            where: { realm_id, member_type: 'user', member_id: user_id }, attributes: ['role'], ...raw,
        }) as Row;
        return (r?.role as 'admin' | 'operator' | 'member' | undefined) ?? null;
    }

    async org_role(org_id: string, user_id: string): Promise<OrgRoleInfo | null> {
        // A pending membership (open invite) grants nothing until accepted.
        const m = await OrgMember.findOne({ where: { org_id, user_id, status: 'active', deleted_at: null }, attributes: ['role', 'role_id'], ...raw }) as Row;
        if (!m) return null;
        if (m.role_id) {
            const role = await OrgRole.findOne({
                where: { id: m.role_id }, attributes: ['slug', 'permissions', 'is_system'], ...raw,
            }) as Row;
            if (role) {
                return {
                    slug: String(role.slug),
                    is_system: Boolean(role.is_system),
                    permissions: (role.permissions as string[] | null) ?? [],
                };
            }
        }
        // Members without role_id (pre-migration rows): fall back to the legacy role column.
        const legacy = DEFAULT_ROLES.find((d) => d.slug === m.role) ?? DEFAULT_ROLES.find((d) => d.slug === 'member')!;
        return { slug: legacy.slug, is_system: legacy.is_system, permissions: [...legacy.permissions] };
    }

    async org_id_by_slug(slug: string): Promise<string | null> {
        const o = await Org.findOne({ where: { slug, deleted_at: null }, attributes: ['id'], ...raw }) as Row;
        return (o?.id as string | undefined) ?? null;
    }

    async daemon_in_realm(realm_id: string, daemon_id: string): Promise<boolean> {
        const r = await RealmMember.findOne({
            where: { realm_id, member_type: 'daemon', member_id: daemon_id }, attributes: ['id'], ...raw,
        });
        return Boolean(r);
    }

    async record(kind: RecordKind, id: string, req: RequestLike): Promise<RecordScope | null> {
        switch (kind) {
            case 'realm': {
                const r = await this.realm(id);
                return r ? { realm_id: r.id, org_id: r.org_id } : null;
            }
            case 'run':
                return run_scope(id);
            case 'review': {
                const r = await Review.findOne({ where: { id }, attributes: ['realm_id', 'org_id'], ...raw }) as Row;
                if (!r) return null;
                // A reviewer assigned by name (user-targeted notification) may act on
                // the review even without a realm membership.
                const user_id = req.auth?.auth_via === 'daemon_token' ? undefined : req.auth?.user?.id;
                const assigned = user_id
                    ? Boolean(await ReviewNotification.findOne({ where: { review_id: id, user_id }, attributes: ['id'], ...raw }))
                    : false;
                return { realm_id: r.realm_id as string | null, org_id: r.org_id as string | null, assigned_user: assigned };
            }
            case 'artifact': {
                const a = await StoredArtifact.findOne({ where: { id }, attributes: ['run_id'], ...raw }) as Row;
                return a ? run_scope(String(a.run_id)) : null;
            }
            case 'event': {
                const e = await HubEvent.findOne({ where: { id }, attributes: ['realm_id', 'org_id'], ...raw }) as Row;
                return e ? { realm_id: e.realm_id as string | null, org_id: e.org_id as string | null } : null;
            }
            case 'custom_event': {
                const e = await CustomEvent.findOne({ where: { id }, attributes: ['realm_id'], ...raw }) as Row;
                return e ? { realm_id: e.realm_id as string | null } : null;
            }
            case 'daemon': {
                const realm_ids = await daemon_realm_ids(id);
                return realm_ids.length ? { realm_ids } : null;
            }
            case 'workspace': {
                const w = await Workspace.findOne({ where: { id }, attributes: ['daemon_id'], ...raw }) as Row;
                if (!w) return null;
                return { realm_ids: w.daemon_id ? await daemon_realm_ids(String(w.daemon_id)) : [] };
            }
            case 'invitation': {
                const target = read_field(req, 'body.target_type');
                if (target !== 'realm') {
                    const a = await AccountInvite.findOne({ where: { id }, attributes: ['org_id'], ...raw }) as Row;
                    if (a) return { org_id: a.org_id as string };
                }
                const r = await RealmInvite.findOne({ where: { id }, attributes: ['realm_id'], ...raw }) as Row;
                return r ? { realm_id: r.realm_id as string } : null;
            }
            case 'channel': {
                const c = await NotificationChannel.findOne({ where: { id }, attributes: ['realm_id', 'org_id', 'user_id'], ...raw }) as Row;
                if (!c) return null;
                if (!c.realm_id && !c.org_id && c.user_id && c.user_id === req.auth?.user?.id) {
                    return { realm_ids: [], org_id: null, owner_user_id: String(c.user_id) };
                }
                return { realm_id: c.realm_id as string | null, org_id: c.org_id as string | null };
            }
            case 'rule': {
                const r = await NotificationRule.findOne({ where: { id }, attributes: ['realm_id', 'org_id'], ...raw }) as Row;
                return r ? { realm_id: r.realm_id as string | null, org_id: r.org_id as string | null } : null;
            }
            case 'team': {
                // By id, or by (scope, name) — scope omitted means an unscoped team.
                const by_id = read_field(req, 'body.team_id') === id;
                const where = by_id ? { id } : { name: id, scope: read_field(req, 'body.scope') ?? null };
                const t = await Team.findOne({ where, attributes: ['visibility', 'author_id', 'scope'], ...raw }).catch(() => null) as Row;
                return t ? {
                    team: {
                        visibility: t.visibility as 'public' | 'private' | 'draft',
                        author_id: (t.author_id as string | null) ?? null,
                        scope: (t.scope as string | null) ?? null,
                    },
                } : null;
            }
        }
    }
}
