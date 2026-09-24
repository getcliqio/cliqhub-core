/**
 * Mesh / A2A lifecycle hooks — realm create, skill changes, realm delete.
 * Mesh defaults come from the realm's org; A2A flags live on the realm row.
 */

import { Realm } from '../models/index.js';
import { get_logger } from '../lib/log.js';
import { OrgMeshService } from './org_mesh.service.js';
import { RealmA2aService } from './realm_a2a.service.js';

const log = get_logger('mesh-lifecycle');

export type Auto_enable_result =
    | 'skipped'
    | 'enabled'
    | 'connected'
    | 'connect_failed';

export class MeshLifecycleService {
    /**
     * If the realm's org has auto-enable + a provider, enable A2A and connect.
     */
    static async on_realm_created(
        realm_id: string,
        _owner_user_id: string,
    ): Promise<Auto_enable_result> {
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted || !realm.org_id) return 'skipped';

        const org_mesh = await OrgMeshService.get_raw(realm.org_id);
        if (!org_mesh?.auto_enable_a2a_on_realm_create) return 'skipped';

        const provider_id = org_mesh.active_provider_id;
        if (!provider_id) return 'skipped';

        const provider_settings = org_mesh.providers?.[provider_id] ?? {};
        realm.a2a_enabled = true;
        realm.mesh_provider_mode = 'inherit';
        realm.mesh_providers = {
            ...(realm.mesh_providers ?? {}),
            [provider_id]: {
                ...(realm.mesh_providers?.[provider_id] ?? {}),
                ...provider_settings,
            },
        };
        realm.updated_at = Date.now();
        await realm.save();

        try {
            await RealmA2aService.connect_mesh(realm_id, String(realm.owner_user_id));
            return 'connected';
        } catch (err) {
            log.warn('mesh_auto_enable_connect_failed', {
                realm_id,
                org_id: realm.org_id,
                provider_id,
                error: err instanceof Error ? err.message : String(err),
            });
            return 'connect_failed';
        }
    }

    static async on_skills_changed(realm_id: string): Promise<'skipped' | 'refreshed' | 'failed'> {
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) return 'skipped';
        if (!realm.a2a_enabled) return 'skipped';

        const status = realm.mesh_status && typeof realm.mesh_status === 'object'
            ? (realm.mesh_status as Record<string, unknown>).status
            : null;
        if (status !== 'connected') return 'skipped';

        if (realm.mesh_provider_mode === 'none') return 'skipped';

        try {
            await RealmA2aService.refresh_mesh(realm_id, String(realm.owner_user_id));
            return 'refreshed';
        } catch (err) {
            log.warn('mesh_skills_re_register_failed', {
                realm_id,
                error: err instanceof Error ? err.message : String(err),
            });
            return 'failed';
        }
    }

    static async on_realm_deleting(
        realm_id: string,
        actor_user_id: string,
    ): Promise<'skipped' | 'disconnected' | 'cleared'> {
        const realm = await Realm.findByPk(realm_id);
        if (!realm) return 'skipped';

        let disconnected = false;
        try {
            const status = realm.mesh_status && typeof realm.mesh_status === 'object'
                ? (realm.mesh_status as Record<string, unknown>).status
                : null;
            if (realm.a2a_enabled || status === 'connected') {
                await RealmA2aService.disconnect_mesh(realm_id, actor_user_id);
                disconnected = true;
            }
        } catch (err) {
            log.warn('mesh_disconnect_on_delete_failed', {
                realm_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // A2A fields live on the realm row — soft-delete clears them with the realm.
        return disconnected ? 'disconnected' : 'cleared';
    }
}
