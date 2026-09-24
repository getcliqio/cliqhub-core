/**
 * Hub Notifications API controller — channels, rules, inbox.
 *
 * Paths locked by SLICE-notifications-api-flat-hard-cut (no path changes).
 * Envelope: `{ ok: true, data }` per SLICE-notifications-api-dto-envelope.
 */

import { BaseController } from './base_controller.js';
import { NotificationService } from '../services/notification.service.js';
import { InAppNotificationService } from '../services/in_app_notification.service.js';
import { ApiError } from '../lib/api_error.js';
import type { ApiOkResponse, ApiRequest, BooleanData, PagedData } from '../types/api_response.js';
import type { Request } from 'express';
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
     * List channels (account or realm).
     * @param req - Body: {@link NotificationChannelsGetInput}
     * @param res - `{ ok: true, data: NotificationChannelData[] }`
     */
    async channels_get(req: ApiRequest<NotificationChannelsGetInput, NotificationChannelData[]>, res: ApiOkResponse<NotificationChannelData[]>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const org_id = req.user?.current_org_id;
        const body = this.parse_body(NotificationChannelsGetInput, req);
        const realm_id = body.realm_id?.trim();
        // Account list when explicitly requested or when no realm is in the body.
        const want_account = body.account === true || !realm_id;

        if (want_account) {
            // Org-level channels (realm_id IS NULL), filtered to the active org.
            const channels = await NotificationService.list_channels({ account: true, org_id, query: body.query });
            this.ok(res, body.enabled === true ? channels.filter((ch) => ch.enabled) : channels);
            return;
        }

        // Realm path — any realm member may read channels.
        await require_realm_notification_member(realm_id!, user_id);
        // Fast path: resolve a known id set and keep only this realm's enabled rows.
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
     * @param req - Body: {@link NotificationChannelsCreateInput}
     * @param res - `{ ok: true, data: NotificationChannelData }`
     */
    async channels_create(req: ApiRequest<NotificationChannelsCreateInput, NotificationChannelData>, res: ApiOkResponse<NotificationChannelData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const org_id = req.user?.current_org_id;
        const data = this.parse_body(NotificationChannelsCreateInput, req);
        const realm_id = data.realm_id?.trim();

        // channel_ref destinations must not form a cycle with existing channels.
        if (data.destinations) {
            await NotificationService.detect_channel_ref_cycles(data.name, data.destinations, realm_id ?? null);
        }

        // Realm create needs realm admin; account create needs account notification admin.
        if (realm_id) {
            await require_realm_notification_admin(realm_id, user_id, req);
        }
        if (!realm_id) {
            await require_account_notification_admin(req);
        }

        // Account channels carry org_id; realm channels leave org_id null (scoped by realm).
        const channel = await NotificationService.create_channel({
            realm_id: realm_id ?? null,
            org_id: realm_id ? null : (org_id ?? null),
            name: data.name,
            destinations: data.destinations,
            enabled: data.enabled,
        });
        this.ok(res, channel);
    }

    /**
     * Update a channel.
     * @param req - Body: {@link NotificationChannelsUpdateInput}
     * @param res - `{ ok: true, data: NotificationChannelData }`
     */
    async channels_update(req: ApiRequest<NotificationChannelsUpdateInput, NotificationChannelData>, res: ApiOkResponse<NotificationChannelData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const data = this.parse_body(NotificationChannelsUpdateInput, req);
        const existing = await NotificationService.get_channel(data.id);
        // Cross-org channel ids must not be writable via the active org session.
        await this.assert_channel_in_org(existing, req.user?.current_org_id);
        await this.require_channel_write_auth(existing, user_id, req);

        // Re-validate refs when destinations change (name may also be renaming).
        if (data.destinations) {
            await NotificationService.detect_channel_ref_cycles(data.name ?? existing.name, data.destinations, existing.realm_id);
        }

        this.ok(res, await NotificationService.update_channel(data));
    }

    /**
     * Remove a channel.
     * @param req - Body: {@link NotificationChannelsRemoveInput}
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async channels_remove(req: ApiRequest<NotificationChannelsRemoveInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const { id } = this.parse_body(NotificationChannelsRemoveInput, req);
        // Load first so authz can inspect realm/owner before destroy.
        const existing = await NotificationService.get_channel(id);
        await this.assert_channel_in_org(existing, req.user?.current_org_id);
        await this.require_channel_write_auth(existing, user_id, req);
        this.ok(res, await NotificationService.remove_channel(id));
    }

    /**
     * Fire a synthetic test through the channel.
     * @param req - Body: {@link NotificationChannelsTestInput}
     * @param res - `{ ok: true, data: NotificationChannelTestData }`
     */
    async channels_test(req: ApiRequest<NotificationChannelsTestInput, NotificationChannelTestData>, res: ApiOkResponse<NotificationChannelTestData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const { id, destination_index } = this.parse_body(NotificationChannelsTestInput, req);
        const channel = await NotificationService.get_channel(id);
        await this.assert_channel_in_org(channel, req.user?.current_org_id);
        // Same write auth as update — testing delivers to real destinations.
        await this.require_channel_write_auth(channel, user_id, req);

        const { delivered, errors } = await NotificationService.test_channel(id, destination_index);
        this.ok(res, { delivered, errors });
    }

    /**
     * List rules (org or realm/team). Served under `/v1/orgs/*` and `/v1/realms/*`.
     * @param req - Body: {@link NotificationRulesListInput}
     * @param res - `{ ok: true, data: NotificationRuleData[] }`
     */
    async rules_list(req: ApiRequest<NotificationRulesListInput, NotificationRuleData[]>, res: ApiOkResponse<NotificationRuleData[]>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const org_id = req.user?.current_org_id;
        const body = this.parse_body(NotificationRulesListInput, req);
        const realm_id = body.realm_id?.trim();

        if (realm_id) {
            await require_realm_notification_member(realm_id, user_id);
        }
        // effective = merge org + realm tiers for UI "what actually fires".
        if (realm_id && body.effective) {
            this.ok(res, await NotificationService.list_effective_rules(realm_id, org_id));
            return;
        }
        if (realm_id) {
            this.ok(res, await NotificationService.list_rules({ realm_id, team_slug: body.team_slug }));
            return;
        }

        // No realm → org-global rules only.
        this.ok(res, await NotificationService.list_rules({ org_id }));
    }

    /**
     * Create or update a rule.
     * @param req - Body: {@link NotificationRulesSetInput}
     * @param res - `{ ok: true, data: NotificationRuleData }`
     */
    async rules_set(req: ApiRequest<NotificationRulesSetInput, NotificationRuleData>, res: ApiOkResponse<NotificationRuleData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const org_id = req.user?.current_org_id;
        const data = this.parse_body(NotificationRulesSetInput, req);
        const realm_id = data.realm_id?.trim();

        if (realm_id) {
            await require_realm_notification_admin(realm_id, user_id, req);
        }
        if (!realm_id) {
            await require_account_notification_admin(req);
        }

        // Upsert by (scope, event, channel); service owns uniqueness.
        this.ok(res, await NotificationService.set_rule({
            realm_id: realm_id || null,
            org_id: realm_id ? null : (org_id ?? null),
            team_slug: data.team_slug || null,
            event: data.event,
            channel_id: data.channel_id,
            priority: data.priority,
        }));
    }

    /**
     * Delete a rule by ID.
     * @param req - Body: {@link NotificationRulesRemoveInput}
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async rules_remove(req: ApiRequest<NotificationRulesRemoveInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        // Authn only here — path-level admin checks live on the org/realm route mounts.
        require_authenticated_user_id(req);
        const { id } = this.parse_body(NotificationRulesRemoveInput, req);
        this.ok(res, await NotificationService.remove_rule(id));
    }

    /**
     * In-app inbox for the caller.
     * @param req - Body: {@link NotificationsGetInput}
     * @param res - `{ ok: true, data: PagedData<NotificationData> }`
     */
    async inbox_get(req: ApiRequest<NotificationsGetInput, PagedData<NotificationData>>, res: ApiOkResponse<PagedData<NotificationData>>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        const body = this.parse_body(NotificationsGetInput, req) ?? {};
        const offset = body.offset ?? 0;
        const limit = body.limit ?? 50;
        // Inbox is always the caller's user_id; org_id bounds which realms appear.
        const result = await InAppNotificationService.list_for_user({
            user_id,
            org_id: req.user?.current_org_id,
            ...body,
            limit,
            offset,
        });
        this.ok(res, { items: result.notifications, total: result.total, offset, limit });
    }

    /** Reject channels that belong to another org. */
    private async assert_channel_in_org(channel: { realm_id: string | null; org_id?: string | null }, current_org_id: string | undefined): Promise<void> {
        // No active org on the session → skip (e.g. some token shapes).
        if (!current_org_id) return;

        if (channel.realm_id) {
            // Realm-owned channel: compare the realm's org to the session org.
            const { Realm } = await import('../models/index.js');
            const realm = await Realm.findByPk(channel.realm_id, { attributes: ['org_id'] });
            if (realm && realm.org_id !== current_org_id) {
                throw ApiError.forbidden('Channel does not belong to the active org');
            }
            return;
        }

        // Account channel: org_id is on the row itself.
        if (channel.org_id && channel.org_id !== current_org_id) {
            throw ApiError.forbidden('Channel does not belong to the active org');
        }
    }

    /** Realm admin, channel owner, or account notification admin. */
    private async require_channel_write_auth(channel: { realm_id: string | null; user_id?: string | null }, user_id: string, req: Request): Promise<void> {
        if (channel.realm_id) {
            await require_realm_notification_admin(channel.realm_id, user_id, req);
            return;
        }
        // Personal account channel — owner may mutate without account-admin role.
        if (channel.user_id && String(channel.user_id) === user_id) return;
        await require_account_notification_admin(req);
    }
}

/** @deprecated Use NotificationsController. */
export const NotificationController = NotificationsController;
