/**
 * Resolves a notification rule's `recipients` selectors to people for one
 * org event:
 *
 *   - `invitee`    — `data.invitee_email` (with the account, if one exists);
 *   - `org_owners` — active members of the event's org holding the owner role;
 *   - `inviter`    — `data.inviter.id`;
 *   - `user`       — `data.user.id` (account emails);
 *   - a user id    — that user.
 *
 * Deleted users are never recipients. Recipients are de-duplicated by email;
 * a selector that does not apply to the event (no inviter, no user) yields
 * nobody.
 */

import { Op } from 'sequelize';

import { OrgMember, OrgRole, User } from '../models/index.js';
import type { OrgEventData } from './org_events.js';

/** The named selectors a rule may hold (anything else is a user id). */
export const RECIPIENT_SELECTORS = ['invitee', 'org_owners', 'inviter', 'user'] as const;

/** A rule recipient selector: one of {@link RECIPIENT_SELECTORS} or a user id. */
export type RecipientSelector = (typeof RECIPIENT_SELECTORS)[number] | string;

/** One person a delivery goes to. */
export interface ResolvedRecipient {
    email: string;
    /** The account, when the address belongs to one (needed for in-app delivery). */
    user_id: string | null;
    display_name: string | null;
    /** The selector that produced this recipient (first one wins on duplicates). */
    selector: RecipientSelector;
}

/** The event context the selectors read. */
export interface RecipientContext {
    org_id: string;
    data: OrgEventData;
}

type UserRow = { id: string; email: string; display_name: string; username: string | null };

const USER_ATTRS = ['id', 'email', 'display_name', 'username'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a valid rule recipient selector (a named selector or a user id). */
export function is_recipient_selector(value: string): boolean {
    return (RECIPIENT_SELECTORS as readonly string[]).includes(value) || UUID_PATTERN.test(value);
}

function from_user(row: UserRow, selector: RecipientSelector): ResolvedRecipient {
    return { email: row.email, user_id: String(row.id), display_name: row.display_name || row.username || null, selector };
}

async function live_users_by_id(ids: string[]): Promise<UserRow[]> {
    if (ids.length === 0) return [];
    return User.findAll({ where: { id: { [Op.in]: ids }, deleted_at: null }, attributes: USER_ATTRS, raw: true }) as unknown as Promise<UserRow[]>;
}

async function resolve_one(selector: RecipientSelector, ctx: RecipientContext): Promise<ResolvedRecipient[]> {
    const data = ctx.data as unknown as Partial<Record<string, unknown>>;
    if (selector === 'invitee') {
        const email = typeof data.invitee_email === 'string' ? data.invitee_email.trim().toLowerCase() : '';
        if (!email) return [];
        const user = await User.findOne({ where: { email }, attributes: [...USER_ATTRS, 'deleted_at'], raw: true }) as unknown as (UserRow & { deleted_at: Date | null }) | null;
        if (user?.deleted_at) return [];
        return [user ? from_user(user, selector) : { email, user_id: null, display_name: null, selector }];
    }
    if (selector === 'org_owners') {
        const owner_role = await OrgRole.findOne({ where: { org_id: ctx.org_id, slug: 'owner' }, attributes: ['id'], raw: true });
        if (!owner_role) return [];
        const members = await OrgMember.findAll({
            where: { org_id: ctx.org_id, role_id: owner_role.id, status: 'active', deleted_at: null },
            attributes: ['user_id'],
            raw: true,
        });
        return (await live_users_by_id(members.map((m) => String(m.user_id)))).map((u) => from_user(u, selector));
    }
    if (selector === 'inviter' || selector === 'user') {
        const ref = data[selector] as { id?: unknown } | undefined;
        const id = typeof ref?.id === 'string' ? ref.id : null;
        return id ? (await live_users_by_id([id])).map((u) => from_user(u, selector)) : [];
    }
    if (!is_recipient_selector(selector)) return [];
    return (await live_users_by_id([selector])).map((u) => from_user(u, selector));
}

/**
 * Resolves `selectors` for one event, in selector order, de-duplicated by email.
 *
 * @param selectors - The rule's `recipients`.
 * @param ctx - The event's org and data.
 */
export async function resolve_recipients(selectors: readonly RecipientSelector[], ctx: RecipientContext): Promise<ResolvedRecipient[]> {
    const out: ResolvedRecipient[] = [];
    const seen = new Set<string>();
    for (const selector of selectors) {
        for (const r of await resolve_one(selector, ctx)) {
            const key = r.email.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(r);
        }
    }
    return out;
}
