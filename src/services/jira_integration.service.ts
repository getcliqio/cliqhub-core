/**
 * JIRA Forge plugin backend service (slices 1.5 + 1.8).
 *
 * Model: **many-to-many (realm × workspace)**. A single JIRA workspace
 * can be bound into N realms — each binding is a separate
 * `notification_channel` row scoped to (realm_id, name=`jira-<workspace_id>`).
 * A single realm can also bind into N JIRA workspaces (one row per
 * workspace). This is the runtime model per slice 1.8: the Forge
 * plugin stops asking the operator "which realm?" up front and instead
 * lazy-provisions a channel the first time a run is dispatched to a
 * given realm from a given workspace.
 *
 * Register is idempotent per (realm_id, workspace_id):
 *  - First call: creates the channel, mints its webhook secret, wires
 *    the 7 lifecycle rules, returns the plaintext secret ONCE.
 *  - Subsequent calls: returns the same subscription_id and re-asserts
 *    the rules, but does NOT rotate or return the secret.
 *
 * Auth: split into a controller-level resolver (`resolve_jira_caller`)
 * and this service. The service takes a resolved `user_id` — it doesn't
 * know or care whether the caller came in on a JWT session (SPA) or a
 * body-carried PAT (Forge). Callers pass user_id to every method.
 *
 * See DESIGN-jira-forge-plugin slices 1.5 and 1.8.
 */

import crypto from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { Op } from 'sequelize';

import { verify_password } from '../auth/password.js';
import { TokenRepository } from '../repositories/token_repository.js';
import { ApiError } from '../lib/api_error.js';
import { RealmService } from './realm.service.js';
import { NotificationService } from './notification.service.js';
import {
    NotificationChannel,
    NotificationRule,
    Realm,
    RealmMember,
} from '../models/index.js';
import { User } from '../db/models/index.js';

/**
 * Seven lifecycle event types wired into the JIRA integration (see
 * DESIGN-jira-forge-plugin §2.5 and slice 1.3). Kept as a module const
 * so tests can import it and assert we haven't drifted from the design.
 */
export const JIRA_LIFECYCLE_EVENTS = [
    'run.started',
    'run.completed',
    'run.failed',
    'run.cancelled',
    'run.crashed',
    'phase.input_required',
    'phase.inputs_supplied',
] as const;

/** Scopes required when the PAT opts into least-privilege (slice 1.6). */
const REQUIRED_SCOPES = ['dispatch', 'read:realms'] as const;

const JIRA_CHANNEL_NAME_PREFIX = 'jira-';

export interface JiraRegisterInput {
    /** Target realm — caller must be admin of this realm. */
    realm_id: string;
    webhook_url: string;
    workspace_id: string;
    workspace_url: string;
}

export interface JiraRegisterResult {
    subscription_id: string;
    /** Only present on first register; re-register returns undefined. */
    webhook_secret?: string;
    realm_id: string;
    workspace_id: string;
    cliq_user: {
        id: string;
        username: string;
        email: string;
    };
}

export interface JiraAdminRealm {
    id: string;
    slug: string;
    name: string;
}

export interface JiraChannelListRow {
    realm_id: string;
    realm_slug: string;
    realm_name: string;
    /** Present when this realm has a JIRA channel; null otherwise. */
    channel_id: string | null;
    workspace_id: string | null;
    connected_at: number | null;
}

function sha256_hex(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext).digest('hex');
}

function extract_workspace_id(channel_name: string): string | null {
    if (!channel_name.startsWith(JIRA_CHANNEL_NAME_PREFIX)) return null;
    return channel_name.slice(JIRA_CHANNEL_NAME_PREFIX.length);
}

const _token_repo = new TokenRepository();

/**
 * Resolve a plaintext PAT into the owning user id, enforcing the JIRA
 * scope contract. Throws 401 on any failure — the endpoint should NOT
 * leak which step failed (missing token, wrong type, wrong scopes) so
 * probes can't map the auth surface.
 *
 * Exported for the controller layer only; call sites should be the two
 * JIRA controllers that need to accept either a session JWT (SPA) or a
 * body PAT (Forge).
 */
export async function authenticate_jira_pat(api_token: string): Promise<{ user_id: string }> {
    const token = api_token.trim();
    if (!token.startsWith('cliq_tok_')) {
        throw ApiError.unauthorized('invalid api_token');
    }

    const prefix = sha256_hex(token).slice(0, 16);
    const row = await _token_repo.find_by_prefix(prefix);
    if (!row || row.type !== 'user') {
        throw ApiError.unauthorized('invalid api_token');
    }

    const ok = await verify_password(token, row.token_hash);
    if (!ok) throw ApiError.unauthorized('invalid api_token');

    // Scope enforcement mirrors require_token_scope semantics (slice
    // 1.6): if the operator opted into least-privilege by minting the
    // token with a non-empty scopes array, it MUST include both
    // required scopes. Legacy tokens (empty scopes) fall through.
    const scopes = Array.isArray((row as { scopes?: unknown }).scopes)
        ? ((row as { scopes: unknown[] }).scopes.filter(
            (s): s is string => typeof s === 'string',
        ))
        : [];
    if (scopes.length > 0) {
        const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
        if (missing.length > 0) {
            throw ApiError.unauthorized('invalid api_token');
        }
    }

    _token_repo.update_last_used(String(row.id)).catch(() => {});
    return { user_id: row.user_id };
}

/**
 * List realms where the given user is an admin. Powers both
 * `list_realms` (Forge Connect dropdown) and `list_channels` (SPA
 * table's row set). Fresh sequelize query — no cached view.
 */
async function _list_admin_realms(user_id: string): Promise<JiraAdminRealm[]> {
    const memberships = await RealmMember.findAll({
        where: { member_type: 'user', member_id: user_id, role: 'admin' },
        attributes: ['realm_id'],
    });
    if (memberships.length === 0) return [];

    const realm_ids = memberships.map((m) => m.realm_id);
    const realms = await Realm.findAll({
        where: { id: { [Op.in]: realm_ids } },
        attributes: ['id', 'slug', 'name'],
        order: [['slug', 'ASC']],
    });
    return realms.map((r) => ({
        id: (r as unknown as { id: string }).id,
        slug: (r as unknown as { slug: string }).slug,
        name: (r as unknown as { name: string }).name,
    }));
}

export class JiraIntegrationService {

    /**
     * Register (or re-register) a Forge workspace into a specific realm.
     * The caller (already resolved by the controller) must be admin of
     * that realm. Idempotent per (realm_id, workspace_id).
     */
    static async register(user_id: string, input: JiraRegisterInput): Promise<JiraRegisterResult> {
        const user = await User.findByPk(user_id);
        if (!user) throw ApiError.unauthorized('invalid caller');

        const realm_id = input.realm_id.trim();
        if (!realm_id) throw ApiError.bad_request('realm_id is required');

        // Verify realm exists AND caller is admin. require_admin throws
        // 403 if the user isn't a member with role=admin.
        const realm = await Realm.findByPk(realm_id);
        if (!realm) throw ApiError.not_found(`realm '${realm_id}' not found`);
        await RealmService.require_admin(realm_id, String(user_id));

        const workspace_id = input.workspace_id.trim();
        const channel_name = `${JIRA_CHANNEL_NAME_PREFIX}${workspace_id}`;
        const existing = await NotificationService.find_channel_by_name(channel_name, realm_id);

        const cliq_user = { id: user.id, username: user.username, email: user.email };

        // Idempotent path: existing channel keeps its secret. Forge
        // stored it from the first register; caller must rotate if
        // they lost it (that's what /rotate_secret is for).
        if (existing) {
            for (const event of JIRA_LIFECYCLE_EVENTS) {
                await NotificationService.set_rule({ realm_id, event, channel_id: existing.id });
            }
            return {
                subscription_id: existing.id,
                realm_id,
                workspace_id,
                cliq_user,
            };
        }

        const webhook_secret = `whsec_${randomBytes(24).toString('hex')}`;
        // webhook_config_schema is .strict() — only { url, secret, headers }
        // pass through. `workspace_id` is already encoded in the channel
        // name and `workspace_url` lives on the Forge side.
        const created = await NotificationService.create_channel({
            realm_id,
            name: channel_name,
            destinations: [{ type: 'webhook', url: input.webhook_url, secret: webhook_secret }],
        });

        for (const event of JIRA_LIFECYCLE_EVENTS) {
            await NotificationService.set_rule({ realm_id, event, channel_id: created.id });
        }

        return {
            subscription_id: created.id,
            webhook_secret,
            realm_id,
            workspace_id,
            cliq_user,
        };
    }

    /**
     * Rotate the webhook secret for a JIRA channel bound to a specific
     * realm. Caller must be admin of the target realm.
     */
    static async rotate_secret(user_id: string, input: {
        realm_id: string;
        workspace_id: string;
    }): Promise<{ secret: string }> {
        const realm_id = input.realm_id.trim();
        if (!realm_id) throw ApiError.bad_request('realm_id is required');
        await RealmService.require_admin(realm_id, String(user_id));

        const channel_name = `${JIRA_CHANNEL_NAME_PREFIX}${input.workspace_id.trim()}`;
        const existing = await NotificationService.find_channel_by_name(channel_name, realm_id);
        if (!existing) {
            throw ApiError.not_found(
                `no JIRA integration channel for workspace '${input.workspace_id}' in realm '${realm_id}'`,
            );
        }

        return NotificationService.rotate_channel_secret(existing.id);
    }

    /**
     * Realms the caller can admin, in slug order. Powers the Forge
     * Connect page's "which realm?" dropdown (before register is
     * called).
     */
    static async list_realms(user_id: string): Promise<JiraAdminRealm[]> {
        return _list_admin_realms(String(user_id));
    }

    /**
     * Every JIRA channel across every realm the caller admins. In the
     * slice-1.8 model a realm may bind to N workspaces AND a workspace
     * may bind to N realms; this returns one row per (realm × channel)
     * pair. Realms with no bindings still emit a single row with
     * channel_id=null so the SPA can render an "unbound" state.
     * Sorted by realm slug, then workspace_id, for stable UI output.
     */
    static async list_channels(user_id: string): Promise<JiraChannelListRow[]> {
        const realms = await _list_admin_realms(String(user_id));
        if (realms.length === 0) return [];

        const realm_ids = realms.map((r) => r.id);
        const channels = await NotificationChannel.findAll({
            where: {
                realm_id: { [Op.in]: realm_ids },
                name: { [Op.like]: `${JIRA_CHANNEL_NAME_PREFIX}%` },
            },
            attributes: ['id', 'realm_id', 'name', 'created_at'],
        });

        const by_realm = new Map<string, Array<{ id: string; name: string; created_at: number }>>();
        for (const ch of channels) {
            const plain = ch as unknown as { id: string; realm_id: string; name: string; created_at: number };
            const list = by_realm.get(plain.realm_id) ?? [];
            list.push({ id: plain.id, name: plain.name, created_at: Number(plain.created_at) });
            by_realm.set(plain.realm_id, list);
        }

        const rows: JiraChannelListRow[] = [];
        for (const realm of realms) {
            const bindings = by_realm.get(realm.id);
            if (!bindings || bindings.length === 0) {
                rows.push({
                    realm_id: realm.id,
                    realm_slug: realm.slug,
                    realm_name: realm.name,
                    channel_id: null,
                    workspace_id: null,
                    connected_at: null,
                });
                continue;
            }
            bindings.sort((a, b) => a.name.localeCompare(b.name));
            for (const b of bindings) {
                rows.push({
                    realm_id: realm.id,
                    realm_slug: realm.slug,
                    realm_name: realm.name,
                    channel_id: b.id,
                    workspace_id: extract_workspace_id(b.name),
                    connected_at: b.created_at,
                });
            }
        }
        return rows;
    }

    /**
     * Remove a JIRA channel (and its 7 rules) from a realm. Called
     * when the operator uninstalls the Forge plugin from that workspace
     * or when they explicitly disconnect a realm from the SPA. Same
     * admin gate as register/rotate.
     */
    static async disconnect(user_id: string, input: {
        realm_id: string;
        workspace_id: string;
    }): Promise<{ removed: boolean }> {
        const realm_id = input.realm_id.trim();
        if (!realm_id) throw ApiError.bad_request('realm_id is required');
        await RealmService.require_admin(realm_id, String(user_id));

        const channel_name = `${JIRA_CHANNEL_NAME_PREFIX}${input.workspace_id.trim()}`;
        const existing = await NotificationService.find_channel_by_name(channel_name, realm_id);
        if (!existing) return { removed: false };

        await NotificationRule.destroy({ where: { channel_id: existing.id } });
        await NotificationChannel.destroy({ where: { id: existing.id } });
        return { removed: true };
    }

    /** Cheap boolean read of the feature flag. Exported for tests. */
    static is_enabled(): boolean {
        return process.env.ENABLE_JIRA_INTEGRATION === '1';
    }
}
