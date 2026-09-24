/**
 * Migrate mesh settings from user-scoped account_mesh_settings → orgs,
 * and backfill realms.org_id from personal / org-default slug rules.
 */

import { QueryTypes, type Sequelize } from 'sequelize';
import { Org, User } from './models/index.js';
import { Realm } from '../models/index.js';
import { account_default_realm_slug } from '../lib/account_realm.js';
import { ensure_personal_org_for_user } from './migrate_ensure_user_orgs.js';

export interface Org_mesh_migrate_result {
    readonly mesh_rows_copied: number;
    readonly realms_org_linked: number;
}

function parse_user_pk(raw: unknown): number | null {
    if (raw == null || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(String(raw));
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
    return n;
}

export async function migrate_org_mesh_from_account(
    sequelize: Sequelize,
): Promise<Org_mesh_migrate_result> {
    let mesh_rows_copied = 0;
    let realms_org_linked = 0;

    // Copy account_mesh_settings → personal org (slug matches username).
    const has_account_mesh = await sequelize.query<{ exists: boolean }>(
        `SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'cliq' AND table_name = 'account_mesh_settings'
        ) AS exists`,
        { type: QueryTypes.SELECT },
    );
    if (has_account_mesh[0]?.exists) {
        const rows = await sequelize.query<{
            user_id: string;
            active_provider_id: string | null;
            providers: Record<string, unknown>;
            auto_enable_a2a_on_realm_create: boolean;
        }>(
            `SELECT user_id, active_provider_id, providers, auto_enable_a2a_on_realm_create
             FROM cliq.account_mesh_settings`,
            { type: QueryTypes.SELECT },
        );

        for (const row of rows) {
            const user_pk = parse_user_pk(row.user_id);
            if (user_pk == null) continue;
            const user = await User.findByPk(user_pk, {
                attributes: ['id', 'username'],
            });
            if (!user?.username) continue;
            const org = await ensure_personal_org_for_user(user.id, user.username);
            await org.update({
                mesh_active_provider_id: row.active_provider_id,
                mesh_providers: row.providers ?? {},
                mesh_auto_enable_a2a_on_realm_create: Boolean(row.auto_enable_a2a_on_realm_create),
            });
            mesh_rows_copied += 1;
        }
    }

    // Link realms to orgs by slug convention, else owner's personal org.
    const realms = await Realm.findAll({
        attributes: ['id', 'slug', 'owner_user_id', 'org_id'],
    });
    for (const realm of realms) {
        if (realm.org_id) continue;

        let org_id: string | null = null;
        const slug = String(realm.slug ?? '');
        if (slug.endsWith('.default')) {
            const account_slug = slug.slice(0, -'.default'.length);
            const org = await Org.findOne({ where: { slug: account_slug } });
            if (org) org_id = org.id;
        }

        if (!org_id) {
            const owner_pk = parse_user_pk(realm.owner_user_id);
            if (owner_pk != null) {
                const owner = await User.findByPk(owner_pk, {
                    attributes: ['id', 'username'],
                });
                if (owner?.username) {
                    const org = await ensure_personal_org_for_user(owner.id, owner.username);
                    org_id = org.id;
                }
            }
        }

        if (!org_id) continue;
        realm.org_id = org_id;
        await realm.save();
        realms_org_linked += 1;
    }

    return { mesh_rows_copied, realms_org_linked };
}

/** Convenience for tests — personal default slug helper re-export. */
export { account_default_realm_slug };
