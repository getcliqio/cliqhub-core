/**
 * Notification rule model — maps event types to channels with
 * three-tier inheritance: global → realm → team-in-realm.
 *
 * Tier encoding:
 *   Global:         realm_id IS NULL, team_slug IS NULL
 *   Realm:          realm_id set,     team_slug IS NULL
 *   Team-in-realm:  realm_id set,     team_slug set
 *
 * `recipients` (org rules) names who a delivery goes to, resolved per event
 * by notifications/recipients.ts; null means the channel's own destinations.
 * Seeded defaults carry a `system_key`; locked ones cannot be changed.
 */

import { randomUUID } from 'node:crypto';
import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class NotificationRule extends BaseModel {
    declare id: string;
    declare realm_id: string | null;
    /** Owning org — set for org-level rules (realm_id IS NULL). */
    declare org_id: string | null;
    declare team_slug: string | null;
    /** Event type or wildcard selector (e.g. 'run.*', 'custom.*', 'phase.escalated'). */
    declare event: string;
    declare channel_id: string;
    declare priority: number;
    declare created_at: number;
    declare updated_at: number;
    /** Recipient selectors (`invitee`, `org_owners`, `inviter`, `user`, or user ids); null = channel destinations. */
    declare recipients: string[] | null;
    /** Set on seeded default rules (e.g. `invite.sent.invitee`). */
    declare system_key: string | null;
    /** A locked rule cannot be changed or removed (409 `locked`). */
    declare locked: boolean;
    /** Why the rule is locked, shown next to the lock. */
    declare lock_reason: string | null;

    static register(sequelize: Sequelize): void {
        NotificationRule.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            org_id: { type: DataTypes.UUID, allowNull: true },
            team_slug: { type: DataTypes.TEXT, allowNull: true },
            event: { type: DataTypes.TEXT, allowNull: false },
            channel_id: { type: DataTypes.TEXT, allowNull: false },
            priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
            recipients: { type: DataTypes.JSONB, allowNull: true },
            system_key: { type: DataTypes.TEXT, allowNull: true },
            locked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            lock_reason: { type: DataTypes.TEXT, allowNull: true },
        }, {
            sequelize,
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
        });
    }
}

export type NotificationRuleAttributes = {
    id?: string;
    realm_id: string | null;
    org_id: string | null;
    team_slug: string | null;
    event: string;
    channel_id: string;
    priority: number;
    created_at: number;
    updated_at: number;
};
