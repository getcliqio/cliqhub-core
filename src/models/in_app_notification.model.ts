import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface InAppNotificationAttributes {
	id: string;
	event: string;
	title: string | null;
	message: string | null;
	realm_id: string | null;
	/** Org boundary — denormalized from realm or channel for org-scoped queries. */
	org_id: string | null;
	/** Target user for per-user notifications. NULL = realm-wide (existing behavior). */
	user_id: string | null;
	team: string | null;
	run_id: string | null;
	phase: string | null;
	severity: string | null;
	/** Denormalized from payload for HUG event queries. */
	review_id: string | null;
	payload_json: string;
	created_at: number;
}

export type InAppNotificationModel =
	Model<InAppNotificationAttributes> & InAppNotificationAttributes;

/** Set by `init_in_app_notification` — uses the store Sequelize's Model class. */
export let InAppNotification: ModelStatic<InAppNotificationModel>;

export function init_in_app_notification(sequelize: Sequelize): void {
	InAppNotification = sequelize.define(
		'InAppNotification',
		{
			id: { type: DataTypes.TEXT, primaryKey: true },
			event: { type: DataTypes.TEXT, allowNull: false },
			title: { type: DataTypes.TEXT, allowNull: true },
			message: { type: DataTypes.TEXT, allowNull: true },
			realm_id: { type: DataTypes.TEXT, allowNull: true },
			org_id: { type: DataTypes.UUID, allowNull: true },
			user_id: { type: DataTypes.UUID, allowNull: true },
			team: { type: DataTypes.TEXT, allowNull: true },
			run_id: { type: DataTypes.TEXT, allowNull: true },
			phase: { type: DataTypes.TEXT, allowNull: true },
			severity: { type: DataTypes.TEXT, allowNull: true },
			review_id: { type: DataTypes.TEXT, allowNull: true },
			payload_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
			created_at: { type: DataTypes.BIGINT, allowNull: false },
		},
		{
			schema: 'cliq',
			tableName: 'in_app_notifications',
			timestamps: false,
			indexes: [
				{ fields: ['created_at'] },
				{ fields: ['realm_id'] },
				{ fields: ['org_id'] },
				{ fields: ['event'] },
				{ fields: ['user_id'] },
				{ fields: ['review_id'] },
			],
		},
	) as ModelStatic<InAppNotificationModel>;
}
