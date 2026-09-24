import { RealmDispatchKey } from '../models/index.js';
import type { RealmDispatchKeyModel } from '../models/realm_dispatch_key.model.js';
import { ApiError } from '../lib/api_error.js';
import { generate_dispatch_key_pair } from '../lib/dispatch_keys.js';
import { get_logger } from '../lib/log.js';
import { RealmService } from './realm.service.js';

const log = get_logger('realm-dispatch-key');

export interface PublicKeyResult {
    realm_id: string;
    public_key_pem: string;
    created_at: number;
    rotated_at: number;
}

function to_public(row: RealmDispatchKeyModel): PublicKeyResult {
    return {
        realm_id: row.realm_id,
        public_key_pem: row.public_key_pem,
        created_at: row.created_at,
        rotated_at: row.rotated_at,
    };
}

export class RealmDispatchKeyService {
    /**
     * Validate realm_id and check caller access.
     * `admin` (default) requires realm admin role — use for mutations.
     * `member` requires only realm membership — use for read-only ops.
     */
    static async resolve_realm_id(
        user_id: string,
        realm_id: string,
        access: 'admin' | 'member' = 'admin',
    ): Promise<string> {
        if (!realm_id?.trim()) {
            throw ApiError.bad_request('realm_id is required');
        }
        if (access === 'admin') {
            await RealmService.require_admin(realm_id.trim(), user_id);
        } else {
            await RealmService.assert_member(realm_id.trim(), user_id);
        }
        return realm_id.trim();
    }

    static async get_or_create_public_key(realm_id: string): Promise<PublicKeyResult> {
        const existing = await RealmDispatchKey.findByPk(realm_id);
        if (existing) return to_public(existing);

        const pair = await generate_dispatch_key_pair();
        const now = Date.now();

        try {
            const created = await RealmDispatchKey.create({
                realm_id,
                public_key_pem: pair.public_key_pem,
                private_key_pem: pair.private_key_pem,
                created_at: now,
                rotated_at: now,
            });
            log.info(`dispatch key created for realm ${realm_id}`);
            return to_public(created);
        } catch (err) {
            const raced = await RealmDispatchKey.findByPk(realm_id);
            if (raced) return to_public(raced);
            throw err;
        }
    }

    static async regenerate(realm_id: string): Promise<PublicKeyResult> {
        const pair = await generate_dispatch_key_pair();
        const now = Date.now();
        const existing = await RealmDispatchKey.findByPk(realm_id);

        if (!existing) {
            const created = await RealmDispatchKey.create({
                realm_id,
                public_key_pem: pair.public_key_pem,
                private_key_pem: pair.private_key_pem,
                created_at: now,
                rotated_at: now,
            });
            log.info(`dispatch key created via regenerate for realm ${realm_id}`);
            return to_public(created);
        }

        existing.public_key_pem = pair.public_key_pem;
        existing.private_key_pem = pair.private_key_pem;
        existing.rotated_at = now;
        await existing.save();
        log.info(`dispatch key regenerated for realm ${realm_id}`);
        return to_public(existing);
    }

    static async get_private_key_pem(realm_id: string): Promise<string> {
        await RealmDispatchKeyService.get_or_create_public_key(realm_id);
        const row = await RealmDispatchKey.findByPk(realm_id);
        if (!row) throw ApiError.internal(`Dispatch key missing for realm '${realm_id}'`);
        return row.private_key_pem;
    }

    /**
     * Ensure keys for every realm the user admins, plus any extras (admin-checked).
     * Returns public metadata only (never private keys).
     */
    static async backfill(
        user_id: string,
        extra_realm_ids: string[] = [],
    ): Promise<PublicKeyResult[]> {
        const from_membership = await RealmService.list_realm_ids_for_user(user_id);
        const ids = new Set<string>();
        for (const realm_id of from_membership) {
            try {
                await RealmService.require_admin(realm_id, user_id);
                ids.add(realm_id);
            } catch {
                // member-only — skip
            }
        }
        for (const id of extra_realm_ids) {
            if (!id.trim()) continue;
            await RealmService.require_admin(id.trim(), user_id);
            ids.add(id.trim());
        }

        const results: PublicKeyResult[] = [];
        for (const realm_id of [...ids].sort()) {
            results.push(await RealmDispatchKeyService.get_or_create_public_key(realm_id));
        }
        return results;
    }
}
