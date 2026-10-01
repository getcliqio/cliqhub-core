import { DataTypes, type Sequelize } from 'sequelize';
import { IdFactory } from '../lib/ids.js';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * File artifact produced during a run phase.
 *
 * Stores the artifact content inline (`content` column) up to a reasonable
 * size; larger payloads are offloaded to object storage and the `content`
 * field holds a reference URL. `kind` classifies the artifact (e.g. `file`,
 * `log`, `report`). `sequence` tracks ordering within a phase.
 */
export class RunArtifact extends BaseModel {
    declare id: string;
    declare run_id: string;
    declare phase: string;
    declare kind: string;
    declare name: string;
    declare content: string;
    declare mime_type: string | null;
    declare target_phase: string | null;
    declare sequence: number | null;
    declare created_at: number;

    static register(sequelize: Sequelize): void {
        RunArtifact.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => IdFactory.new_id() },
            run_id: { type: DataTypes.TEXT, allowNull: false },
            phase: { type: DataTypes.TEXT, allowNull: false },
            kind: { type: DataTypes.TEXT, allowNull: false },
            name: { type: DataTypes.TEXT, allowNull: false },
            content: { type: DataTypes.TEXT, allowNull: false },
            mime_type: { type: DataTypes.TEXT },
            target_phase: { type: DataTypes.TEXT },
            sequence: { type: DataTypes.INTEGER },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        }, ModelConfig.table_options(sequelize, 'run_artifacts', {
            indexes: [
                { unique: true, fields: ['run_id', 'phase', 'kind', 'name', 'sequence'] },
            ],
        }));
    }
}

export type RunArtifactAttributes = {
    id: string;
    run_id: string;
    phase: string;
    kind: string;
    name: string;
    content: string;
    mime_type: string | null;
    target_phase: string | null;
    sequence: number | null;
    created_at: number;
};
