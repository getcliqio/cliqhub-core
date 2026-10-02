/**
 * Test cleanup: removes an org for real with everything that belongs only to
 * it (Core itself only soft-deletes orgs). Runs inside the caller's transaction.
 */

import { Op, type Transaction } from 'sequelize';

type Destroyable = { destroy: (o: object) => Promise<number> };

/**
 * Deletes the org's scopes (and their members), realms (and their members,
 * invites, settings, keys, events, channels, rules and subscriptions), org
 * channels and rules, org agent settings and agents, dispatch keys, invites,
 * members and roles, then the org row.
 */
export async function remove_org_rows(org: { id: string }, t: Transaction): Promise<void> {
    const M = await import('../../src/models/index.js');
    const { get_sequelize } = await import('../../src/db/sequelize.js');
    const org_id = org.id;
    const scope_ids = (await M.Scope.findAll({ where: { org_id }, attributes: ['id'], raw: true, transaction: t })).map((x) => x.id);
    if (scope_ids.length) await M.ScopeMember.destroy({ where: { scope_id: { [Op.in]: scope_ids } }, transaction: t });
    await M.Org.update({ default_scope_id: null } as never, { where: { id: org_id }, transaction: t });
    await M.Scope.destroy({ where: { org_id }, transaction: t });

    const realm_ids = (await M.Realm.findAll({ where: { org_id }, attributes: ['id'], raw: true, transaction: t })).map((r) => r.id);
    if (realm_ids.length) {
        const realm_id = { [Op.in]: realm_ids };
        for (const model of [
            M.RealmMember, M.RealmInvite, M.RealmAgentSetting, M.UserRealmAgentSetting, M.RealmA2aSetting,
            M.RealmDispatchKey, M.CustomEvent, M.NotificationRule, M.NotificationSubscription, M.NotificationChannel,
        ] as Destroyable[]) {
            await model.destroy({ where: { realm_id }, transaction: t });
        }
        await M.User.update({ default_realm_id: null } as never, { where: { default_realm_id: realm_id } as never, transaction: t });
        await M.Realm.update(
            { deleted: true, deleted_at: Date.now(), updated_at: Date.now() } as never,
            { where: { id: realm_id }, transaction: t },
        );
    }
    for (const model of [M.NotificationRule, M.NotificationChannel, M.OrgAgentSetting, M.AgentCatalog, M.AccountInvite] as Destroyable[]) {
        await model.destroy({ where: { org_id }, transaction: t });
    }
    await get_sequelize().query('DELETE FROM cliq.org_dispatch_keys WHERE org_id::text = :org_id', { replacements: { org_id }, transaction: t });
    await M.OrgMember.destroy({ where: { org_id }, transaction: t });
    await M.OrgRole.destroy({ where: { org_id }, transaction: t });
    await M.Org.destroy({ where: { id: org_id }, transaction: t });
}
