/**
 * Hugs — requests for input from people, opened by a run's phase (PLAN-hug-requests §6.1).
 *
 * - `Hug` — the request: prompt, context, requested inputs, channels, expiry, reminders.
 * - `HugDelivery` — one row per destination the channels resolved to (who was asked).
 * - `HugResponse` — one per responder (latest wins).
 * - `HugEvent` — the requester's stream, numbered per Hug (`seq`), for delivery and catch-up.
 *
 * Core stores and routes Hugs; it never interprets a value. Tables are created by the schema
 * migrations (`HUGS_TABLE_SQL` and siblings).
 */

import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/** Where a Hug is in its life. */
export type HugStatus = 'open' | 'closed' | 'expired' | 'cancelled';
/** What a Hug event tells its requester. */
export type HugEventType = 'response' | 'expired' | 'cancelled';

/** A request for input from people. */
/** Someone a Hug's channels reach but who may not see it. */
export interface HugNotSentTo {
    user_id: string;
    name: string;
    /** The Hug channel that reached them. */
    channel: string;
}

export class Hug extends BaseModel {
    declare id: string;
    declare run_id: string;
    declare phase: string;
    declare iteration: number;
    declare daemon_id: string;
    declare realm_id: string;
    declare org_id: string;
    declare title: string;
    declare prompt: string;
    declare context: unknown[];
    declare requested_inputs: unknown[];
    declare channels: string[];
    declare ui: Record<string, unknown> | null;
    declare status: HugStatus;
    declare outcome: string | null;
    declare expires_at: Date;
    declare reminders: { every_min?: number; at_min?: number[] } | null;
    declare next_remind_at: Date | null;
    declare last_reminded_at: Date | null;
    /** Highest `seq` written to `hug_events` for this Hug. */
    declare last_seq: number;
    declare created_at: Date;
    declare closed_at: Date | null;
    /** People its channels reach who may not see it (no `runs.view`): not sent to (§6.4). */
    declare not_sent_to: HugNotSentTo[] | null;

    static register(sequelize: Sequelize): void {
        Hug.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            run_id: { type: DataTypes.TEXT, allowNull: false },
            phase: { type: DataTypes.TEXT, allowNull: false },
            iteration: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            daemon_id: { type: DataTypes.TEXT, allowNull: false },
            realm_id: { type: DataTypes.TEXT, allowNull: false },
            org_id: { type: DataTypes.UUID, allowNull: false },
            title: { type: DataTypes.TEXT, allowNull: false },
            prompt: { type: DataTypes.TEXT, allowNull: false },
            context: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            requested_inputs: { type: DataTypes.JSONB, allowNull: false },
            channels: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false },
            ui: { type: DataTypes.JSONB, allowNull: true },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'open' },
            outcome: { type: DataTypes.TEXT, allowNull: true },
            expires_at: { type: DataTypes.DATE, allowNull: false },
            reminders: { type: DataTypes.JSONB, allowNull: true },
            next_remind_at: { type: DataTypes.DATE, allowNull: true },
            last_reminded_at: { type: DataTypes.DATE, allowNull: true },
            last_seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            closed_at: { type: DataTypes.DATE, allowNull: true },
            not_sent_to: { type: DataTypes.JSONB, allowNull: true },
        }, { sequelize, schema: 'cliq', tableName: 'hugs', timestamps: false });
    }
}

/** One destination a Hug's channels resolved to. A personal channel names its person; a shared one doesn't. */
export class HugDelivery extends BaseModel {
    declare id: string;
    declare hug_id: string;
    /** The channel name as the Hug gave it. */
    declare channel: string;
    declare channel_id: string;
    /** Set for a person's channel; null for a shared (realm/org) channel. */
    declare user_id: string | null;
    declare created_at: Date;

    static register(sequelize: Sequelize): void {
        HugDelivery.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            hug_id: { type: DataTypes.TEXT, allowNull: false },
            channel: { type: DataTypes.TEXT, allowNull: false },
            channel_id: { type: DataTypes.TEXT, allowNull: false },
            user_id: { type: DataTypes.UUID, allowNull: true },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, { sequelize, schema: 'cliq', tableName: 'hug_deliveries', timestamps: false });
    }
}

/** One responder's submission (they may replace it while the Hug is open). */
export class HugResponse extends BaseModel {
    declare id: string;
    declare hug_id: string;
    declare responder_user_id: string;
    /** The Hug's channels that reached this responder. */
    declare via_channels: string[];
    declare values: Record<string, unknown>;
    declare comment: string | null;
    /** `seq` of the event that last delivered this response. */
    declare seq: number;
    declare created_at: Date;
    declare updated_at: Date;

    static register(sequelize: Sequelize): void {
        HugResponse.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            hug_id: { type: DataTypes.TEXT, allowNull: false },
            responder_user_id: { type: DataTypes.UUID, allowNull: false },
            via_channels: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false },
            values: { type: DataTypes.JSONB, allowNull: false },
            comment: { type: DataTypes.TEXT, allowNull: true },
            seq: { type: DataTypes.INTEGER, allowNull: false },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, { sequelize, schema: 'cliq', tableName: 'hug_responses', timestamps: false });
    }
}

/** One entry of a Hug's requester stream. */
export class HugEventRow extends BaseModel {
    declare hug_id: string;
    declare seq: number;
    declare type: HugEventType;
    declare payload: Record<string, unknown>;
    declare created_at: Date;

    static register(sequelize: Sequelize): void {
        HugEventRow.init({
            hug_id: { type: DataTypes.TEXT, primaryKey: true },
            seq: { type: DataTypes.INTEGER, primaryKey: true },
            type: { type: DataTypes.TEXT, allowNull: false },
            payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, { sequelize, schema: 'cliq', tableName: 'hug_events', timestamps: false });
    }
}
