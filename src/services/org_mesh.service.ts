import type { Org } from '../models/index.js';
import { OrgRepository } from '../repositories/org_repository.js';
import { OrgMemberRepository } from '../repositories/org_member_repository.js';

const _org_repo_m = new OrgRepository();
const _org_member_repo_m = new OrgMemberRepository();
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.org_mesh');
import { get_mesh_adapter, list_mesh_adapters } from '../mesh/registry.js';
import {
    mask_provider_settings,
    merge_provider_settings_patch,
} from '../mesh/settings_util.js';

export interface Org_mesh_settings_dto {
    org_id: string;
    org_slug: string;
    active_provider_id: string | null;
    providers: Record<string, Record<string, unknown>>;
    auto_enable_a2a_on_realm_create: boolean;
    adapters: ReturnType<typeof list_mesh_adapters>;
}

function mask_all_providers(
    providers: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, blob] of Object.entries(providers ?? {})) {
        out[id] = mask_provider_settings(id, blob ?? {});
    }
    return out;
}

function to_dto(org: Org): Org_mesh_settings_dto {
    return {
        org_id: org.id,
        org_slug: org.slug,
        active_provider_id: org.mesh_active_provider_id ?? null,
        providers: mask_all_providers(org.mesh_providers ?? {}),
        auto_enable_a2a_on_realm_create: Boolean(org.mesh_auto_enable_a2a_on_realm_create),
        adapters: list_mesh_adapters(),
    };
}

async function require_org_admin(org_id: string, user_id: string): Promise<Org> {
    const org = await _org_repo_m.find_one_q({ where: { id: org_id, deleted_at: null } });
    if (!org) throw ApiError.not_found('Org not found');
    const membership = await _org_member_repo_m.find_one_q({
        where: { org_id, user_id, status: 'active', deleted_at: null },
    });
    if (!membership || membership.role !== 'admin') {
        throw ApiError.forbidden('Org admin role required');
    }
    return org;
}

export class OrgMeshService {
    static async get_for_admin(org_id: string, user_id: string): Promise<Org_mesh_settings_dto> {
        log.debug('get_for_admin', { org_id, user_id });
        const org = await require_org_admin(org_id, user_id);
        return to_dto(org);
    }

    static async update_for_admin(
        org_id: string,
        user_id: string,
        patch: {
            active_provider_id?: string | null;
            auto_enable_a2a_on_realm_create?: boolean;
            provider_id?: string;
            provider_settings?: Record<string, unknown>;
        },
    ): Promise<Org_mesh_settings_dto> {
        log.debug('update_for_admin', { org_id, user_id });
        const org = await require_org_admin(org_id, user_id);

        if (patch.active_provider_id !== undefined) {
            if (patch.active_provider_id) get_mesh_adapter(patch.active_provider_id);
            org.mesh_active_provider_id = patch.active_provider_id;
        }
        if (patch.auto_enable_a2a_on_realm_create !== undefined) {
            org.mesh_auto_enable_a2a_on_realm_create = patch.auto_enable_a2a_on_realm_create;
        }
        if (patch.provider_id && patch.provider_settings) {
            get_mesh_adapter(patch.provider_id);
            const providers = { ...(org.mesh_providers ?? {}) };
            const existing = providers[patch.provider_id] ?? {};
            providers[patch.provider_id] = merge_provider_settings_patch(
                patch.provider_id,
                existing,
                patch.provider_settings,
            );
            org.mesh_providers = providers;
        }

        await org.save();
        log.info('org_mesh_updated', { org_id });
        return to_dto(org);
    }

    /** Unmasked org mesh row for internal connect / lifecycle. */
    static async get_raw(org_id: string): Promise<{
        active_provider_id: string | null;
        providers: Record<string, Record<string, unknown>>;
        auto_enable_a2a_on_realm_create: boolean;
    } | null> {
        log.debug('get_raw', { org_id });
        const org = await _org_repo_m.find_one_q({ where: { id: org_id } });
        if (!org) return null;
        return {
            active_provider_id: org.mesh_active_provider_id ?? null,
            providers: (org.mesh_providers ?? {}) as Record<string, Record<string, unknown>>,
            auto_enable_a2a_on_realm_create: Boolean(org.mesh_auto_enable_a2a_on_realm_create),
        };
    }
}
