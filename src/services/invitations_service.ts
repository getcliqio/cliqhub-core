/**
 * Invitations to orgs (member, admin, owner) and realms.
 *
 * Serves `invitations/create` (send, and send again for the same email),
 * `get`, `get_by_id`, `revoke`, and the public `get_by_token` and `accept`
 * (accept or decline). `orgs/new` sends its owner invite through
 * {@link InvitationsService.send_in_transaction}.
 *
 * An invite's link token is issued once (lib/secure_token.ts) and stored as a
 * hash plus an encrypted copy, so "send again" and the sweep's reminders reuse
 * the same link; no response, event or log contains the token. Every change
 * raises its `invite.<kind>.<action>` event after commit
 * ({@link OrgEventService}); when the invite email could not be sent, the
 * response carries `invite_url` so the inviter can pass the link on.
 */

import { Op, type Transaction, type WhereOptions } from 'sequelize';

import { ApiError } from '../errors/api_error.js';
import { INVITE_TTL_MS } from '../config/identity_lifecycle.js';
import type { OrgRepository } from '../repositories/org_repository.js';
import type { ScopeRepository } from '../repositories/scope_repository.js';
import type { UserRepository } from '../repositories/user_repository.js';
import type { AuthContext } from '../schemas/auth_types.js';
import type { InviteStatus } from '../models/account_invite.model.js';
import { EmailDelivery, Org, OrgMember, Realm, RealmMember, Scope, ScopeMember, User } from '../models/index.js';
import { hash_password } from '../auth/password.js';
import { org_standing } from '../auth/route_policy/visible.js';
import { get_sequelize } from '../db/sequelize.js';
import { assert_namespace_free, deleted_user_error, on_name_race, type NamespaceRepos } from '../lib/namespace.js';
import { assert_password_rules, normalize_email, normalize_username } from '../lib/account_fields.js';
import { issue_token } from '../lib/secure_token.js';
import { get_logger } from '../lib/log.js';
import { invite_event, type EventActor } from '../notifications/org_events.js';
import { resolve_delivery_links } from '../notifications/delivery_links.js';
import { OrgEventService, type PendingOrgEvent } from './org_event.service.js';
import type { ReactivationService } from './reactivation.service.js';
import { RealmService } from './realm.service.js';
import { ensure_per_user_channel } from './per_user_channel.service.js';
import { ensure_account_org } from './account_org.js';
import {
    activate_org_membership, activate_realm_membership, drop_pending_membership, find_invite_by_id,
    find_invite_by_token, invite_event_data, invite_link, invite_model, load_context, set_pending_org_membership, set_pending_realm_membership,
    table_for, to_record, type InviteContext, type InviteRecord,
} from './invite_records.js';
import {
    DEFAULT_INVITE_ROLE, assert_role_for_target, effective_status, invite_kind, parse_invite_sort, to_date,
    type InviteRole, type InviteTargetType, type OrgInviteRole, type RealmInviteRole,
} from './invite_rules.js';
import { escape_like } from '../lib/search.js';

const log = get_logger('svc.invitations');

const DEFAULT_PAGE_SIZE = 25;

/** A new person's account fields on accept; `kept` when a reactivated account keeps its username. */
interface NewPerson {
    username: string;
    kept: boolean;
    password_hash: string;
    display_name: string;
}

/** What {@link InvitationsService.send_in_transaction} sends. */
export interface SendInviteInput {
    target: InviteTargetType;
    org_id: string;
    realm_id: string | null;
    email: string;
    role: InviteRole;
    /** The invited user (an `invited` placeholder or an existing account). */
    user_id: string;
    /** The user sending the invite. */
    actor_id: string;
    now: Date;
}

/** An invite sent inside a transaction; its event is delivered when the transaction commits. */
export interface SentInvite {
    invite: InviteRecord;
    /** True when a pending invite for the same email and target already existed (send again). */
    resent: boolean;
    event: PendingOrgEvent;
}

/** One invite as `invitations/get` and `get_by_id` return it (never the token). */
export interface InviteListItem {
    invite_id: string;
    email: string;
    role: string;
    kind: string;
    status: InviteStatus;
    inviter: { id: string; display_name: string } | null;
    send_count: number;
    last_sent_at: string | null;
    expires_at: string;
    deliveries: Array<{ kind: 'sent' | 'reminder'; sent_at: string; email_sent: boolean; provider_message_id: string | null }>;
    created_at: string;
}

/**
 * Org and realm invitations: send, list, revoke, preview and accept / decline.
 */
export class InvitationsService {
    constructor(
        private _org_repo: OrgRepository,
        private _scope_repo: ScopeRepository,
        private _user_repo: UserRepository,
        private _reactivation: ReactivationService,
        /** Mints the new user's session PAT (`AuthService.mint_session_pat`). */
        private _mint_session_pat?: (user_id: string) => Promise<{ token: string }>,
    ) {}

    private _require_auth(auth: AuthContext): void {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    /** The route policy may have judged `realm_id` instead of `org_id`, so org invites check the org here. */
    private async _require_org_admin(auth: AuthContext, org_id: string): Promise<void> {
        this._require_auth(auth);
        if (auth.user!.role === 'admin') return;
        const { require_permission } = await import('../auth/permissions.js');
        await require_permission(org_id, auth.user!.id, 'org.members.manage', { site_role: auth.user!.role });
    }

    /** Only an org owner or a site admin may invite someone as owner. */
    private async _require_owner(auth: AuthContext, org_id: string): Promise<void> {
        if (auth.user!.role === 'admin') return;
        const standing = await org_standing(org_id, auth.user!.id);
        if (!standing?.is_system) {
            throw new ApiError('forbidden', 'Only an owner of the org can invite an owner', 403);
        }
    }

    private _ns(): NamespaceRepos {
        return { org_repo: this._org_repo, scope_repo: this._scope_repo, user_repo: this._user_repo };
    }

    // ─── Send ────────────────────────────────────────────────────────

    /**
     * `invitations/create`: invites `email` to an org or realm. A pending
     * invite for the same email and target is sent again: same link, a new
     * 14-day expiry, `send_count` + 1, `resent: true`.
     *
     * Creates an `invited` user when nobody has the email, and a pending org
     * or realm membership. Raises `invite.<kind>.sent`.
     *
     * @throws ApiError 422 invalid_params (email, role for the target);
     *   403 forbidden (not a members manager; owner role needs an owner);
     *   404 not_found (org or realm); 409 already_member;
     *   409 deleted (the email belongs to a deleted user; a site admin may
     *   resend with `reactivate: true`); whatever ReactivationService throws when restoring.
     */
    async create(auth: AuthContext, params: {
        target_type: InviteTargetType;
        org_id?: string;
        realm_id?: string;
        email: string;
        role?: InviteRole;
        reactivate?: boolean;
    }) {
        log.debug('create', { user_id: auth.user?.id, target_type: params.target_type, org_id: params.org_id, realm_id: params.realm_id });
        this._require_auth(auth);

        const role = params.role ?? DEFAULT_INVITE_ROLE;
        assert_role_for_target(params.target_type, role);
        const email = normalize_email(params.email);

        let org_id: string;
        let realm_id: string | null = null;
        if (params.target_type === 'org') {
            org_id = params.org_id!;
            await this._require_org_admin(auth, org_id);
            if (role === 'owner') await this._require_owner(auth, org_id);
            const org = await Org.findByPk(org_id, { attributes: ['id', 'deleted_at'], raw: true });
            if (!org || org.deleted_at) throw new ApiError('not_found', 'Org not found', 404);
        } else {
            // Route policy: realm admin + realms.members.manage.
            const realm = await Realm.findByPk(params.realm_id!, { attributes: ['id', 'org_id', 'deleted'], raw: true });
            if (!realm || realm.deleted) throw new ApiError('not_found', 'Realm not found', 404);
            realm_id = String(realm.id);
            org_id = String(realm.org_id);
        }

        const now = new Date();
        const sent = await get_sequelize().transaction(async (t) => {
            const user_id = await this.invitee_user_id(auth, email, { reactivate: params.reactivate, t });
            await this._assert_not_member(params.target_type, org_id, realm_id, user_id, t);
            return this.send_in_transaction(t, {
                target: params.target_type, org_id, realm_id, email, role, user_id, actor_id: String(auth.user!.id), now,
            });
        });
        const delivery = await this.delivery_outcome(sent);

        log.info('invite_sent', {
            invite_id: sent.invite.id, target_type: params.target_type, org_id, realm_id, role,
            resent: sent.resent, send_count: sent.invite.send_count, email_sent: delivery.email_sent,
        });
        return {
            invite_id: sent.invite.id,
            status: 'pending' as const,
            email,
            role,
            expires_at: sent.invite.expires_at.toISOString(),
            resent: sent.resent,
            ...delivery,
        };
    }

    /**
     * The user an invite to `email` is for: the account holding the email, or
     * a new `invited` user (no username or password yet). A deleted holder is
     * refused unless a site admin sends `reactivate: true`, which restores it.
     * Holds a per-email advisory lock for the rest of `t`, so concurrent
     * invites to the same person serialize: the later one sees the earlier
     * one's user and pending invite (and sends it again) instead of failing.
     *
     * @param opts.display_name - Display name for a new invited user.
     * @throws ApiError 409 deleted; 403 forbidden (reactivate by a non site admin);
     *   whatever ReactivationService throws when restoring.
     */
    async invitee_user_id(
        auth: AuthContext,
        email: string,
        opts: { reactivate?: boolean; display_name?: string; t: Transaction },
    ): Promise<string> {
        await get_sequelize().query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `invite_email:${email}` }, transaction: opts.t });
        const holder = await User.findOne({ where: { email }, attributes: ['id', 'status', 'deleted_at'], raw: true, transaction: opts.t });
        if (holder?.deleted_at) {
            if (!opts.reactivate) throw deleted_user_error({ ...holder, deleted_at: holder.deleted_at }, `${email} belongs to a deleted user`);
            this._reactivation.assert_can_reactivate(auth);
            const restored = await this._reactivation.restore_user(auth, String(holder.id), opts.t);
            log.info('invitee_reactivated', { user_id: restored.id });
            return restored.id;
        }
        if (holder) return String(holder.id);

        const user = await User.create({
            username: null as unknown as string,
            email,
            password_hash: null,
            display_name: opts.display_name?.trim() ?? '',
            role: 'user',
            status: 'invited',
        }, { transaction: opts.t });
        log.info('invited_user_created', { user_id: user.id });
        return String(user.id);
    }

    /** @throws ApiError 409 already_member when the user is an active member of the target. */
    private async _assert_not_member(target: InviteTargetType, org_id: string, realm_id: string | null, user_id: string, t: Transaction): Promise<void> {
        const member = target === 'org'
            ? await OrgMember.findOne({ where: { org_id, user_id, status: 'active', deleted_at: null }, attributes: ['user_id'], raw: true, transaction: t })
            : await RealmMember.findOne({ where: { realm_id: realm_id!, member_type: 'user', member_id: user_id, status: 'active', deleted_at: null }, attributes: ['id'], raw: true, transaction: t });
        if (member) throw ApiError.already_member(user_id);
    }

    /**
     * Opens the invite inside `t`, or sends the pending one again (same link,
     * new expiry, `send_count` + 1, reminders restart), writes the pending org
     * or realm membership, and raises `invite.<kind>.sent` for after commit.
     *
     * The caller has checked access, the role and that the user is not a member.
     */
    async send_in_transaction(t: Transaction, input: SendInviteInput): Promise<SentInvite> {
        const table = table_for(input.target);
        const model = invite_model(table);
        const expires_at = new Date(input.now.getTime() + INVITE_TTL_MS);
        const scope = input.target === 'org' ? { org_id: input.org_id } : { realm_id: input.realm_id! };

        const open = await model.findOne({
            where: { ...scope, email: input.email, status: 'pending' } as WhereOptions,
            order: [['created_at', 'DESC']],
            lock: t.LOCK.UPDATE,
            transaction: t,
        });
        let row;
        if (open) {
            // Send again: same link unless none was stored (then a new one is issued).
            const relink = open.token_enc ? {} : (({ token_hash, token_enc }) => ({ token_hash, token_enc }))(issue_token());
            await open.update({
                ...relink,
                role: input.role,
                expires_at,
                send_count: open.send_count + 1,
                last_sent_at: input.now,
                reminders_sent: 0,
            }, { transaction: t });
            row = open;
        } else {
            const { token_hash, token_enc } = issue_token();
            row = await model.create({
                ...scope,
                email: input.email,
                invited_by: input.actor_id,
                token_hash,
                token_enc,
                role: input.role,
                status: 'pending',
                expires_at,
                send_count: 1,
                last_sent_at: input.now,
                reminders_sent: 0,
            } as never, { transaction: t });
        }
        const invite = (await to_record(table, row.get({ plain: true }) as never, t))!;

        if (input.target === 'org') {
            await set_pending_org_membership(input.org_id, input.user_id, input.role as OrgInviteRole, input.now, t);
        } else {
            await set_pending_realm_membership(input.realm_id!, input.user_id, input.role as RealmInviteRole, t);
        }

        const ctx = await load_context(invite, t);
        const event = OrgEventService.raise_after_commit(t, {
            event: invite_event(invite_kind(invite.target, invite.role), 'sent'),
            org_id: invite.org_id,
            realm_id: invite.realm_id,
            actor: { user_id: input.actor_id },
            data: invite_event_data(invite, ctx),
            link: invite_link(invite),
        });
        return { invite, resent: Boolean(open), event };
    }

    /**
     * Waits for a sent invite's event (only after its transaction returned)
     * and returns `email_sent`, plus `invite_url` when the email did not go out.
     */
    async delivery_outcome(sent: SentInvite): Promise<{ email_sent: boolean; invite_url: string | null }> {
        const { email_sent } = await sent.event.result;
        if (email_sent) return { email_sent, invite_url: null };
        try {
            return { email_sent, invite_url: (await resolve_delivery_links(invite_link(sent.invite))).accept_url ?? null };
        } catch (err) {
            log.warn('invite_url_unavailable', { invite_id: sent.invite.id, error: err instanceof Error ? err.message : String(err) });
            return { email_sent, invite_url: null };
        }
    }

    // ─── Read ────────────────────────────────────────────────────────

    /**
     * `invitations/get`: one org's or realm's invites, optionally by status
     * (as of now: a pending invite past its expiry counts as expired) and email
     * substring, sorted and paged. Each item lists the emails sent for it.
     *
     * @throws ApiError 403 forbidden (org invites: not a members manager);
     *   422 invalid_params (unknown sort field)
     */
    async get(auth: AuthContext, params: {
        target_type?: InviteTargetType;
        org_id?: string;
        realm_id?: string;
        status?: InviteStatus;
        query?: string;
        sort?: string;
        page?: number;
        page_size?: number;
    }) {
        log.debug('get', { user_id: auth.user?.id, target_type: params.target_type, org_id: params.org_id, realm_id: params.realm_id });
        this._require_auth(auth);
        const target: InviteTargetType = params.target_type ?? (params.org_id ? 'org' : 'realm');
        if (target === 'org') await this._require_org_admin(auth, params.org_id!);
        // Realm invites: route policy checked realm admin + realms.members.manage.

        const { field, dir } = parse_invite_sort(params.sort);
        const page = params.page ?? 1;
        const page_size = params.page_size ?? DEFAULT_PAGE_SIZE;
        const now = new Date();

        const where: Record<string | symbol, unknown> = target === 'org' ? { org_id: params.org_id } : { realm_id: params.realm_id };
        if (params.status === 'pending') {
            Object.assign(where, { status: 'pending', expires_at: { [Op.gt]: now } });
        } else if (params.status === 'expired') {
            where[Op.or] = [{ status: 'expired' }, { status: 'pending', expires_at: { [Op.lte]: now } }];
        } else if (params.status) {
            where.status = params.status;
        }
        const q = params.query?.trim();
        if (q) where.email = { [Op.iLike]: `%${escape_like(q)}%` };

        const table = table_for(target);
        const { rows, count } = await invite_model(table).findAndCountAll({
            where: where as WhereOptions,
            order: [[field, dir], ['id', 'ASC']],
            limit: page_size,
            offset: (page - 1) * page_size,
            raw: true,
        });
        const records = (await Promise.all(rows.map((r) => to_record(table, r as never)))).filter((r): r is InviteRecord => r !== null);
        const invites = await this._list_items(records, now);

        return target === 'org'
            ? { target_type: 'org' as const, org_id: params.org_id!, invites, total: count, page, page_size }
            : { target_type: 'realm' as const, realm_id: params.realm_id!, invites, total: count, page, page_size };
    }

    /**
     * `invitations/get_by_id`: one invite, found by id in either table.
     *
     * @throws ApiError 404 not_found
     */
    async get_by_id(auth: AuthContext, params: { invite_id: string; target_type?: InviteTargetType }) {
        log.debug('get_by_id', { invite_id: params.invite_id, user_id: auth.user?.id });
        this._require_auth(auth);
        // Route policy loaded the invite: org.members.manage, or realm admin + realms.members.manage.
        const invite = await find_invite_by_id(params.invite_id, { prefer: params.target_type });
        if (!invite) throw new ApiError('not_found', 'Invite not found', 404);
        const [item] = await this._list_items([invite], new Date());
        return invite.target === 'org'
            ? { target_type: 'org' as const, org_id: invite.org_id, invite: item }
            : { target_type: 'realm' as const, realm_id: invite.realm_id!, invite: item };
    }

    /** List items for invites, with inviters and recorded emails loaded in bulk. */
    private async _list_items(invites: InviteRecord[], now: Date): Promise<InviteListItem[]> {
        if (!invites.length) return [];
        const ids = invites.map((i) => i.id);
        const inviter_ids = [...new Set(invites.map((i) => i.invited_by))];
        const [inviters, deliveries] = await Promise.all([
            User.findAll({ where: { id: { [Op.in]: inviter_ids } }, attributes: ['id', 'username', 'display_name', 'email'], raw: true }),
            EmailDelivery.findAll({
                where: { subject_type: 'invite', subject_id: { [Op.in]: ids }, event: { [Op.like]: 'invite.%' } },
                attributes: ['subject_id', 'event', 'sent_at', 'ok', 'provider_message_id'],
                order: [['sent_at', 'ASC']],
                raw: true,
            }),
        ]);
        const inviter_by_id = new Map(inviters.map((u) => [String(u.id), { id: String(u.id), display_name: u.display_name || u.username || u.email }]));
        const sent_by_invite = new Map<string, InviteListItem['deliveries']>();
        for (const d of deliveries) {
            const action = d.event.split('.')[2];
            if (action !== 'sent' && action !== 'reminder') continue;
            const list = sent_by_invite.get(String(d.subject_id)) ?? [];
            list.push({ kind: action, sent_at: to_date(d.sent_at).toISOString(), email_sent: Boolean(d.ok), provider_message_id: d.provider_message_id ?? null });
            sent_by_invite.set(String(d.subject_id), list);
        }
        return invites.map((i) => ({
            invite_id: i.id,
            email: i.email,
            role: i.role,
            kind: invite_kind(i.target, i.role),
            status: effective_status(i, now),
            inviter: inviter_by_id.get(i.invited_by) ?? null,
            send_count: i.send_count,
            last_sent_at: i.last_sent_at ? i.last_sent_at.toISOString() : null,
            expires_at: i.expires_at.toISOString(),
            deliveries: sent_by_invite.get(i.id) ?? [],
            created_at: i.created_at.toISOString(),
        }));
    }

    // ─── Revoke ──────────────────────────────────────────────────────

    /**
     * `invitations/revoke`: cancels a pending invite (found by id in either
     * table), removes its pending membership and raises `invite.<kind>.revoked`.
     *
     * @throws ApiError 404 not_found; 409 not_pending (`details.status`)
     */
    async revoke(auth: AuthContext, params: { invite_id: string; target_type?: InviteTargetType }) {
        log.debug('revoke', { invite_id: params.invite_id, user_id: auth.user?.id });
        this._require_auth(auth);
        // Route policy loaded the invite: org.members.manage, or realm admin + realms.members.manage.
        const now = new Date();
        await get_sequelize().transaction(async (t) => {
            const invite = await find_invite_by_id(params.invite_id, { prefer: params.target_type, t, lock: true });
            if (!invite) throw new ApiError('not_found', 'Invite not found', 404);
            const status = effective_status(invite, now);
            if (status !== 'pending') throw ApiError.not_pending(status);

            await invite_model(invite.table).update({ status: 'revoked' }, { where: { id: invite.id }, transaction: t });
            await drop_pending_membership(invite, now, t);
            const ctx = await load_context(invite, t);
            OrgEventService.raise_after_commit(t, {
                event: invite_event(invite_kind(invite.target, invite.role), 'revoked'),
                org_id: invite.org_id,
                realm_id: invite.realm_id,
                actor: { user_id: String(auth.user!.id) },
                data: invite_event_data(invite, ctx),
            });
        });
        log.info('invite_revoked', { invite_id: params.invite_id });
        return { invite_id: params.invite_id, status: 'revoked' as const };
    }

    // ─── Public: preview, accept, decline ────────────────────────────

    /**
     * `invitations/get_by_token`: what the invite page shows. Used, revoked
     * and expired invites are returned with that status.
     *
     * @throws ApiError 404 not_found for an unknown token
     */
    async get_by_token(_auth: AuthContext, params: { token: string }) {
        log.debug('get_by_token', {});
        const invite = params.token.trim() ? await find_invite_by_token(params.token) : null;
        if (!invite) throw new ApiError('not_found', 'Invite not found', 404);
        const ctx = await load_context(invite);
        const holder = await User.findOne({ where: { email: invite.email }, attributes: ['status', 'deleted_at'], raw: true });
        return {
            invite_id: invite.id,
            kind: invite_kind(invite.target, invite.role),
            status: effective_status(invite, new Date()),
            org: { slug: ctx.org.slug, display_name: ctx.org.display_name },
            realm: ctx.realm ? { slug: ctx.realm.slug, display_name: ctx.realm.name } : null,
            role: invite.role,
            inviter: { display_name: ctx.inviter.display_name },
            invitee_email: invite.email,
            account_exists: Boolean(holder && !holder.deleted_at && holder.status !== 'invited'),
            expires_at: invite.expires_at.toISOString(),
        };
    }

    /** @throws ApiError 410 expired, 409 not_pending */
    private _assert_open(invite: InviteRecord, now: Date): void {
        const status = effective_status(invite, now);
        if (status === 'expired') throw ApiError.expired(invite.expires_at.toISOString());
        if (status !== 'pending') throw ApiError.not_pending(status);
    }

    /**
     * `invitations/accept`: accepts or declines an invite.
     *
     * Accept: someone without an account picks a username, password and
     * display name; their invited user becomes active with their own account
     * org, and a session token is returned (`token`). An invited user that
     * already has a username (a reactivated account) keeps it and only sets
     * the password and display name. An existing account must
     * be signed in as the invited email. The membership becomes active; an
     * owner invite also makes the org active. Raises `invite.<kind>.accepted`.
     *
     * Decline: removes the pending membership and raises `invite.<kind>.declined`.
     *
     * @throws ApiError 404 not_found; 410 expired; 409 not_pending;
     *   401 sign_in_required; 403 email_mismatch; 403 account_deleted;
     *   409 conflict / deleted (username taken); 422 invalid_params
     */
    async accept(auth: AuthContext, params: {
        token: string;
        decision: 'accept' | 'decline';
        username?: string;
        password?: string;
        display_name?: string;
    }) {
        log.debug('accept', { user_id: auth.user?.id, decision: params.decision });
        const now = new Date();
        const peek = params.token.trim() ? await find_invite_by_token(params.token) : null;
        if (!peek) throw new ApiError('not_found', 'Invite not found', 404);
        this._assert_open(peek, now);

        if (params.decision === 'decline') return this._decline(auth, params.token, now);

        const signed_in = auth.user && auth.auth_via !== 'daemon_token' ? auth.user : null;
        let account: { user_id: string; username: string } | null = null;
        let new_person: (NewPerson & { placeholder_id: string | null }) | null = null;
        if (signed_in) {
            if ((signed_in.email ?? '').trim().toLowerCase() !== peek.email) throw ApiError.email_mismatch(peek.email);
            account = { user_id: String(signed_in.id), username: signed_in.username };
        } else {
            const holder = await User.findOne({ where: { email: peek.email }, attributes: ['id', 'username', 'display_name', 'status', 'deleted_at'], raw: true });
            if (holder?.deleted_at) throw ApiError.account_deleted();
            if (holder && holder.status !== 'invited') throw ApiError.sign_in_required(peek.email);
            new_person = { placeholder_id: holder ? String(holder.id) : null, ...await this._new_account_fields(params, holder?.username ? holder : null) };
        }

        const done = await on_name_race(() => get_sequelize().transaction(async (t) => {
            const invite = await find_invite_by_token(params.token, { t, lock: true });
            if (!invite) throw new ApiError('not_found', 'Invite not found', 404);
            this._assert_open(invite, now);

            const user = account ?? await this._activate_new_person(new_person!, invite.email, t);
            await this._join(invite, user.user_id, now, t);
            await invite_model(invite.table).update({
                status: 'accepted', accepted_at: now, accepted_user_id: user.user_id, decided_at: now, decision: 'accept',
            }, { where: { id: invite.id }, transaction: t });

            const ctx = await load_context(invite, t);
            OrgEventService.raise_after_commit(t, {
                event: invite_event(invite_kind(invite.target, invite.role), 'accepted'),
                org_id: invite.org_id,
                realm_id: invite.realm_id,
                actor: { user_id: user.user_id },
                data: invite_event_data(invite, ctx, { accepted_user: { id: user.user_id, username: user.username }, decision: 'accept' }),
            });
            return { invite, ctx, user };
        }), async () => {
            if (new_person && !new_person.kept) await assert_namespace_free(this._ns(), new_person.username, ['org', 'scope', 'user'], 'username');
        });

        const { invite, ctx, user } = done;
        await this._after_accept(invite, ctx, user);

        const created = new_person !== null;
        const result: {
            decision: 'accept';
            user: { id: string; username: string; status: 'active'; created: boolean };
            org: { id: string; slug: string };
            realm: { id: string; slug: string } | null;
            membership: { role: string; status: 'active' };
            token?: string;
        } = {
            decision: 'accept',
            user: { id: user.user_id, username: user.username, status: 'active', created },
            org: { id: ctx.org.id, slug: ctx.org.slug },
            realm: ctx.realm ? { id: ctx.realm.id, slug: ctx.realm.slug } : null,
            membership: { role: invite.role, status: 'active' },
        };
        if (created) {
            // Session PAT (cliq_tok_…), the same credential sign-in returns.
            if (!this._mint_session_pat) throw new ApiError('internal_error', 'Session token minting unavailable', 500);
            result.token = (await this._mint_session_pat(user.user_id)).token;
        }
        log.info('invite_accepted', { invite_id: invite.id, kind: invite_kind(invite.target, invite.role), user_id: user.user_id, created });
        return result;
    }

    /**
     * What follows an accept once it committed: the org's default realm (org
     * invites), the member's in-app channel in the org they joined, and the
     * account's default realm. Each is created again on demand later, so a
     * failure here is logged and the accept still answers.
     */
    private async _after_accept(invite: InviteRecord, ctx: InviteContext, user: { user_id: string; username: string }): Promise<void> {
        const steps: Array<[string, () => Promise<unknown>]> = [
            ['org_default_realm', async () => { if (invite.target === 'org') await RealmService.ensure_org_default_realm(ctx.org.slug, user.user_id, user.user_id); }],
            ['member_channel', () => ensure_per_user_channel(user.user_id, invite.org_id, user.username)],
            ['account_default_realm', () => RealmService.ensure_personal_realm(user.user_id, user.username)],
        ];
        for (const [step, work] of steps) {
            try {
                await work();
            } catch (err) {
                log.warn('accept_follow_up_failed', { invite_id: invite.id, step, error: err instanceof Error ? err.message : String(err) });
            }
        }
    }

    /** Declines a pending invite: the pending membership goes, `invite.<kind>.declined` is raised. */
    private async _decline(auth: AuthContext, token: string, now: Date): Promise<{ decision: 'decline' }> {
        const invite_id = await get_sequelize().transaction(async (t) => {
            const invite = await find_invite_by_token(token, { t, lock: true });
            if (!invite) throw new ApiError('not_found', 'Invite not found', 404);
            this._assert_open(invite, now);
            await invite_model(invite.table).update({ status: 'declined', decided_at: now, decision: 'decline' }, { where: { id: invite.id }, transaction: t });
            await drop_pending_membership(invite, now, t);
            const ctx = await load_context(invite, t);
            const invitee = auth.user ? null : await User.findOne({ where: { email: invite.email }, attributes: ['id'], raw: true, transaction: t });
            const actor: EventActor = auth.user ? { user_id: String(auth.user.id) }
                : invitee ? { user_id: String(invitee.id) }
                : { invitee_email: invite.email };
            OrgEventService.raise_after_commit(t, {
                event: invite_event(invite_kind(invite.target, invite.role), 'declined'),
                org_id: invite.org_id,
                realm_id: invite.realm_id,
                actor,
                data: invite_event_data(invite, ctx, { decision: 'decline' }),
            });
            return invite.id;
        });
        log.info('invite_declined', { invite_id });
        return { decision: 'decline' };
    }

    /**
     * Checks the username, password and display name a new person sends.
     *
     * @param kept - The invited user's existing username and display name (a
     *   reactivated account): the username is kept and the sent one ignored.
     * @throws ApiError 422 invalid_params; 409 conflict / deleted (username taken)
     */
    private async _new_account_fields(
        params: { username?: string; password?: string; display_name?: string },
        kept: { username: string; display_name: string } | null,
    ): Promise<NewPerson> {
        const password = params.password ?? '';
        assert_password_rules(password);
        if (kept) {
            return {
                username: kept.username,
                kept: true,
                password_hash: await hash_password(password),
                display_name: params.display_name?.trim() || kept.display_name || kept.username,
            };
        }
        const username = normalize_username(params.username);
        // The username is also the person's scope and account org.
        await assert_namespace_free(this._ns(), username, ['org', 'scope', 'user'], 'username');
        return {
            username,
            kept: false,
            password_hash: await hash_password(password),
            display_name: params.display_name?.trim() || username,
        };
    }

    /**
     * Turns the invited user into an active account (or creates it) with the
     * chosen fields, their scope and their account org.
     */
    private async _activate_new_person(
        person: NewPerson & { placeholder_id: string | null },
        email: string,
        t: Transaction,
    ): Promise<{ user_id: string; username: string }> {
        const fields = { username: person.username, password_hash: person.password_hash, display_name: person.display_name, status: 'active' as const };
        let user_id: string;
        if (person.placeholder_id) {
            const [count] = await User.update(fields, { where: { id: person.placeholder_id, status: 'invited', deleted_at: null }, transaction: t });
            if (count !== 1) throw ApiError.sign_in_required(email);
            user_id = person.placeholder_id;
        } else {
            user_id = String((await User.create({ ...fields, email, role: 'user' }, { transaction: t })).id);
        }
        const scope = await Scope.findOne({ where: { slug: person.username }, attributes: ['id'], raw: true, transaction: t });
        if (!scope) {
            await Scope.create({ slug: person.username, display_name: person.display_name, owner_id: user_id, visibility: 'public', scope_type: 'user' } as never, { transaction: t });
        }
        await ensure_account_org(user_id, person.username, t);
        return { user_id, username: person.username };
    }

    /**
     * Makes the membership active. An owner invite also makes its org active
     * (first activation time kept), sets the owner when the org has none and
     * adds the owner to the org's publishing scope. A realm invite also makes
     * the person a Member of the realm's org.
     */
    private async _join(invite: InviteRecord, user_id: string, now: Date, t: Transaction): Promise<void> {
        if (invite.target === 'realm') {
            await activate_realm_membership(invite.realm_id!, user_id, invite.role as RealmInviteRole, t);
            await activate_org_membership(invite.org_id, user_id, 'member', now, t, true);
            return;
        }
        await activate_org_membership(invite.org_id, user_id, invite.role as OrgInviteRole, now, t);
        if (invite.role !== 'owner') return;

        const org = await Org.findByPk(invite.org_id, { attributes: ['id', 'status', 'activated_at', 'owner_id', 'default_scope_id'], raw: true, transaction: t });
        if (!org) throw new ApiError('not_found', 'Org not found', 404);
        await Org.update({
            status: 'active',
            activated_at: org.activated_at ?? now,
            owner_id: org.status === 'waiting_for_owner' || !org.owner_id ? user_id : org.owner_id,
        }, { where: { id: org.id }, transaction: t });
        if (org.default_scope_id) {
            const scope_member = await ScopeMember.findOne({ where: { scope_id: org.default_scope_id, user_id }, attributes: ['scope_id'], raw: true, transaction: t });
            if (!scope_member) await ScopeMember.create({ scope_id: org.default_scope_id, user_id } as never, { transaction: t });
        }
    }
}
