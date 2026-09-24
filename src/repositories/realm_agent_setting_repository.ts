import { OrgAgentSetting, RealmAgentSetting } from '../db/models/index.js';

export interface Realm_agent_setting_row {
    agent_name: string;
    setting_key: string;
    value: string;
    updated_at: Date;
}

/**
 * Low-level CRUD for per-realm agent settings rows.
 * Used by RealmService for realm lifecycle (create/delete) snapshots.
 */
export class RealmAgentSettingRepository {

    /** All settings for a user within a realm. */
    async list_for_user_realm(user_id: string, realm_id: string): Promise<Realm_agent_setting_row[]> {
        return RealmAgentSetting.findAll({
            where: { user_id, realm_id },
            attributes: ['agent_name', 'setting_key', 'value', 'updated_at'],
            raw: true,
        });
    }

    /** Settings for a single agent in a user+realm scope. */
    async list_for_user_realm_and_agent(user_id: string, realm_id: string, agent_name: string): Promise<Realm_agent_setting_row[]> {
        return RealmAgentSetting.findAll({
            where: { user_id, realm_id, agent_name },
            attributes: ['agent_name', 'setting_key', 'value', 'updated_at'],
            raw: true,
        });
    }

    /** Insert or update a single setting. */
    async upsert(user_id: string, realm_id: string, agent_name: string, setting_key: string, value: string): Promise<void> {
        const [row, created] = await RealmAgentSetting.findOrCreate({
            where: { user_id, realm_id, agent_name, setting_key },
            defaults: { user_id, realm_id, agent_name, setting_key, value, updated_at: new Date() },
        });
        if (created) return;
        await row.update({ value, updated_at: new Date() });
    }

    /** Remove a single setting. Returns true if a row was deleted. */
    async remove(user_id: string, realm_id: string, agent_name: string, setting_key: string): Promise<boolean> {
        const removed = await RealmAgentSetting.destroy({
            where: { user_id, realm_id, agent_name, setting_key },
        });
        return removed > 0;
    }

    /** Remove all settings for a realm (used on realm delete). */
    async remove_all_for_realm(realm_id: string): Promise<number> {
        return RealmAgentSetting.destroy({ where: { realm_id } });
    }

    /**
     * Snapshot org-level agent settings into a realm.
     * Idempotent: only inserts rows that don't already exist.
     */
    async snapshot_from_org(org_id: string, user_id: string, realm_id: string): Promise<number> {
        const org_rows = await OrgAgentSetting.findAll({
            where: { org_id },
            attributes: ['agent_name', 'setting_key', 'value'],
            raw: true,
        });
        if (org_rows.length === 0) return 0;

        const existing = await RealmAgentSetting.findAll({
            where: { user_id, realm_id },
            attributes: ['agent_name', 'setting_key'],
            raw: true,
        });
        const existing_keys = new Set(
            existing.map((r) => `${r.agent_name}\x00${r.setting_key}`),
        );

        const now = new Date();
        const to_create = org_rows
            .filter((r) => !existing_keys.has(`${r.agent_name}\x00${r.setting_key}`))
            .map((r) => ({
                user_id,
                realm_id,
                agent_name: r.agent_name,
                setting_key: r.setting_key,
                value: r.value,
                updated_at: now,
            }));
        if (to_create.length === 0) return 0;

        await RealmAgentSetting.bulkCreate(to_create);
        return to_create.length;
    }

    /**
     * Reset a single realm setting back to the org-level default.
     * If no org setting exists, removes the realm override.
     */
    async reset_to_org(
        org_id: string,
        user_id: string,
        realm_id: string,
        agent_name: string,
        setting_key: string,
    ): Promise<'copied' | 'removed' | 'noop'> {
        const org_row = await OrgAgentSetting.findOne({
            where: { org_id, agent_name, setting_key },
            attributes: ['value'],
            raw: true,
        });
        const org_value = (org_row?.value ?? '').trim();
        if (!org_value) {
            const removed = await this.remove(user_id, realm_id, agent_name, setting_key);
            return removed ? 'removed' : 'noop';
        }
        await this.upsert(user_id, realm_id, agent_name, setting_key, org_value);
        return 'copied';
    }
}
