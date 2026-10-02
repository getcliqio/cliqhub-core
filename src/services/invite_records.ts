/**
 * Data access for org, owner and realm invites, shared by the invitations
 * service and the invite sweep.
 *
 * Org and owner invites live in `account_invites`, realm invites in
 * `realm_invites`; both tables have the same columns, so an invite is handled
 * as one {@link InviteRecord} whichever table holds it. This module loads
 * invites (by id or by link token), builds the `invite.*` event data, and
 * writes the membership that goes with an invite (org membership for org and
 * owner invites, realm membership for realm invites): a `pending` row while
 * the invite is open, `active` once accepted, soft-deleted when the invite is
 * declined, revoked or expires. Pending memberships grant no access.
 */

import { randomUUID } from 'node:crypto';
import type { Transaction } from 'sequelize';

import {
    AccountInvite, Org, OrgMember, OrgRole, Realm, RealmInvite, RealmMember, User,
} from '../models/index.js';
import type { InviteStatus } from '../models/account_invite.model.js';
import { hash_token } from '../lib/secure_token.js';
import type { DeliveryLinkRef, InviteEventData } from '../notifications/org_events.js';
import {
    invite_kind, org_member_role_column, to_date,
    type InviteRole, type InviteTargetType, type OrgInviteRole, type RealmInviteRole,
} from './invite_rules.js';

/** The table an invite lives in. */
export type InviteTable = 'account_invites' | 'realm_invites';

/** One invite, from either table. */
export interface InviteRecord {
    table: InviteTable;
    target: InviteTargetType;
    id: string;
    email: string;
    role: InviteRole;
    status: InviteStatus;
    invited_by: string;
    created_at: Date;
    expires_at: Date;
    send_count: number;
    last_sent_at: Date | null;
    reminders_sent: number;
    /** The org (for a realm invite, the realm's org). */
    org_id: string;
    /** Set for realm invites. */
    realm_id: string | null;
}

/** The org, realm and inviter an invite refers to. */
export interface InviteContext {
    org: { id: string; slug: string; display_name: string; status: string; activated_at: Date | null; owner_id: string | null };
    realm: { id: string; slug: string; name: string } | null;
    inviter: { id: string; display_name: string };
}

/** The invite columns both tables share. */
type InviteRow = {
    id: string; email: string; role: string; status: InviteStatus; invited_by: string;
    created_at: Date | string; expires_at: Date | string; send_count: number;
    last_sent_at: Date | string | null; reminders_sent: number;
    org_id?: string; realm_id?: string;
};

/** The Sequelize model of an invite table (both share their columns). */
export function invite_model(table: InviteTable): typeof AccountInvite {
    return (table === 'account_invites' ? AccountInvite : RealmInvite) as unknown as typeof AccountInvite;
}

/** The table that holds invites for a target type. */
export function table_for(target: InviteTargetType): InviteTable {
    return target === 'org' ? 'account_invites' : 'realm_invites';
}

/**
 * Turns a raw invite row into an {@link InviteRecord}, looking up the realm's
 * org for realm invites.
 *
 * @returns null when a realm invite's realm is gone.
 */
export async function to_record(table: InviteTable, row: InviteRow, t?: Transaction): Promise<InviteRecord | null> {
    let org_id = row.org_id ?? null;
    if (table === 'realm_invites') {
        const realm = await Realm.findByPk(row.realm_id!, { attributes: ['id', 'org_id'], raw: true, transaction: t });
        if (!realm) return null;
        org_id = String(realm.org_id);
    }
    return {
        table,
        target: table === 'account_invites' ? 'org' : 'realm',
        id: String(row.id),
        email: row.email,
        role: row.role as InviteRole,
        status: row.status,
        invited_by: String(row.invited_by),
        created_at: to_date(row.created_at),
        expires_at: to_date(row.expires_at),
        send_count: Number(row.send_count ?? 1),
        last_sent_at: row.last_sent_at ? to_date(row.last_sent_at) : null,
        reminders_sent: Number(row.reminders_sent ?? 0),
        org_id: String(org_id),
        realm_id: table === 'realm_invites' ? String(row.realm_id) : null,
    };
}

/**
 * Finds an invite by id in either table (org invites first unless `prefer` is `realm`).
 *
 * @param id - The invite id.
 * @param prefer - Which table to look in first.
 * @param t - Optional transaction; with `lock` the row is locked for update.
 */
export async function find_invite_by_id(
    id: string,
    opts: { prefer?: InviteTargetType; t?: Transaction; lock?: boolean } = {},
): Promise<InviteRecord | null> {
    const order: InviteTable[] = opts.prefer === 'realm' ? ['realm_invites', 'account_invites'] : ['account_invites', 'realm_invites'];
    for (const table of order) {
        const row = await invite_model(table).findByPk(id, {
            raw: true, transaction: opts.t, ...(opts.t && opts.lock ? { lock: opts.t.LOCK.UPDATE } : {}),
        }) as unknown as InviteRow | null;
        if (row) return to_record(table, row, opts.t);
    }
    return null;
}

/**
 * Finds the invite a link token belongs to, in either table, whatever its status.
 *
 * @param token - The raw token from the link (only its hash is looked up).
 * @param t - Optional transaction; with `lock` the row is locked for update.
 */
export async function find_invite_by_token(
    token: string,
    opts: { t?: Transaction; lock?: boolean } = {},
): Promise<InviteRecord | null> {
    const token_hash = hash_token(token.trim());
    for (const table of ['account_invites', 'realm_invites'] as const) {
        const row = await invite_model(table).findOne({
            where: { token_hash }, raw: true, transaction: opts.t,
            ...(opts.t && opts.lock ? { lock: opts.t.LOCK.UPDATE } : {}),
        }) as unknown as InviteRow | null;
        if (row) return to_record(table, row, opts.t);
    }
    return null;
}

/**
 * Loads the org, realm and inviter of an invite.
 *
 * @throws Error when the org no longer exists.
 */
export async function load_context(invite: InviteRecord, t?: Transaction): Promise<InviteContext> {
    const org = await Org.findByPk(invite.org_id, {
        attributes: ['id', 'slug', 'display_name', 'status', 'activated_at', 'owner_id'], raw: true, transaction: t,
    });
    if (!org) throw new Error(`Org ${invite.org_id} of invite ${invite.id} not found`);
    const realm = invite.realm_id
        ? await Realm.findByPk(invite.realm_id, { attributes: ['id', 'slug', 'name'], raw: true, transaction: t })
        : null;
    const inviter = await User.findByPk(invite.invited_by, { attributes: ['id', 'username', 'display_name', 'email'], raw: true, transaction: t });
    return {
        org: {
            id: String(org.id), slug: org.slug, display_name: org.display_name || org.slug, status: org.status,
            activated_at: org.activated_at ? to_date(org.activated_at) : null, owner_id: org.owner_id ?? null,
        },
        realm: realm ? { id: String(realm.id), slug: realm.slug, name: realm.name || realm.slug } : null,
        inviter: {
            id: invite.invited_by,
            display_name: inviter?.display_name || inviter?.username || inviter?.email || '',
        },
    };
}

/**
 * The `data` of an `invite.*` event for this invite.
 *
 * @param extra - `accepted_user` / `decision` for accepted and declined events.
 */
export function invite_event_data(
    invite: InviteRecord,
    ctx: InviteContext,
    extra: Pick<InviteEventData, 'accepted_user' | 'decision'> = {},
): InviteEventData {
    return {
        invite_id: invite.id,
        kind: invite_kind(invite.target, invite.role),
        role: invite.role,
        invitee_email: invite.email,
        inviter: ctx.inviter,
        org: { slug: ctx.org.slug, display_name: ctx.org.display_name },
        realm: ctx.realm ? { slug: ctx.realm.slug, display_name: ctx.realm.name } : null,
        expires_at: invite.expires_at.toISOString(),
        send_count: invite.send_count,
        ...extra,
    };
}

/** Where the email link of this invite is rebuilt from at delivery. */
export function invite_link(invite: InviteRecord): DeliveryLinkRef {
    return { kind: 'invite', table: invite.table, invite_id: invite.id };
}

/** The org role id for a role slug in an org (null when the org has no such role). */
async function org_role_id(org_id: string, slug: string, t?: Transaction): Promise<string | null> {
    const role = await OrgRole.findOne({ where: { org_id, slug }, attributes: ['id'], raw: true, transaction: t });
    return role ? String(role.id) : null;
}

/**
 * Writes the `pending` org membership of an open org or owner invite. A row
 * left by a former membership (soft-deleted) is revived as pending; an
 * active membership is left as it is.
 *
 * @param org_id - The org.
 * @param user_id - The invited user (an `invited` placeholder or an existing account).
 * @param role - The invite's role.
 */
export async function set_pending_org_membership(org_id: string, user_id: string, role: OrgInviteRole, now: Date, t: Transaction): Promise<void> {
    const values = {
        role: org_member_role_column(role),
        role_id: await org_role_id(org_id, role, t),
        status: 'pending' as const,
        deleted_at: null,
        invited_at: now,
    };
    const existing = await OrgMember.findOne({ where: { org_id, user_id }, attributes: ['status', 'deleted_at'], raw: true, transaction: t });
    if (existing) {
        // An active membership stays as it is until the invite is accepted.
        if (existing.status === 'active' && !existing.deleted_at) return;
        await OrgMember.update(values, { where: { org_id, user_id }, transaction: t });
        return;
    }
    await OrgMember.create({ org_id, user_id, ...values, joined_at: null }, { transaction: t });
}

/**
 * Makes the person an active member of the org with `role` (accepting an org
 * or owner invite, or joining a realm's org as a Member).
 *
 * @param keep_existing - Leave an existing active membership as it is (realm invites).
 */
export async function activate_org_membership(
    org_id: string, user_id: string, role: OrgInviteRole, now: Date, t: Transaction, keep_existing = false,
): Promise<void> {
    const existing = await OrgMember.findOne({ where: { org_id, user_id }, attributes: ['status', 'deleted_at', 'joined_at'], raw: true, transaction: t });
    if (existing && keep_existing && existing.status === 'active' && !existing.deleted_at) return;
    const values = {
        role: org_member_role_column(role),
        role_id: await org_role_id(org_id, role, t),
        status: 'active' as const,
        deleted_at: null,
        joined_at: now,
    };
    if (existing) {
        await OrgMember.update(values, { where: { org_id, user_id }, transaction: t });
        return;
    }
    await OrgMember.create({ org_id, user_id, ...values, invited_at: null }, { transaction: t });
}

/**
 * Writes the realm membership of `user_id` with `status` and `role`: revives
 * the existing row (former or pending) or creates it. Realm memberships are
 * read through the model's default scope, so this goes around it.
 */
async function write_realm_membership(
    realm_id: string, user_id: string, role: RealmInviteRole, status: 'pending' | 'active', t: Transaction,
): Promise<void> {
    const all = RealmMember.unscoped();
    const where = { realm_id, member_type: 'user' as const, member_id: user_id };
    const existing = await all.findOne({ where, attributes: ['id'], raw: true, transaction: t });
    if (existing) {
        await all.update({ role, status, deleted_at: null }, { where, transaction: t });
        return;
    }
    await all.create({ id: randomUUID(), ...where, role, status, created_at: Date.now() }, { transaction: t });
}

/**
 * Writes the `pending` realm membership of an open realm invite. An active
 * membership is left as it is.
 */
export async function set_pending_realm_membership(realm_id: string, user_id: string, role: RealmInviteRole, t: Transaction): Promise<void> {
    const live = await RealmMember.findOne({ where: { realm_id, member_type: 'user', member_id: user_id }, attributes: ['id'], raw: true, transaction: t });
    if (live) return;
    await write_realm_membership(realm_id, user_id, role, 'pending', t);
}

/**
 * Makes the person an active member of the realm with `role` (accepting a realm invite).
 */
export async function activate_realm_membership(realm_id: string, user_id: string, role: RealmInviteRole, t: Transaction): Promise<void> {
    await write_realm_membership(realm_id, user_id, role, 'active', t);
}

/**
 * Removes the pending membership an invite created (soft delete), when the
 * invite is declined, revoked or expires: the org membership of an org or
 * owner invite, the realm membership of a realm invite. Active memberships
 * are left alone.
 */
export async function drop_pending_membership(invite: InviteRecord, now: Date, t: Transaction): Promise<void> {
    const user = await User.findOne({ where: { email: invite.email }, attributes: ['id'], raw: true, transaction: t });
    if (!user) return;
    if (invite.target === 'realm') {
        await RealmMember.unscoped().update(
            { deleted_at: now },
            { where: { realm_id: invite.realm_id!, member_type: 'user', member_id: String(user.id), status: 'pending', deleted_at: null }, transaction: t },
        );
        return;
    }
    await OrgMember.update(
        { deleted_at: now },
        { where: { org_id: invite.org_id, user_id: String(user.id), status: 'pending', deleted_at: null }, transaction: t },
    );
}
