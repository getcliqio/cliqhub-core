/**
 * Hugs — requests for input from people, opened by a run's phase (PLAN-hug-requests §6.1) and asked in getHugs
 * (PLAN-gethugs-integration.md).
 *
 * - `Hug` — Core's row for a getHugs Hug, under the id its daemon minted: its hug (name, bundle hash), params, title,
 *   summary, upload slots, attachments, channels, expiry, status, and getHugs' ids.
 * - `HugBundle` — a team hug's bundle, stored once by hash (files in package storage).
 * - `HugEvent` — the requester's stream, numbered per Hug (`seq`), for delivery and catch-up.
 *
 * Core never interprets a value. Tables are created by the schema migrations (`HUGS_TABLE_SQL` and siblings).
 */

import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/** Where a Hug is in its life. */
export type HugStatus = 'open' | 'closed' | 'expired' | 'cancelled';
/** What a Hug event tells its requester. */
export type HugEventType = 'response' | 'expired' | 'cancelled';

/** An upload slot of a Hug (as stored). */
export interface HugFileSlotRow {
    name: string;
    accept?: string[];
    max_bytes?: number;
    multiple?: boolean;
    required?: boolean;
}

/** A run file attached to a Hug (as stored). */
export interface HugAttachmentRow {
    artifact_id: string;
    name: string;
    size: number;
    content_type: string;
    sha256: string;
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
    /** The hug it was opened with, by name. */
    declare hug_name: string | null;
    /** A team hug's bundle (`hug_bundles.sha256`); null for a getHugs built-in. */
    declare hug_sha256: string | null;
    /** The Hug in plain text. */
    declare summary: string | null;
    /** The requester's latest status line while open (`hug.progress` activity) — informational. */
    declare progress: string | null;
    /** The hug's params (checked by its definition; never read by Core). */
    declare params: Record<string, unknown>;
    /** Upload slots: the top-level answer keys that may carry uploads. */
    declare files: HugFileSlotRow[];
    /** Run files the frontend may read. */
    declare attachments: HugAttachmentRow[];
    declare channels: string[];
    declare status: HugStatus;
    declare outcome: string | null;
    declare expires_at: Date;
    /** Highest `seq` written to `hug_events` for this Hug. */
    declare last_seq: number;
    declare created_at: Date;
    declare closed_at: Date | null;
    /** The getHugs Hug this row relays (PLAN-gethugs-step3-asking.md), and its workspace. */
    declare gethugs_id: string;
    declare gethugs_workspace_id: string;
    /** getHugs' last event seq applied to this Hug (PLAN-gethugs-step4-answers.md): an event is applied once. */
    declare gethugs_seq: number;

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
            hug_name: { type: DataTypes.TEXT, allowNull: true },
            hug_sha256: { type: DataTypes.TEXT, allowNull: true },
            summary: { type: DataTypes.TEXT, allowNull: true },
            progress: { type: DataTypes.TEXT, allowNull: true },
            params: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            files: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            attachments: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            channels: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'open' },
            outcome: { type: DataTypes.TEXT, allowNull: true },
            expires_at: { type: DataTypes.DATE, allowNull: false },
            last_seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            closed_at: { type: DataTypes.DATE, allowNull: true },
            gethugs_id: { type: DataTypes.TEXT, allowNull: false },
            gethugs_workspace_id: { type: DataTypes.TEXT, allowNull: false },
            gethugs_seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        }, { sequelize, schema: 'cliq', tableName: 'hugs', timestamps: false });
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

/**
 * A team hug's bundle, stored once by its hash (PLAN-hug-widgets §11.1). Its files live in package storage under
 * `hug-bundles/<sha256>/`. Uploaded by a daemon on its first Hug with it; Core installs it in getHugs as the team's
 * template; kept while an open or recently closed Hug uses it.
 */
export class HugBundle extends BaseModel {
    declare sha256: string;
    declare name: string;
    declare size_bytes: number;
    declare file_count: number;
    /** The realm of the daemon that first uploaded it (audit). */
    declare realm_id: string | null;
    declare created_at: Date;
    declare last_used_at: Date;

    static register(sequelize: Sequelize): void {
        HugBundle.init({
            sha256: { type: DataTypes.TEXT, primaryKey: true },
            name: { type: DataTypes.TEXT, allowNull: false },
            size_bytes: { type: DataTypes.INTEGER, allowNull: false },
            file_count: { type: DataTypes.INTEGER, allowNull: false },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            last_used_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, { sequelize, schema: 'cliq', tableName: 'hug_bundles', timestamps: false });
    }
}
