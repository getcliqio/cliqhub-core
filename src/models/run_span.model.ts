/**
 * OTEL span row for a cliq run — Phase 1 observability.
 *
 * One trace per run (root span `run.execute`); phase and agent spans
 * nest inside. Ingested via POST /v1/runs/report_telemetry (`kind: traces`) from cliqd
 * and served to the Hub Timeline tab.
 */

import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface RunSpanAttributes {
	span_id: string;
	trace_id: string;
	parent_span_id: string | null;
	run_id: string;
	name: string;
	kind: string;
	status_code: string;
	status_message: string | null;
	start_unix_nano: string;
	end_unix_nano: string;
	attributes: Record<string, unknown>;
	events: Array<Record<string, unknown>>;
	daemon_id: string | null;
	realm_id: string | null;
	created_at: number;
}

export type RunSpanModel = Model<RunSpanAttributes> & RunSpanAttributes;

export let RunSpan: ModelStatic<RunSpanModel>;

export function init_run_span(sequelize: Sequelize): void {
	RunSpan = sequelize.define(
		'RunSpan',
		{
			span_id: { type: DataTypes.TEXT, primaryKey: true },
			trace_id: { type: DataTypes.TEXT, allowNull: false },
			parent_span_id: { type: DataTypes.TEXT, allowNull: true },
			run_id: { type: DataTypes.TEXT, allowNull: false },
			name: { type: DataTypes.TEXT, allowNull: false },
			kind: { type: DataTypes.TEXT, allowNull: false },
			status_code: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'UNSET' },
			status_message: { type: DataTypes.TEXT, allowNull: true },
			start_unix_nano: { type: DataTypes.BIGINT, allowNull: false },
			end_unix_nano: { type: DataTypes.BIGINT, allowNull: false },
			attributes: {
				type: DataTypes.JSONB,
				allowNull: false,
				defaultValue: {},
			},
			events: {
				type: DataTypes.JSONB,
				allowNull: false,
				defaultValue: [],
			},
			daemon_id: { type: DataTypes.TEXT, allowNull: true },
			realm_id: { type: DataTypes.TEXT, allowNull: true },
			created_at: { type: DataTypes.BIGINT, allowNull: false },
		},
		{
			schema: 'cliq',
			tableName: 'run_spans',
			timestamps: false,
			indexes: [
				{ fields: ['run_id', 'start_unix_nano'] },
				{ fields: ['trace_id'] },
				// Fleet-wide telemetry rollup: fetches only root run.execute
				// spans within a time window. Without this index the tile
				// endpoint scans every span row in the table for every
				// dashboard poll.
				{ fields: ['name', 'end_unix_nano'] },
			],
		},
	) as ModelStatic<RunSpanModel>;
}
