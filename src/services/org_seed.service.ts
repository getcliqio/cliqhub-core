/**
 * Seeds an org's default notification setup: the locked Email channel
 * (Brevo), the In-app channel and the default rules for invite, org and
 * account events, each carrying a `system_key`.
 *
 * Seeding is idempotent by `system_key`: a row that exists is left alone, a
 * missing one is created. Org creation paths seed inside their transaction.
 * Existing orgs are seeded once at boot ({@link OrgSeedService.backfill});
 * `orgs.notifications_seeded_at` marks seeded orgs so a default rule an owner
 * removed is not brought back.
 *
 * The defaults are versioned ({@link DEFAULTS_VERSION}, each rule has the
 * version that introduced it). An org records the version it has
 * (`orgs.notifications_seed_version`); at boot
 * {@link OrgSeedService.upgrade_defaults} adds to every seeded org only the
 * rules of later versions, once.
 */

import { randomUUID } from 'node:crypto';
import { Op, QueryTypes, type Transaction } from 'sequelize';

import { get_logger } from '../lib/log.js';
import { ChannelDestination, NotificationChannel, NotificationRule, Org } from '../models/index.js';
import {
    INVITE_KINDS,
    ORG_ABANDONED,
    USER_PASSWORD_CHANGED,
    USER_PASSWORD_RESET_SENT,
    USER_SETUP_SENT,
    invite_event,
    type OrgEventType,
} from '../notifications/org_events.js';
import type { RecipientSelector } from '../notifications/recipients.js';

const log = get_logger('svc.org_seed');

/** `system_key` of the seeded Email channel. */
export const ORG_EMAIL_CHANNEL_KEY = 'org.email';
/** `system_key` of the seeded In-app channel. */
export const ORG_IN_APP_CHANNEL_KEY = 'org.in_app';

type ChannelKey = typeof ORG_EMAIL_CHANNEL_KEY | typeof ORG_IN_APP_CHANNEL_KEY;

/** A seeded channel. */
interface ChannelSpec {
    system_key: ChannelKey;
    name: string;
    lock_reason: string | null;
    destination: { type: string; config: Record<string, unknown> };
}

/** A seeded rule. */
export interface DefaultRuleSpec {
    system_key: string;
    event: OrgEventType;
    channel: ChannelKey;
    recipients: RecipientSelector[];
    lock_reason: string | null;
    /** The defaults version that introduced this rule. */
    version: number;
}

/**
 * Version of the default rules. 1: Email rules, in-app for invite outcomes
 * and abandoned orgs. 2: in-app copies of the invite and account email rules
 * (except the set-password email: that person cannot sign in yet).
 */
export const DEFAULTS_VERSION = 2;

const CHANNELS: readonly ChannelSpec[] = [
    {
        system_key: ORG_EMAIL_CHANNEL_KEY,
        name: 'Email',
        lock_reason: 'Invites and account emails are sent through this channel.',
        destination: { type: 'email', config: { provider: 'brevo' } },
    },
    {
        system_key: ORG_IN_APP_CHANNEL_KEY,
        name: 'In-app',
        lock_reason: null,
        destination: { type: 'cliqhub', config: {} },
    },
];

const NOTIFY: RecipientSelector[] = ['org_owners', 'inviter'];

/** SQL (over `orgs o`): true for an account org, one of whose members has the org's slug as username. */
const ACCOUNT_ORG_SQL = `EXISTS (
    SELECT 1 FROM org_members om JOIN users u ON u.id = om.user_id
    WHERE om.org_id = o.id AND lower(u.username) = lower(o.slug)
)`;

/**
 * The default rules for an org. Account orgs (a user's own org) also get the
 * account email rules (set password, reset, password changed).
 *
 * @param account - Whether the org is a user's account org.
 */
export function default_rule_specs(account: boolean): DefaultRuleSpec[] {
    const rules: DefaultRuleSpec[] = [];
    /** An Email rule and (from version 2) its unlocked In-app copy for the same event and recipients. */
    const email_and_in_app = (system_key: string, event: OrgEventType, recipients: RecipientSelector[], lock_reason: string) => rules.push(
        { system_key, event, channel: ORG_EMAIL_CHANNEL_KEY, recipients, lock_reason, version: 1 },
        { system_key, event, channel: ORG_IN_APP_CHANNEL_KEY, recipients, lock_reason: null, version: 2 },
    );
    for (const kind of INVITE_KINDS) {
        email_and_in_app('invite.sent.invitee', invite_event(kind, 'sent'), ['invitee'], 'Invites must reach the invited person.');
        email_and_in_app('invite.reminder.invitee', invite_event(kind, 'reminder'), ['invitee'], 'Invite reminders must reach the invited person.');
        for (const action of ['accepted', 'declined', 'expired'] as const) {
            for (const channel of [ORG_EMAIL_CHANNEL_KEY, ORG_IN_APP_CHANNEL_KEY] as const) {
                rules.push({ system_key: `invite.${action}.notify`, event: invite_event(kind, action), channel, recipients: NOTIFY, lock_reason: null, version: 1 });
            }
        }
    }
    rules.push({ system_key: 'org.abandoned.notify', event: ORG_ABANDONED, channel: ORG_IN_APP_CHANNEL_KEY, recipients: ['inviter'], lock_reason: null, version: 1 });
    if (account) {
        const reason = 'Account emails must reach the person.';
        // Set-password goes by email only: that person cannot sign in to an inbox yet.
        rules.push({ system_key: 'user.setup.user', event: USER_SETUP_SENT, channel: ORG_EMAIL_CHANNEL_KEY, recipients: ['user'], lock_reason: reason, version: 1 });
        email_and_in_app('user.password_reset.user', USER_PASSWORD_RESET_SENT, ['user'], reason);
        email_and_in_app('user.password_changed.user', USER_PASSWORD_CHANGED, ['user'], reason);
    }
    return rules;
}

/** What one seeding run created. */
export interface SeedResult {
    channels_created: number;
    rules_created: number;
}

/**
 * Creates and restores org default channels and rules.
 */
export class OrgSeedService {
    /**
     * Creates whatever default channels and rules `org_id` is missing and marks
     * the org seeded. Locked rows are created locked; unlocked defaults stay
     * editable.
     *
     * @param org_id - The org.
     * @param opts.account - Whether it is a user's account org (adds account email rules).
     * @param opts.transaction - The caller's transaction (org creation paths pass theirs).
     * @param opts.since_version - Only create rules introduced after this defaults version.
     */
    static async seed_org(org_id: string, opts: { account: boolean; transaction?: Transaction; since_version?: number }): Promise<SeedResult> {
        const transaction = opts.transaction;
        const now = Date.now();
        const result: SeedResult = { channels_created: 0, rules_created: 0 };

        const channel_ids = new Map<ChannelKey, string>();
        for (const spec of CHANNELS) {
            const existing = await NotificationChannel.findOne({ where: { org_id, system_key: spec.system_key }, attributes: ['id'], transaction });
            if (existing) {
                channel_ids.set(spec.system_key, existing.id);
                continue;
            }
            const id = randomUUID();
            await NotificationChannel.create({
                id, realm_id: null, org_id, user_id: null,
                name: await OrgSeedService._free_channel_name(org_id, spec.name, transaction),
                secret: null, enabled: 1, created_at: now, updated_at: now,
                system_key: spec.system_key, locked: spec.lock_reason !== null, lock_reason: spec.lock_reason,
            }, { transaction });
            await ChannelDestination.create({ id: randomUUID(), channel_id: id, type: spec.destination.type, config: spec.destination.config, created_at: now }, { transaction });
            channel_ids.set(spec.system_key, id);
            result.channels_created += 1;
        }

        for (const spec of default_rule_specs(opts.account).filter((r) => r.version > (opts.since_version ?? 0))) {
            const channel_id = channel_ids.get(spec.channel)!;
            const existing = await NotificationRule.findOne({ where: { org_id, system_key: spec.system_key, event: spec.event, channel_id }, attributes: ['id'], transaction });
            if (existing) continue;
            await NotificationRule.create({
                realm_id: null, org_id, team_slug: null, event: spec.event, channel_id, priority: 0,
                created_at: now, updated_at: now,
                recipients: spec.recipients, system_key: spec.system_key,
                locked: spec.lock_reason !== null, lock_reason: spec.lock_reason,
            }, { transaction });
            result.rules_created += 1;
        }

        await Org.update({ notifications_seeded_at: new Date() }, { where: { id: org_id, notifications_seeded_at: { [Op.is]: null } }, transaction });
        await Org.update({ notifications_seed_version: DEFAULTS_VERSION }, { where: { id: org_id }, transaction });
        if (result.channels_created || result.rules_created) log.info('org_seeded', { org_id, account: opts.account, ...result });
        return result;
    }

    /**
     * Seeds every live org that was never seeded (boot backfill). An org is an
     * account org when one of its members has the org's slug as username.
     * Each org is seeded in its own transaction under a per-org advisory lock
     * and re-checked inside it, so instances booting together seed each org
     * once; an org that fails is logged and left for the next boot.
     *
     * @returns How many orgs were seeded.
     */
    static async backfill(): Promise<{ orgs_seeded: number }> {
        const rows = await Org.sequelize!.query<{ id: string; account: boolean }>(`
            SELECT o.id, ${ACCOUNT_ORG_SQL} AS account
            FROM orgs o
            WHERE o.notifications_seeded_at IS NULL AND o.deleted_at IS NULL
        `, { type: QueryTypes.SELECT });
        let orgs_seeded = 0;
        for (const row of rows) {
            const org_id = String(row.id);
            try {
                const seeded = await Org.sequelize!.transaction(async (transaction) => {
                    await Org.sequelize!.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `org_seed:${org_id}` }, transaction });
                    const org = await Org.findByPk(org_id, { attributes: ['notifications_seeded_at'], raw: true, transaction });
                    if (!org || org.notifications_seeded_at) return false;
                    await OrgSeedService.seed_org(org_id, { account: Boolean(row.account), transaction });
                    return true;
                });
                if (seeded) orgs_seeded += 1;
            } catch (err) {
                log.error('org_seed_backfill_failed', { org_id, error: err instanceof Error ? err.message : String(err) });
            }
        }
        return { orgs_seeded };
    }

    /**
     * Adds to every seeded live org the default rules introduced after the
     * version it has (null counts as 1), once: the org's version is raised in
     * the same transaction, under a per-org advisory lock. A rule of an older
     * version an owner removed stays removed.
     *
     * @returns How many orgs were upgraded.
     */
    static async upgrade_defaults(): Promise<{ orgs_upgraded: number }> {
        const rows = await Org.sequelize!.query<{ id: string; account: boolean }>(`
            SELECT o.id, ${ACCOUNT_ORG_SQL} AS account
            FROM orgs o
            WHERE o.notifications_seeded_at IS NOT NULL AND o.deleted_at IS NULL
              AND COALESCE(o.notifications_seed_version, 1) < :version
        `, { type: QueryTypes.SELECT, replacements: { version: DEFAULTS_VERSION } });
        let orgs_upgraded = 0;
        for (const row of rows) {
            const org_id = String(row.id);
            try {
                const upgraded = await Org.sequelize!.transaction(async (transaction) => {
                    await Org.sequelize!.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `org_seed:${org_id}` }, transaction });
                    const org = await Org.findByPk(org_id, { attributes: ['notifications_seed_version'], raw: true, transaction });
                    const since = org?.notifications_seed_version ?? 1;
                    if (!org || since >= DEFAULTS_VERSION) return false;
                    await OrgSeedService.seed_org(org_id, { account: Boolean(row.account), transaction, since_version: since });
                    return true;
                });
                if (upgraded) orgs_upgraded += 1;
            } catch (err) {
                log.error('org_seed_upgrade_failed', { org_id, error: err instanceof Error ? err.message : String(err) });
            }
        }
        return { orgs_upgraded };
    }

    /** `name`, or `name (system)` when the org already has a channel called `name`. */
    private static async _free_channel_name(org_id: string, name: string, transaction?: Transaction): Promise<string> {
        const taken = await NotificationChannel.findOne({ where: { org_id, realm_id: null, name }, attributes: ['id'], transaction });
        return taken ? `${name} (system)` : name;
    }
}
