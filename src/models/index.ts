import type { Sequelize } from 'sequelize';

import {
    Agent,
    Container,
    Daemon,
    DaemonConfig,
    Run,
    RunArtifact,
    RunEvent,
    RunLog,
    RunPhase,
    Scope,
    Team,
    Workspace,
    WorkspaceTeam,
} from '@getcliqio/cliq-store';

import { NotificationChannel, init_notification_channel } from './notification_channel.model.js';
import { ChannelDestination, init_channel_destination } from './channel_destination.model.js';
import { InAppNotification, init_in_app_notification } from './in_app_notification.model.js';
import { RunLogLine, init_run_log_line } from './run_log_line.model.js';
import { RunSpan, init_run_span } from './run_span.model.js';
import { RealmDispatchKey, init_realm_dispatch_key } from './realm_dispatch_key.model.js';
import { Realm, init_realm } from './realm.model.js';
import { RealmMember, init_realm_member } from './realm_member.model.js';
import {
    RealmDispatchQueue,
    init_realm_dispatch_queue,
} from './realm_dispatch_queue.model.js';
import { Review, init_review } from './review.model.js';
import { ReviewMessage, init_review_message } from './review_message.model.js';
import { ReviewNotification, init_review_notification } from './review_notification.model.js';
import { RealmAgentSetting, init_realm_agent_setting } from './realm_agent_setting.model.js';
import { AgentCatalog, init_agent_catalog } from './agent_catalog.model.js';
import { NotificationRule, init_notification_rule } from './notification_rule.model.js';
import { CustomEvent, init_custom_event } from './custom_event.model.js';
import { RealmA2aSetting, init_realm_a2a_setting } from './realm_a2a_setting.model.js';
import { AccountMeshSetting, init_account_mesh_setting } from './account_mesh_setting.model.js';
import { HubEvent, init_hub_event } from '../events/event.model.js';
import { WebhookDelivery, init_webhook_delivery } from './webhook_delivery.model.js';

export {
    Agent,
    AgentCatalog,
    AccountMeshSetting,
    Container,
    CustomEvent,
    Daemon,
    DaemonConfig,
    HubEvent,
    ChannelDestination,
    InAppNotification,
    NotificationChannel,
    NotificationRule,
    RealmA2aSetting,
    RealmAgentSetting,
    RealmDispatchKey,
    RealmDispatchQueue,
    Realm,
    RealmMember,
    Review,
    ReviewMessage,
    ReviewNotification,
    Run,
    RunArtifact,
    RunEvent,
    RunLog,
    RunLogLine,
    RunPhase,
    RunSpan,
    Scope,
    Team,
    Workspace,
    WebhookDelivery,
    WorkspaceTeam,
};

let _inited_for: Sequelize | null = null;

/**
 * Init Hub-only control-plane models on the store Sequelize.
 * Store models are already initialized by `connect_store` — do not re-init them.
 * Uses `sequelize.define` so Model classes match the store package's Sequelize copy.
 */
export function init_core_api_models(sequelize: Sequelize): void {
    if (_inited_for === sequelize) return;

    init_realm_dispatch_key(sequelize);
    init_notification_channel(sequelize);
    init_channel_destination(sequelize);
    init_in_app_notification(sequelize);
    init_run_log_line(sequelize);
    init_run_span(sequelize);
    init_realm(sequelize);
    init_realm_member(sequelize);
    init_realm_dispatch_queue(sequelize);
    init_hub_event(sequelize);
    init_review(sequelize);
    init_review_message(sequelize);
    init_review_notification(sequelize);
    init_realm_agent_setting(sequelize);
    init_agent_catalog(sequelize);
    init_notification_rule(sequelize);
    init_custom_event(sequelize);
    init_realm_a2a_setting(sequelize);
    init_account_mesh_setting(sequelize);
    init_webhook_delivery(sequelize);

    Realm.hasMany(RealmMember, { foreignKey: 'realm_id', as: 'members' });
    RealmMember.belongsTo(Realm, { foreignKey: 'realm_id', as: 'realm' });

    NotificationChannel.hasMany(ChannelDestination, { foreignKey: 'channel_id', as: 'destinations_rows' });
    ChannelDestination.belongsTo(NotificationChannel, { foreignKey: 'channel_id', as: 'channel' });

    Review.hasMany(ReviewMessage, { foreignKey: 'review_id', as: 'messages' });
    ReviewMessage.belongsTo(Review, { foreignKey: 'review_id', as: 'review' });

    Review.hasMany(ReviewNotification, { foreignKey: 'review_id', as: 'notifications' });
    ReviewNotification.belongsTo(Review, { foreignKey: 'review_id', as: 'review' });

    _inited_for = sequelize;
}

/** Clear init guard after store close (tests / process recycle). */
export function reset_core_api_models(): void {
    _inited_for = null;
}
