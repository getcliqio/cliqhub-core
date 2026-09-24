import { AccountMeshSetting } from '../models/account_mesh_setting.model.js';
import { ApiError } from '../lib/api_error.js';
import { get_mesh_adapter, list_mesh_adapters } from '../mesh/registry.js';
import {
    mask_provider_settings,
    merge_provider_settings_patch,
} from '../mesh/settings_util.js';

export interface Account_mesh_settings_dto {
    user_id: string;
    active_provider_id: string | null;
    providers: Record<string, Record<string, unknown>>;
    auto_enable_a2a_on_realm_create: boolean;
    adapters: ReturnType<typeof list_mesh_adapters>;
    created_at: number;
    updated_at: number;
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

function to_dto(row: {
    user_id: string;
    active_provider_id: string | null;
    providers: Record<string, Record<string, unknown>>;
    auto_enable_a2a_on_realm_create: boolean;
    created_at: number;
    updated_at: number;
}): Account_mesh_settings_dto {
    return {
        user_id: row.user_id,
        active_provider_id: row.active_provider_id,
        providers: mask_all_providers(row.providers ?? {}),
        auto_enable_a2a_on_realm_create: row.auto_enable_a2a_on_realm_create,
        adapters: list_mesh_adapters(),
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
    };
}

export class AccountMeshService {
    static async get_or_create(user_id: string): Promise<Account_mesh_settings_dto> {
        const row = await AccountMeshService._get_or_create_row(user_id);
        return to_dto(row);
    }

    static async update(
        user_id: string,
        patch: {
            active_provider_id?: string | null;
            auto_enable_a2a_on_realm_create?: boolean;
            provider_id?: string;
            provider_settings?: Record<string, unknown>;
        },
    ): Promise<Account_mesh_settings_dto> {
        const row = await AccountMeshService._get_or_create_row(user_id);

        if (patch.active_provider_id !== undefined) {
            if (patch.active_provider_id) {
                get_mesh_adapter(patch.active_provider_id);
            }
            row.active_provider_id = patch.active_provider_id;
        }
        if (patch.auto_enable_a2a_on_realm_create !== undefined) {
            row.auto_enable_a2a_on_realm_create = patch.auto_enable_a2a_on_realm_create;
        }
        if (patch.provider_id && patch.provider_settings) {
            get_mesh_adapter(patch.provider_id);
            const providers = { ...(row.providers ?? {}) };
            const existing = providers[patch.provider_id] ?? {};
            providers[patch.provider_id] = merge_provider_settings_patch(
                patch.provider_id,
                existing,
                patch.provider_settings,
            );
            row.providers = providers;
        }

        row.updated_at = Date.now();
        await row.save();
        return to_dto(row);
    }

    private static async _get_or_create_row(user_id: string) {
        if (!user_id.trim()) throw ApiError.forbidden('Not authenticated');
        const existing = await AccountMeshSetting.findByPk(user_id);
        if (existing) return existing;

        const now = Date.now();
        return AccountMeshSetting.create({
            user_id,
            active_provider_id: null,
            providers: {},
            auto_enable_a2a_on_realm_create: false,
            created_at: now,
            updated_at: now,
        });
    }
}
