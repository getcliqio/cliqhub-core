/**
 * Stored artifact — durable file uploaded by an agent phase,
 * persisted in R2 and queryable by run_id.
 *
 * Completely independent of run_artifacts (runtime event store)
 * and phase_output_journal (daemon-side recovery journal).
 */

import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface StoredArtifactAttributes {
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
}

export type StoredArtifactModel = Model<StoredArtifactAttributes> & StoredArtifactAttributes;

export let StoredArtifact: ModelStatic<StoredArtifactModel>;

export function init_stored_artifact(sequelize: Sequelize): void {
    StoredArtifact = sequelize.define(
        'StoredArtifact',
        {
            id: {
                type: DataTypes.UUID,
                primaryKey: true,
                defaultValue: DataTypes.UUIDV4,
            },
            run_id: { type: DataTypes.TEXT, allowNull: false },
            phase: { type: DataTypes.TEXT, allowNull: false },
            name: { type: DataTypes.TEXT, allowNull: false },
            description: { type: DataTypes.TEXT, allowNull: true },
            mime_type: { type: DataTypes.TEXT, allowNull: false },
            size_bytes: { type: DataTypes.BIGINT, allowNull: false },
            storage_key: { type: DataTypes.TEXT, allowNull: false },
            uploaded_by: { type: DataTypes.TEXT, allowNull: true },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'stored_artifacts',
            timestamps: false,
            indexes: [
                { fields: ['run_id'] },
            ],
        },
    ) as ModelStatic<StoredArtifactModel>;
}
