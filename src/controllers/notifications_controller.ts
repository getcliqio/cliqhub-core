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
import { get_logger } from '../lib/log.js';
import { NotificationService } from '../services/notification.service.js';
import { InAppNotificationService } from '../services/in_app_notification.service.js';
import type { ApiOkResponse, ApiRequest, BooleanData, PagedData } from '../types/api_response.js';
import {
    require_authenticated_user_id,
} from '../notifications/notification_authz.js';
import type {
    NotificationChannelData,
    NotificationChannelTestData,
    NotificationData,
    NotificationRuleData,
} from '../schemas/notification_types.js';
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
} from '../schemas/notification_types.js';

const log = get_logger('ctrl.notifications');

export class NotificationsController extends BaseController {

    /**
     * List channels (account or realm).
     * Account mode requires body `org_id`. Realm mode uses `realm_id`.
     * @param req - Body: {@link NotificationChannelsGetInput}
     * @param res - `{ ok: true, data: NotificationChannelData[] }`
     */
    async channels_get(req: ApiRequest<NotificationChannelsGetInput, NotificationChannelData[]>, res: ApiOkResponse<NotificationChannelData[]>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        log.debug('channels_get', { user_id });
        // Zod SoT — account mode requires org_id; never invent from X-Org-Id.
        const body = this.parse_body(NotificationChannelsGetInput, req);
        const realm_id = body.realm_id?.trim();
        const want_account = body.account === true || !realm_id;

        if (want_account) {
            // Account list: body.org_id bounds which org's channels appear. The route
            // policy checked org membership, unless realm_id was also sent (it then
            // checked the realm) — only that case needs the org check here.
            if (realm_id) await this.assert_org_authorized(this.auth_from(req), body.org_id!);
            const channels = await NotificationService.list_channels({
                account: true,
                org_id: body.org_id,
                query: body.query,
            });
            this.ok(res, body.enabled === true ? channels.filter((ch) => ch.enabled) : channels);
            return;
        }

        // Realm path — route policy: realm view.
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
        log.debug('channels_create', { user_id });
        // Zod SoT — account mode requires org_id; never invent from X-Org-Id.
        const data = this.parse_body(NotificationChannelsCreateInput, req);
        const realm_id = data.realm_id?.trim();

        // channel_ref destinations must not form a cycle with existing channels.
        if (data.destinations) {
            await NotificationService.detect_channel_ref_cycles(data.name, data.destinations, realm_id ?? null);
        }

        if (realm_id) {
            // Realm create (policy: operate + channels.manage.realm); org_id on row stays null.
            const channel = await NotificationService.create_channel({
                realm_id,
                org_id: null,
                name: data.name,
                destinations: data.destinations,
                enabled: data.enabled,
            });
            log.info('channel_created', { id: channel.id });
            this.ok(res, channel);
            return;
        }

        // Account create (policy: org channels.manage): body.org_id is invent SoT.
        const channel = await NotificationService.create_channel({
            realm_id: null,
            org_id: data.org_id!,
            name: data.name,
            destinations: data.destinations,
            enabled: data.enabled,
        });
        log.info('channel_created', { id: channel.id });
        this.ok(res, channel);
    }

    /**
     * Update a channel. Load-based authz — no soft header org gate.
     * @param req - Body: {@link NotificationChannelsUpdateInput}
     * @param res - `{ ok: true, data: NotificationChannelData }`
     */
    async channels_update(req: ApiRequest<NotificationChannelsUpdateInput, NotificationChannelData>, res: ApiOkResponse<NotificationChannelData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        log.debug('channels_update', { user_id });
        const data = this.parse_body(NotificationChannelsUpdateInput, req);
        // Route policy checked the channel's realm / org / personal owner.
        const existing = await NotificationService.get_channel(data.id);

        if (data.destinations) {
            await NotificationService.detect_channel_ref_cycles(data.name ?? existing.name, data.destinations, existing.realm_id);
        }

        const updated = await NotificationService.update_channel(data);
        log.info('channel_updated', { id: data.id });
        this.ok(res, updated);
    }

    /**
     * Remove a channel. Load-based authz — no soft header org gate.
     * @param req - Body: {@link NotificationChannelsRemoveInput}
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async channels_remove(req: ApiRequest<NotificationChannelsRemoveInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        log.debug('channels_remove', { user_id });
        const { id } = this.parse_body(NotificationChannelsRemoveInput, req);
        // Route policy checked the channel's realm / org / personal owner.
        const result = await NotificationService.remove_channel(id);
        log.info('channel_removed', { id });
        this.ok(res, result);
    }

    /**
     * Fire a synthetic test through the channel. Same write auth as update.
     * @param req - Body: {@link NotificationChannelsTestInput}
     * @param res - `{ ok: true, data: NotificationChannelTestData }`
     */
    async channels_test(req: ApiRequest<NotificationChannelsTestInput, NotificationChannelTestData>, res: ApiOkResponse<NotificationChannelTestData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        log.debug('channels_test', { user_id });
        const { id, destination_index } = this.parse_body(NotificationChannelsTestInput, req);
        // Route policy: channels.test on the channel's realm / org, or its personal owner.
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
        log.debug('rules_list', { user_id });
        const body = this.parse_body(NotificationRulesListInput, req);
        const realm_id = body.realm_id?.trim();

        // Route policy: realm view when realm_id is set, else org membership.
        if (realm_id) {
            if (body.effective) {
                this.ok(res, await NotificationService.list_effective_rules(realm_id));
                return;
            }
            this.ok(res, await NotificationService.list_rules({ realm_id, team_slug: body.team_slug }));
            return;
        }

        // Org-global rules: body.org_id is SoT.
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
        log.debug('rules_set', { user_id });
        const data = this.parse_body(NotificationRulesSetInput, req);
        const realm_id = data.realm_id?.trim();

        // Route policy: operate + rules.manage.realm when realm_id is set, else org rules.manage.
        if (realm_id) {
            const rule = await NotificationService.set_rule({
                realm_id,
                org_id: null,
                team_slug: data.team_slug || null,
                event: data.event,
                channel_id: data.channel_id,
                priority: data.priority,
                recipients: data.recipients,
            });
            log.info('rule_set', { id: rule.id });
            this.ok(res, rule);
            return;
        }

        // Org-global rule: body.org_id invent SoT.
        const rule = await NotificationService.set_rule({
            realm_id: null,
            org_id: data.org_id!,
            team_slug: data.team_slug || null,
            event: data.event,
            channel_id: data.channel_id,
            priority: data.priority,
            recipients: data.recipients,
        });
        log.info('rule_set', { id: rule.id });
        this.ok(res, rule);
    }

    /**
     * Delete a rule by ID. Load rule → authz on owning org/realm.
     * @param req - Body: {@link NotificationRulesRemoveInput}
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async rules_remove(req: ApiRequest<NotificationRulesRemoveInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        log.debug('rules_remove', { user_id });
        const { id } = this.parse_body(NotificationRulesRemoveInput, req);
        // Route policy loaded the rule: realm operate + rules.manage.realm, or org
        // rules.manage (org-global rule); a missing rule is already a 404.
        const removed = await NotificationService.remove_rule(id);
        log.info('rule_removed', { id });
        this.ok(res, removed);
    }

    /**
     * In-app inbox for the caller. Body `org_id` bounds which org's events appear.
     * @param req - Body: {@link NotificationsGetInput}
     * @param res - `{ ok: true, data: PagedData<NotificationData> }`
     */
    async inbox_get(req: ApiRequest<NotificationsGetInput, PagedData<NotificationData>>, res: ApiOkResponse<PagedData<NotificationData>>): Promise<void> {
        const user_id = require_authenticated_user_id(req);
        log.debug('inbox_get', { user_id });
        // Zod SoT — org_id required; never invent from X-Org-Id.
        const body = this.parse_body(NotificationsGetInput, req);
        // Route policy: member of body.org_id.

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
}
