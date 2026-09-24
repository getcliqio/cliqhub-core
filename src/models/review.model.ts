import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface ReviewAttributes {
	id: string;
	run_id: string;
	daemon_id: string | null;
	realm_id: string | null;
	/** Denormalized from realm — org boundary for review visibility. */
	org_id: string | null;
	payload: Record<string, unknown>;
	verdict: Record<string, unknown> | null;
	status: 'pending' | 'decided' | 'completed' | 'expired';
	route_targets: string[] | null;
	/** Reviewer group definitions — groups of channels with per-group policies. */
	policy: Record<string, unknown>;
	/** User ID of the reviewer who claimed this review for chat. */
	claimed_by: string | null;
	claimed_at: Date | null;
	created_at: Date;
	timeout_at: Date;
	completed_at: Date | null;
	last_reminded_at: Date | null;
	/** Hub-owned reminder interval in minutes; null = no reminders. */
	remind_every_minutes: number | null;
}

export type ReviewModel = Model<ReviewAttributes> & ReviewAttributes;

export let Review: ModelStatic<ReviewModel>;

export function init_review(sequelize: Sequelize): void {
	Review = sequelize.define(
		'Review',
		{
			id: { type: DataTypes.TEXT, primaryKey: true },
			run_id: { type: DataTypes.TEXT, allowNull: false },
			daemon_id: { type: DataTypes.TEXT, allowNull: true },
			realm_id: { type: DataTypes.TEXT, allowNull: true },
			org_id: { type: DataTypes.UUID, allowNull: true },
			payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
			verdict: { type: DataTypes.JSONB, allowNull: true },
			status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
			route_targets: { type: DataTypes.JSONB, allowNull: true },
			policy: { type: DataTypes.JSONB, allowNull: false, defaultValue: { groups: [] } },
			claimed_by: { type: DataTypes.UUID, allowNull: true },
			claimed_at: { type: DataTypes.DATE, allowNull: true },
			created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
			timeout_at: { type: DataTypes.DATE, allowNull: false },
			completed_at: { type: DataTypes.DATE, allowNull: true },
			last_reminded_at: { type: DataTypes.DATE, allowNull: true },
			remind_every_minutes: { type: DataTypes.INTEGER, allowNull: true },
		},
		{
			schema: 'cliq',
			tableName: 'reviews',
			timestamps: false,
		},
	) as ModelStatic<ReviewModel>;
}
