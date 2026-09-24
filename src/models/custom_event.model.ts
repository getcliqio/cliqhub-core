/**
 * Custom event discovery model — tracks `custom.*` event types
 * surfaced via manifest declaration or runtime observation.
 *
 * Source types:
 *   `declared`  — parsed from a team manifest `events:` array on install
 *   `observed`  — first seen at runtime when a daemon emits the event
 */

import { randomUUID } from 'node:crypto';
import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface CustomEventAttributes {
    id?: string;
    /** The full event type string, e.g. `custom.enrichment_stale`. */
    event_type: string;
    /** How the event was discovered. */
    source: 'declared' | 'observed';
    /** Realm where the event was registered (NULL for account-level). */
    realm_id: string | null;
    /** Team slug that declared or emitted the event (NULL if unknown). */
    team_slug: string | null;
    /** Human-readable label extracted from manifest (optional). */
    label: string | null;
    created_at: number;
}

export type CustomEventModel =
    Model<CustomEventAttributes> & CustomEventAttributes;

export let CustomEvent: ModelStatic<CustomEventModel>;

export function init_custom_event(sequelize: Sequelize): void {
    CustomEvent = sequelize.define(
        'CustomEvent',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            event_type: { type: DataTypes.TEXT, allowNull: false },
            source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'observed' },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            team_slug: { type: DataTypes.TEXT, allowNull: true },
            label: { type: DataTypes.TEXT, allowNull: true },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
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
        },
    ) as ModelStatic<CustomEventModel>;
}
