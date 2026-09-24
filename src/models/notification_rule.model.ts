/**
 * Notification rule model — maps event types to channels with
 * three-tier inheritance: global → realm → team-in-realm.
 *
 * Tier encoding:
 *   Global:         realm_id IS NULL, team_slug IS NULL
 *   Realm:          realm_id set,     team_slug IS NULL
 *   Team-in-realm:  realm_id set,     team_slug set
 */

import { randomUUID } from 'node:crypto';
import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface NotificationRuleAttributes {
    id?: string;
    realm_id: string | null;
    /** Owning org — set for org-level rules (realm_id IS NULL). */
    org_id: string | null;
    team_slug: string | null;
    /** Event type or wildcard selector (e.g. 'run.*', 'custom.*', 'phase.escalated'). */
    event: string;
    channel_id: string;
    priority: number;
    created_at: number;
    updated_at: number;
}

export type NotificationRuleModel =
    Model<NotificationRuleAttributes> & NotificationRuleAttributes;

export let NotificationRule: ModelStatic<NotificationRuleModel>;

export function init_notification_rule(sequelize: Sequelize): void {
    NotificationRule = sequelize.define(
        'NotificationRule',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            org_id: { type: DataTypes.UUID, allowNull: true },
            team_slug: { type: DataTypes.TEXT, allowNull: true },
            event: { type: DataTypes.TEXT, allowNull: false },
            channel_id: { type: DataTypes.TEXT, allowNull: false },
            priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'notification_rules',
            timestamps: false,
            indexes: [
                { fields: ['realm_id'] },
                { fields: ['org_id'], name: 'notification_rules_org_id_idx' },
                { fields: ['event'] },
                {
                    unique: true,
                    fields: ['realm_id', 'team_slug', 'event', 'channel_id'],
                    name: 'notification_rules_tier_event_channel_uidx',
                },
            ],
        },
    ) as ModelStatic<NotificationRuleModel>;
}
