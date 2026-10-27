/**
 * Stored artifact — durable file uploaded by an agent phase,
 * persisted in R2 and queryable by run_id.
 *
 * Completely independent of run_artifacts (runtime event store)
 * and phase_output_journal (daemon-side recovery journal).
 */

import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class StoredArtifact extends BaseModel {
    declare id: string;
    declare run_id: string;
    declare phase: string;
    declare name: string;
    declare description: string | null;
    declare mime_type: string;
    declare size_bytes: number;
    declare storage_key: string;
    declare uploaded_by: string | null;
    declare created_at: number;
    /** `pending` until a Hug response uses it (responder uploads); `ready` otherwise (PLAN-hug-requests §6.6). */
    declare status: 'pending' | 'ready';
    /** Who uploaded it: the daemon (run artifacts) or a Hug responder. */
    declare source: 'daemon' | 'hug';
    declare hug_id: string | null;
    declare hug_requested_input: string | null;
    /** Hex SHA-256 of the content, computed by Core while streaming the upload. */
    declare sha256: string | null;

    static register(sequelize: Sequelize): void {
        StoredArtifact.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            run_id: { type: DataTypes.TEXT, allowNull: false },
            phase: { type: DataTypes.TEXT, allowNull: false },
            name: { type: DataTypes.TEXT, allowNull: false },
            description: { type: DataTypes.TEXT, allowNull: true },
            mime_type: { type: DataTypes.TEXT, allowNull: false },
            size_bytes: { type: DataTypes.BIGINT, allowNull: false },
            storage_key: { type: DataTypes.TEXT, allowNull: false },
            uploaded_by: { type: DataTypes.TEXT, allowNull: true },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'ready' },
            source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'daemon' },
            hug_id: { type: DataTypes.TEXT, allowNull: true },
            hug_requested_input: { type: DataTypes.TEXT, allowNull: true },
            sha256: { type: DataTypes.TEXT, allowNull: true },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'stored_artifacts',
            timestamps: false,
            indexes: [
                { fields: ['run_id'] },
            ],
        });
    }
}

/** @deprecated Use StoredArtifact directly */
export type StoredArtifactModel = StoredArtifact;

export type StoredArtifactAttributes = {
    id: string;
    run_id: string;
    phase: string;
    name: string;
    description: string | null;
    mime_type: string;
    size_bytes: number;
    storage_key: string;
    uploaded_by: string | null;
    created_at: number;
    status: 'pending' | 'ready';
    source: 'daemon' | 'hug';
    hug_id: string | null;
    hug_requested_input: string | null;
    sha256: string | null;
};
