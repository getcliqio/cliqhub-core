import { createHash, randomBytes } from 'node:crypto';
import type { Realm_mesh_provider_mode } from '../models/realm_a2a_setting.model.js';
import { Realm } from '../models/index.js';
import type { RealmModel } from '../models/realm.model.js';
import { RealmService } from './realm.service.js';
import { OrgMeshService } from './org_mesh.service.js';
import { ApiError } from '../lib/api_error.js';
import { get_mesh_adapter, list_mesh_adapters } from '../mesh/registry.js';
import {
    mask_provider_settings,
    merge_provider_settings_patch,
    realm_public_a2a_url,
} from '../mesh/settings_util.js';
import type { Mesh_health } from '../mesh/types.js';

export type { Realm_mesh_provider_mode };

export interface Realm_a2a_settings_dto {
    realm_id: string;
    org_id: string | null;
    a2a_enabled: boolean;
    has_bearer: boolean;
    bearer_prefix: string | null;
    mesh_provider_mode: Realm_mesh_provider_mode;
    active_provider_id: string | null;
    /** Effective provider after inherit/override/none resolution */
    effective_provider_id: string | null;
    providers: Record<string, Record<string, unknown>>;
    mesh_status: Record<string, unknown> | null;
    card_url: string | null;
    send_url: string | null;
    created_at: number;
    updated_at: number;
}

function hash_bearer(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
}

function mint_bearer_plaintext(): string {
    return `cliq_a2a_${randomBytes(24).toString('hex')}`;
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

async function resolve_effective_provider(realm: RealmModel): Promise<string | null> {
    const mode = (realm.mesh_provider_mode ?? 'inherit') as Realm_mesh_provider_mode;
    if (mode === 'none') return null;
    if (mode === 'override') return realm.mesh_active_provider_id;

    if (!realm.org_id) return null;
    const org_mesh = await OrgMeshService.get_raw(realm.org_id);
    return org_mesh?.active_provider_id ?? null;
}

async function to_dto(realm: RealmModel): Promise<Realm_a2a_settings_dto> {
    const effective_provider_id = await resolve_effective_provider(realm);
    const base = realm.slug ? realm_public_a2a_url(realm.slug) : null;
    return {
        realm_id: realm.id,
        org_id: realm.org_id ?? null,
        a2a_enabled: Boolean(realm.a2a_enabled),
        has_bearer: Boolean(realm.a2a_bearer_token_hash),
        bearer_prefix: realm.a2a_bearer_token_prefix,
        mesh_provider_mode: (realm.mesh_provider_mode ?? 'inherit') as Realm_mesh_provider_mode,
        active_provider_id: realm.mesh_active_provider_id,
        effective_provider_id,
        providers: mask_all_providers(realm.mesh_providers ?? {}),
        mesh_status: realm.mesh_status,
        card_url: base ? `${base}/.well-known/agent-card.json` : null,
        send_url: base ? `${base}/send` : null,
        created_at: Number(realm.created_at),
        updated_at: Number(realm.updated_at),
    };
}

export class RealmA2aService {
    static list_adapters() {
        return list_mesh_adapters();
    }

    static async get_or_create(realm_id: string): Promise<Realm_a2a_settings_dto> {
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) throw ApiError.not_found('Realm not found');
        return to_dto(realm);
    }

    static async get_for_admin(realm_id: string, user_id: string): Promise<Realm_a2a_settings_dto> {
        await RealmService.require_admin(realm_id, user_id);
        return RealmA2aService.get_or_create(realm_id);
    }

    static async update_for_admin(
        realm_id: string,
        user_id: string,
        patch: {
            a2a_enabled?: boolean;
            mesh_provider_mode?: Realm_mesh_provider_mode;
            active_provider_id?: string | null;
            provider_id?: string;
            provider_settings?: Record<string, unknown>;
        },
    ): Promise<Realm_a2a_settings_dto> {
        await RealmService.require_admin(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) throw ApiError.not_found('Realm not found');

        if (patch.a2a_enabled !== undefined) {
            realm.a2a_enabled = patch.a2a_enabled;
        }
        if (patch.mesh_provider_mode !== undefined) {
            if (!['inherit', 'override', 'none'].includes(patch.mesh_provider_mode)) {
                throw ApiError.bad_request('Invalid mesh_provider_mode');
            }
            realm.mesh_provider_mode = patch.mesh_provider_mode;
        }
        if (patch.active_provider_id !== undefined) {
            if (patch.active_provider_id) get_mesh_adapter(patch.active_provider_id);
            realm.mesh_active_provider_id = patch.active_provider_id;
        }
        if (patch.provider_id && patch.provider_settings) {
            get_mesh_adapter(patch.provider_id);
            const providers = { ...(realm.mesh_providers ?? {}) };
            const existing = providers[patch.provider_id] ?? {};
            providers[patch.provider_id] = merge_provider_settings_patch(
                patch.provider_id,
                existing,
                patch.provider_settings,
            );
            realm.mesh_providers = providers;
        }

        realm.updated_at = Date.now();
        await realm.save();
        return to_dto(realm);
    }

    static async rotate_bearer(
        realm_id: string,
        user_id: string,
    ): Promise<Realm_a2a_settings_dto & { bearer: string }> {
        await RealmService.require_admin(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) throw ApiError.not_found('Realm not found');

        const plaintext = mint_bearer_plaintext();
        const token_hash = hash_bearer(plaintext);
        realm.a2a_bearer_token_hash = token_hash;
        realm.a2a_bearer_token_prefix = token_hash.slice(0, 16);
        realm.updated_at = Date.now();
        await realm.save();
        const dto = await to_dto(realm);
        return { ...dto, bearer: plaintext };
    }

    static async verify_bearer(plaintext: string): Promise<{ realm_id: string }> {
        const trimmed = plaintext.trim();
        if (!trimmed) throw ApiError.unauthorized('Invalid A2A bearer');

        const token_hash = hash_bearer(trimmed);
        const realm = await Realm.findOne({
            where: { a2a_bearer_token_hash: token_hash },
        });
        if (!realm || realm.deleted) throw ApiError.unauthorized('Invalid A2A bearer');
        if (!realm.a2a_enabled) throw ApiError.forbidden('A2A is disabled for this realm');

        return { realm_id: realm.id };
    }

    static async is_enabled(realm_id: string): Promise<boolean> {
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) return false;
        return realm.a2a_enabled === true;
    }

    /**
     * Authorize A2A /send: realm bearer OR active mesh adapter verify_inbound.
     */
    static async authorize_send(input: {
        slug: string;
        org_id?: string;
        authorization_header?: string;
        body: unknown;
        headers: Record<string, string | string[] | undefined>;
    }): Promise<{ realm_id: string }> {
        const where: Record<string, unknown> = { slug: input.slug };
        if (input.org_id) where.org_id = input.org_id;
        const realm = await Realm.findOne({ where });
        if (!realm || realm.deleted) throw ApiError.not_found(`Realm '${input.slug}' not found`);

        if (!realm.a2a_enabled) throw ApiError.forbidden('A2A is disabled for this realm');

        const auth = input.authorization_header ?? '';
        if (auth.startsWith('Bearer ')) {
            const token = auth.slice(7).trim();
            if (token.startsWith('cliq_a2a_')) {
                const verified = await RealmA2aService.verify_bearer(token);
                if (verified.realm_id !== realm.id) {
                    throw ApiError.unauthorized('Bearer does not match realm');
                }
                return { realm_id: realm.id };
            }
        }

        const effective = await resolve_effective_provider(realm);
        if (!effective) throw ApiError.unauthorized('Bearer token required');

        const adapter = get_mesh_adapter(effective);
        if (!adapter.verify_inbound) {
            throw ApiError.unauthorized('Bearer token required');
        }

        const settings = await RealmA2aService._resolve_provider_settings(realm, effective);
        const ok = await adapter.verify_inbound(
            { headers: input.headers, body: input.body },
            settings,
            realm.id,
        );
        if (!ok) throw ApiError.unauthorized('Invalid mesh dispatch auth');
        return { realm_id: realm.id };
    }

    static async connect_mesh(realm_id: string, user_id: string): Promise<Realm_a2a_settings_dto> {
        return RealmA2aService._run_mesh_action(realm_id, user_id, 'connect');
    }

    static async disconnect_mesh(realm_id: string, user_id: string): Promise<Realm_a2a_settings_dto> {
        return RealmA2aService._run_mesh_action(realm_id, user_id, 'disconnect');
    }

    static async refresh_mesh(realm_id: string, user_id: string): Promise<Realm_a2a_settings_dto> {
        return RealmA2aService._run_mesh_action(realm_id, user_id, 're_register');
    }

    private static async _run_mesh_action(
        realm_id: string,
        user_id: string,
        action: 'connect' | 'disconnect' | 're_register',
    ): Promise<Realm_a2a_settings_dto> {
        await RealmService.require_admin(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.deleted) throw ApiError.not_found('Realm not found');

        const effective = await resolve_effective_provider(realm);
        if (!effective) {
            throw ApiError.bad_request('No active mesh provider selected');
        }

        const adapter = get_mesh_adapter(effective);
        const settings = await RealmA2aService._resolve_provider_settings(realm, effective);
        const ctx = {
            realm_id: realm.id,
            realm_slug: realm.slug,
            settings,
            public_a2a_url: realm_public_a2a_url(realm.slug),
        };

        let health: Mesh_health;
        if (action === 'connect') health = await adapter.connect(ctx);
        else if (action === 'disconnect') health = await adapter.disconnect(ctx);
        else health = await adapter.re_register(ctx);

        const settings_patch = health.details?.settings_patch;
        if (settings_patch && typeof settings_patch === 'object') {
            const providers = { ...(realm.mesh_providers ?? {}) };
            providers[effective] = {
                ...(providers[effective] ?? {}),
                ...(settings_patch as Record<string, unknown>),
            };
            realm.mesh_providers = providers;
        }

        realm.mesh_status = {
            provider_id: effective,
            status: health.status,
            message: health.message,
            details: health.details
                ? Object.fromEntries(
                    Object.entries(health.details).filter(([k]) => k !== 'settings_patch' && k !== 'dispatch_secret_once'),
                )
                : undefined,
            ...(typeof health.details?.dispatch_secret_once === 'string'
                ? { dispatch_secret_once: health.details.dispatch_secret_once }
                : {}),
            updated_at: Date.now(),
        };
        realm.updated_at = Date.now();
        await realm.save();
        return to_dto(realm);
    }

    /**
     * inherit: org mesh defaults under realm overrides (realm wins).
     * override: realm mesh_providers only.
     */
    static async _resolve_provider_settings(
        realm: RealmModel,
        provider_id: string,
    ): Promise<Record<string, unknown>> {
        const realm_blob = realm.mesh_providers?.[provider_id] ?? {};
        if (realm.mesh_provider_mode === 'override') return { ...realm_blob };

        if (!realm.org_id) return { ...realm_blob };
        const org_mesh = await OrgMeshService.get_raw(realm.org_id);
        const org_blob = org_mesh?.providers?.[provider_id] ?? {};
        return { ...org_blob, ...realm_blob };
    }
}
