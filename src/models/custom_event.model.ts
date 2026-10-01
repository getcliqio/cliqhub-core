/**
 * Custom event discovery model — tracks `custom.*` event types
 * surfaced via manifest declaration or runtime observation.
 *
 * Source types:
 *   `declared`  — parsed from a team manifest `events:` array on install
 *   `observed`  — first seen at runtime when a daemon emits the event
 */

import { randomUUID } from 'node:crypto';
import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class CustomEvent extends BaseModel {
    declare id: string;
    declare event_type: string;
    declare source: 'declared' | 'observed';
    declare realm_id: string | null;
    declare team_slug: string | null;
    declare label: string | null;
    declare created_at: number;

    static register(sequelize: Sequelize): void {
        CustomEvent.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            event_type: { type: DataTypes.TEXT, allowNull: false },
            source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'observed' },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            team_slug: { type: DataTypes.TEXT, allowNull: true },
            label: { type: DataTypes.TEXT, allowNull: true },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'custom_events',
            timestamps: false,
            indexes: [
                { fields: ['event_type'] },
                { fields: ['realm_id'] },
                {
                    unique: true,
                    fields: ['event_type', 'realm_id', 'team_slug'],
                    name: 'custom_events_type_realm_team_uidx',
                },
            ],
        });
    }
}

export type CustomEventAttributes = {
    id?: string;
    event_type: string;
    source: 'declared' | 'observed';
    realm_id: string | null;
    team_slug: string | null;
    label: string | null;
    created_at: number;
};
