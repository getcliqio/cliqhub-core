/**
 * Hub Notifications API controller — channels, rules, inbox.
 *
 * Paths locked by SLICE-notifications-api-flat-hard-cut (no path changes).
 * Envelope: `{ ok: true, data }` per SLICE-notifications-api-dto-envelope.
 *
 * Tenancy (NTF-ORG / SLICE-notifications-explicit-org-id):
 * - Account invent / org rules / inbox: body `org_id` + assert_org_authorized — never X-Org-Id.
 * - Realm-scoped: body `realm_id` is SoT.
 * - Id-keyed mutate: load row → authz; no soft header org gate.
 */

import { BaseController } from './base_controller.js';
import { NotificationService } from '../services/notification.service.js';
import { InAppNotificationService } from '../services/in_app_notification.service.js';
import { ApiError } from '../lib/api_error.js';
import type { ApiOkResponse, ApiRequest, BooleanData, PagedData } from '../types/api_response.js';
import type { AuthContext } from '../types/vo.js';
import type { Request } from 'express';
import { Realm, NotificationRule } from '../models/index.js';
import {
    require_account_notification_admin,
    require_authenticated_user_id,
    require_realm_notification_admin,
    require_realm_notification_member,
} from '../notifications/notification_authz.js';
import type {
    NotificationChannelData,
    NotificationChannelTestData,
    NotificationData,
    NotificationRuleData,
} from '../schemas/notifications/data.js';
import {
    NotificationChannelsCreateInput,
    NotificationChannelsGetInput,
    NotificationChannelsRemoveInput,
    NotificationChannelsTestInput,
    NotificationChannelsUpdateInput,
    NotificationRulesListInput,
    NotificationRulesRemoveInput,
    NotificationRulesSetInput,
    NotificationsGetInput,
} from '../schemas/notifications/inputs.js';

export class NotificationsController extends BaseController {

    /**
     * Bearer must be allowed to act on `org_id`.
     * PAT/session: org_id ∈ auth.org_ids. Daemon token: realm.org_id === org_id.
     * Site hub admin may act on any org_id.
     */
    private async assert_org_authorized(auth: AuthContext | undefined, org_id: string): Promise<void> {
        // No credential context — refuse rather than invent tenancy.
        if (!auth) {
            throw ApiError.unauthorized('authentication required');
        }

        // Site admin may target any org (account channel admin path).
        if (auth.user?.role === 'admin') return;

        // Daemon tokens are realm-bound; tenancy is the realm's org.
        if (auth.auth_via === 'daemon_token') {
            if (!auth.realm_id) {
                throw ApiError.forbidden('daemon token has no realm binding');
            }
            const realm = await Realm.findByPk(auth.realm_id);
            if (!realm || realm.org_id !== org_id) {
                throw ApiError.forbidden('org_id does not match daemon realm organization');
            }
            return;
        }

        // PAT / session: live membership list from auth middleware.
        if (!auth.org_ids.includes(org_id)) {
            throw ApiError.forbidden('not a member of the requested organization');
        }
    }

    private auth_from(req: Request): AuthContext | undefined {
        return req.auth;
    }

    /**
     * List channels (account or realm).
     * Account mode requires body `org_id`. Realm mode uses `realm_id`.
     * @param req - Body: {@link NotificationChannelsGetInput}
     * @param res - `{ ok: true, data: NotificationChannelData[] }`
     */
    async channels_get(req: ApiRequest<NotificationChannelsGetInput, NotificationChannelData[]>, res: ApiOkResponse<NotificationChannelData[]>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        // Zod SoT — account mode requires org_id; never invent from X-Org-Id.
        const body = this.parse_body(NotificationChannelsGetInput, req);
        const realm_id = body.realm_id?.trim();
        const want_account = body.account === true || !realm_id;

        if (want_account) {
            // Account list: body.org_id bounds which org's channels appear.
            await this.assert_org_authorized(this.auth_from(req), body.org_id!);
            const channels = await NotificationService.list_channels({
                account: true,
                org_id: body.org_id,
                query: body.query,
            });
            this.ok(res, body.enabled === true ? channels.filter((ch) => ch.enabled) : channels);
            return;
        }

        // Realm path — any realm member may read channels.
        await require_realm_notification_member(realm_id!, user_id);
        if (body.enabled === true && body.ids?.length) {
            const channels = await NotificationService.find_enabled_channels(body.ids);
            this.ok(res, channels.filter((ch) => ch.realm_id === realm_id));
            return;
        }
        const channels = await NotificationService.list_channels({ realm_id, query: body.query });
        this.ok(res, body.enabled === true ? channels.filter((ch) => ch.enabled) : channels);
    }

    /**
     * Create a channel.
     * Account create requires body `org_id`. Realm create uses `realm_id` only.
     * @param req - Body: {@link NotificationChannelsCreateInput}
     * @param res - `{ ok: true, data: NotificationChannelData }`
     */
    async channels_create(req: ApiRequest<NotificationChannelsCreateInput, NotificationChannelData>, res: ApiOkResponse<NotificationChannelData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        // Zod SoT — account mode requires org_id; never invent from X-Org-Id.
        const data = this.parse_body(NotificationChannelsCreateInput, req);
        const realm_id = data.realm_id?.trim();

        // channel_ref destinations must not form a cycle with existing channels.
        if (data.destinations) {
            await NotificationService.detect_channel_ref_cycles(data.name, data.destinations, realm_id ?? null);
        }

        if (realm_id) {
            // Realm create: realm admin; org_id on row stays null.
            await require_realm_notification_admin(realm_id, user_id, req);
            const channel = await NotificationService.create_channel({
                realm_id,
                org_id: null,
                name: data.name,
                destinations: data.destinations,
                enabled: data.enabled,
            });
            this.ok(res, channel);
            return;
        }

        // Account create: body.org_id is invent SoT.
        await this.assert_org_authorized(this.auth_from(req), data.org_id!);
        await require_account_notification_admin(req, data.org_id!);
        const channel = await NotificationService.create_channel({
            realm_id: null,
            org_id: data.org_id!,
            name: data.name,
            destinations: data.destinations,
            enabled: data.enabled,
        });
        this.ok(res, channel);
    }

    /**
     * Update a channel. Load-based authz — no soft header org gate.
     * @param req - Body: {@link NotificationChannelsUpdateInput}
     * @param res - `{ ok: true, data: NotificationChannelData }`
     */
    async channels_update(req: ApiRequest<NotificationChannelsUpdateInput, NotificationChannelData>, res: ApiOkResponse<NotificationChannelData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const data = this.parse_body(NotificationChannelsUpdateInput, req);
        // Load first so authz inspects owning realm/org (never session header).
        const existing = await NotificationService.get_channel(data.id);
        await this.require_channel_write_auth(existing, user_id, req);

        if (data.destinations) {
            await NotificationService.detect_channel_ref_cycles(data.name ?? existing.name, data.destinations, existing.realm_id);
        }

        this.ok(res, await NotificationService.update_channel(data));
    }

    /**
     * Remove a channel. Load-based authz — no soft header org gate.
     * @param req - Body: {@link NotificationChannelsRemoveInput}
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async channels_remove(req: ApiRequest<NotificationChannelsRemoveInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const { id } = this.parse_body(NotificationChannelsRemoveInput, req);
        const existing = await NotificationService.get_channel(id);
        await this.require_channel_write_auth(existing, user_id, req);
        this.ok(res, await NotificationService.remove_channel(id));
    }

    /**
     * Fire a synthetic test through the channel. Same write auth as update.
     * @param req - Body: {@link NotificationChannelsTestInput}
     * @param res - `{ ok: true, data: NotificationChannelTestData }`
     */
    async channels_test(req: ApiRequest<NotificationChannelsTestInput, NotificationChannelTestData>, res: ApiOkResponse<NotificationChannelTestData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const { id, destination_index } = this.parse_body(NotificationChannelsTestInput, req);
        const channel = await NotificationService.get_channel(id);
        await this.require_channel_write_auth(channel, user_id, req);

        const { delivered, errors } = await NotificationService.test_channel(id, destination_index);
        this.ok(res, { delivered, errors });
    }

    /**
     * List rules (org or realm/team). Served under `/v1/orgs/*` and `/v1/realms/*`.
     * Org-global list requires body `org_id`. Realm list uses `realm_id`.
     * @param req - Body: {@link NotificationRulesListInput}
     * @param res - `{ ok: true, data: NotificationRuleData[] }`
     */
    async rules_list(req: ApiRequest<NotificationRulesListInput, NotificationRuleData[]>, res: ApiOkResponse<NotificationRuleData[]>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const body = this.parse_body(NotificationRulesListInput, req);
        const realm_id = body.realm_id?.trim();

        if (realm_id) {
            await require_realm_notification_member(realm_id, user_id);
            // effective = merge org + realm tiers; org tier from realm's owning org.
            if (body.effective) {
                const realm = await Realm.findByPk(realm_id, { attributes: ['org_id'] });
                this.ok(res, await NotificationService.list_effective_rules(realm_id, realm?.org_id ?? undefined));
                return;
            }
            this.ok(res, await NotificationService.list_rules({ realm_id, team_slug: body.team_slug }));
            return;
        }

        // Org-global rules: body.org_id is SoT.
        await this.assert_org_authorized(this.auth_from(req), body.org_id!);
        this.ok(res, await NotificationService.list_rules({ org_id: body.org_id }));
    }

    /**
     * Create or update a rule.
     * Org-global set requires body `org_id`. Realm set uses `realm_id`.
     * @param req - Body: {@link NotificationRulesSetInput}
     * @param res - `{ ok: true, data: NotificationRuleData }`
     */
    async rules_set(req: ApiRequest<NotificationRulesSetInput, NotificationRuleData>, res: ApiOkResponse<NotificationRuleData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const data = this.parse_body(NotificationRulesSetInput, req);
        const realm_id = data.realm_id?.trim();

        if (realm_id) {
            await require_realm_notification_admin(realm_id, user_id, req);
            this.ok(res, await NotificationService.set_rule({
                realm_id,
                org_id: null,
                team_slug: data.team_slug || null,
                event: data.event,
                channel_id: data.channel_id,
                priority: data.priority,
            }));
            return;
        }

        // Org-global rule: body.org_id invent SoT.
        await this.assert_org_authorized(this.auth_from(req), data.org_id!);
        await require_account_notification_admin(req, data.org_id!);
        this.ok(res, await NotificationService.set_rule({
            realm_id: null,
            org_id: data.org_id!,
            team_slug: data.team_slug || null,
            event: data.event,
            channel_id: data.channel_id,
            priority: data.priority,
        }));
    }

    /**
     * Delete a rule by ID. Load rule → authz on owning org/realm.
     * @param req - Body: {@link NotificationRulesRemoveInput}
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async rules_remove(req: ApiRequest<NotificationRulesRemoveInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const { id } = this.parse_body(NotificationRulesRemoveInput, req);
        // Load before destroy so we can authorize against owning scope.
        const rule = await NotificationRule.findByPk(id);
        if (!rule) {
            this.ok(res, false);
            return;
        }

        if (rule.realm_id) {
            await require_realm_notification_admin(rule.realm_id, user_id, req);
            this.ok(res, await NotificationService.remove_rule(id));
            return;
        }

        // Org-global rule: authorize against the rule's org_id.
        const rule_org = rule.org_id ? String(rule.org_id) : null;
        if (!rule_org) {
            throw ApiError.forbidden('Cannot remove rule without org or realm scope');
        }
        await this.assert_org_authorized(this.auth_from(req), rule_org);
        await require_account_notification_admin(req, rule_org);
        this.ok(res, await NotificationService.remove_rule(id));
    }

    /**
     * In-app inbox for the caller. Body `org_id` bounds which org's events appear.
     * @param req - Body: {@link NotificationsGetInput}
     * @param res - `{ ok: true, data: PagedData<NotificationData> }`
     */
    async inbox_get(req: ApiRequest<NotificationsGetInput, PagedData<NotificationData>>, res: ApiOkResponse<PagedData<NotificationData>>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        // Zod SoT — org_id required; never invent from X-Org-Id.
        const body = this.parse_body(NotificationsGetInput, req);
        await this.assert_org_authorized(this.auth_from(req), body.org_id);

        const offset = body.offset ?? 0;
        const limit = body.limit ?? 50;
        // Spread filters without re-specifying org_id / pagination.
        const { org_id, offset: _off, limit: _lim, ...filters } = body;
        // Inbox is always the caller's user_id; body.org_id bounds which realms appear.
        const result = await InAppNotificationService.list_for_user({
            ...filters,
            user_id,
            org_id,
            limit,
            offset,
        });
        this.ok(res, { items: result.notifications, total: result.total, offset, limit });
    }

    /** Realm admin, channel owner, or account notification admin for the channel's org. */
    private async require_channel_write_auth(
        channel: { realm_id: string | null; org_id?: string | null; user_id?: string | null },
        user_id: string,
        req: Request,
    ): Promise<void> {
        if (channel.realm_id) {
            await require_realm_notification_admin(channel.realm_id, user_id, req);
            return;
        }
        // Personal account channel — owner may mutate without account-admin role.
        if (channel.user_id && String(channel.user_id) === user_id) return;

        const channel_org = channel.org_id ? String(channel.org_id) : null;
        if (!channel_org) {
            throw ApiError.forbidden('Account channel has no org_id');
        }
        await this.assert_org_authorized(this.auth_from(req), channel_org);
        await require_account_notification_admin(req, channel_org);
    }
}

/** @deprecated Use NotificationsController. */
export const NotificationController = NotificationsController;
