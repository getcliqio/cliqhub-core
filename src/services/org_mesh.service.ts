import { Org, OrgMember } from '../db/models/index.js';
import { ApiError } from '../lib/api_error.js';
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
    const org = await Org.findByPk(org_id);
    if (!org) throw ApiError.not_found('Org not found');
    const membership = await OrgMember.findOne({
        where: { org_id, user_id },
    });
    if (!membership || membership.role !== 'admin') {
        throw ApiError.forbidden('Org admin role required');
    }
    return org;
}

export class OrgMeshService {
    static async get_for_admin(org_id: string, user_id: string): Promise<Org_mesh_settings_dto> {
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
        return to_dto(org);
    }

    /** Unmasked org mesh row for internal connect / lifecycle. */
    static async get_raw(org_id: string): Promise<{
        active_provider_id: string | null;
        providers: Record<string, Record<string, unknown>>;
        auto_enable_a2a_on_realm_create: boolean;
    } | null> {
        const org = await Org.findByPk(org_id);
        if (!org) return null;
        return {
            active_provider_id: org.mesh_active_provider_id ?? null,
            providers: (org.mesh_providers ?? {}) as Record<string, Record<string, unknown>>,
            auto_enable_a2a_on_realm_create: Boolean(org.mesh_auto_enable_a2a_on_realm_create),
        };
    }
}
