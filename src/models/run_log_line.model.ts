import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface RunLogLineAttributes {
	id: string;
	run_id: string;
	created_at: number;
	level: string;
	message: string;
	daemon_id: string | null;
	workspace_id: string | null;
	team: string | null;
	realm_id: string | null;
	chunk_id: string | null;
	/** 'run' | 'system' | 'command' | 'http' — canonical bucket for filters/facets. */
	concern: string | null;
}

export type RunLogLineModel = Model<RunLogLineAttributes> & RunLogLineAttributes;

export let RunLogLine: ModelStatic<RunLogLineModel>;

export function init_run_log_line(sequelize: Sequelize): void {
	RunLogLine = sequelize.define(
		'RunLogLine',
		{
			id: { type: DataTypes.TEXT, primaryKey: true },
			run_id: { type: DataTypes.TEXT, allowNull: false },
			created_at: { type: DataTypes.BIGINT, allowNull: false },
			level: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'info' },
			message: { type: DataTypes.TEXT, allowNull: false },
			daemon_id: { type: DataTypes.TEXT, allowNull: true },
			workspace_id: { type: DataTypes.TEXT, allowNull: true },
			team: { type: DataTypes.TEXT, allowNull: true },
			realm_id: { type: DataTypes.TEXT, allowNull: true },
			chunk_id: { type: DataTypes.TEXT, allowNull: true },
			concern: { type: DataTypes.TEXT, allowNull: true, defaultValue: 'run' },
		},
		{
			schema: 'cliq',
			tableName: 'run_log_lines',
			timestamps: false,
			indexes: [
				{ fields: ['created_at'] },
				{ fields: ['realm_id', 'created_at'] },
				{ fields: ['run_id'] },
				{ fields: ['level'] },
				{ fields: ['daemon_id'] },
				{ fields: ['concern'] },
			],
		},
	) as ModelStatic<RunLogLineModel>;
}
