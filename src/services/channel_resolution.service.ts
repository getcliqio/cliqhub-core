/**
 * Channel resolution — the channel names a Hug asks resolved to the channels (and people) of its
 * realm and org (PLAN-hug-requests §6.4).
 */

import { Op } from 'sequelize';

import { NotificationChannelRepository } from '../repositories/notification_channel_repository.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.channel_resolution');
const channel_repo = new NotificationChannelRepository();

/**
 * Where a Hug's channels resolve to (PLAN-hug-requests §6.4). A Hug names a flat list of channels;
 * grouping them (a gate's reviewer groups) is the requester's concern, never Core's.
 */

/** One destination a channel name reached. */
export interface ChannelDestination {
    /** The channel name as the Hug gave it. */
    channel: string;
    /** The notification channel's id. */
    channel_id: string;
    /** Set when it is a person's channel; null for a shared (realm or org) channel. */
    user_id: string | null;
}

/** What a list of channel names resolved to. */
export interface ResolvedChannels {
    destinations: ChannelDestination[];
    /** Names with no channel the realm can use. */
    unresolved: string[];
}

/**
 * Resolve channel names against the channels the realm can use: the realm's own and its org's
 * (shared + personal). A channel and a person of the same name are both reached.
 */
export async function resolve_channels(
    org_id: string,
    channels: readonly string[],
    realm_id: string | null,
): Promise<ResolvedChannels> {
    const names = [...new Set(channels.map((c) => c.trim()).filter(Boolean))];
    if (names.length === 0) return { destinations: [], unresolved: [] };

    const channel_map = await _resolve_channel_names(org_id, names, realm_id);
    const destinations: ChannelDestination[] = [];
    const unresolved: string[] = [];
    for (const name of names) {
        const matches = channel_map.get(name) ?? [];
        if (matches.length === 0) {
            log.warn('channel_unresolved', { channel: name, org_id, realm_id });
            unresolved.push(name);
            continue;
        }
        for (const match of matches) destinations.push({ channel: name, channel_id: match.id, user_id: match.user_id });
    }
    return { destinations, unresolved };
}


// ── Internal helpers ─────────────────────────────────────────────

interface ResolvedChannel {
    id: string;
    user_id: string | null;
}

/**
 * Look up enabled channels by name: the channel (the realm's own when given, else the org's — a realm channel
 * wins over an org channel of the same name) and the personal channel of the person with that username (a
 * member of the realm when given, else of the org). Both, when both exist.
 * Returns a map of target string → the channels it reaches.
 */
async function _resolve_channel_names(
    org_id: string,
    targets: string[],
    realm_id: string | null,
): Promise<Map<string, ResolvedChannel[]>> {
    if (targets.length === 0) return new Map();

    const scopes: Record<string, unknown>[] = [{ org_id, realm_id: { [Op.is]: null } }];
    if (realm_id) scopes.push({ realm_id });
    const channels = await channel_repo.find_all(
        {
            [Op.or]: scopes,
            name: { [Op.in]: targets },
            enabled: 1,
        } as any,
        { attributes: ['id', 'name', 'user_id', 'realm_id'] },
    );
    /** Org channels first, so a realm channel of the same name replaces it. */
    channels.sort((a, b) => Number(Boolean(a.realm_id)) - Number(Boolean(b.realm_id)));

    const named = new Map<string, ResolvedChannel>();
    for (const ch of channels) {
        const original = targets.find(
            (t) => t.toLowerCase() === ch.name.toLowerCase(),
        );
        if (original) {
            named.set(original, { id: ch.id, user_id: ch.user_id ?? null });
        }
    }

    // And the personal channel of the person with that username.
    const { find_member_personal_channel } = await import('./per_user_channel.service.js');
    const result = new Map<string, ResolvedChannel[]>();
    for (const t of targets) {
        const found = named.has(t) ? [named.get(t)!] : [];
        const person = await find_member_personal_channel(t, { org_id, realm_id });
        if (person) found.push({ id: person.id, user_id: person.user_id });
        if (found.length > 0) result.set(t, found);
    }

    return result;
}

// ── The people behind a Hug's channels ───────────────────────────

/** What a Hug's channels reach. */
export interface PeopleReached {
    /** People Core can name: user id → the Hug channel name that reached them (first path). */
    people: Map<string, string>;
    /** Whether it also reaches people Core can't name (Slack, plain email addresses, webhooks, Jira). */
    external: boolean;
}

/** Destination types whose audience Core can't name. */
const EXTERNAL_DESTINATIONS = new Set(['slack', 'webhook', 'http', 'jira']);

/**
 * The people a Hug's destinations reach, transitively: a personal channel's owner; the members of
 * a shared channel's in-app notice and of a built-in members channel (a realm channel → the realm's
 * people, an org channel → the org's active members; an org's "All realm members" stands for the
 * Hug's realm); an email destination with `members: true` (the same members); and whatever a
 * `channel_ref` reaches (cycles skipped). Slack, plain email addresses and webhooks reach people Core
 * can't name (`external`). Suspended and deleted accounts are left out.
 */
export async function people_reached(destinations: readonly ChannelDestination[], realm_id: string): Promise<PeopleReached> {
    const { ChannelDestination: DestinationRow, NotificationChannel, OrgMember, RealmMember, User } = await import('../models/index.js');
    const { NotificationService } = await import('./notification.service.js');
    const { ORG_IN_APP_CHANNEL_KEY, ORG_REALM_MEMBERS_CHANNEL_KEY, REALM_MEMBERS_CHANNEL_KEY } = await import('../notifications/defaults.js');

    const found = new Map<string, string>();
    let external = false;
    const add = (ids: Iterable<string>, via: string) => { for (const id of ids) if (!found.has(id)) found.set(id, via); };
    const realm_people = async (rid: string) => (await RealmMember.findAll({ where: { realm_id: rid, member_type: 'user' }, attributes: ['member_id'], raw: true }))
        .map((m) => String((m as { member_id: string }).member_id));
    const org_people = async (oid: string) => (await OrgMember.findAll({ where: { org_id: oid, status: 'active' } as never, attributes: ['user_id'], raw: true }))
        .map((m) => String((m as { user_id: string }).user_id));

    type Row = { id: string; user_id: string | null; realm_id: string | null; org_id: string | null; system_key: string | null };
    /** Everyone a channel stands for as "its members" (built-in members channels, `members: true`). */
    const members_of = async (ch: Row): Promise<string[]> => {
        if (ch.system_key === ORG_REALM_MEMBERS_CHANNEL_KEY) return realm_people(realm_id);
        if (ch.realm_id) return realm_people(ch.realm_id);
        return ch.org_id ? org_people(ch.org_id) : [];
    };

    const visited = new Set<string>();
    const visit = async (channel_id: string, via: string): Promise<void> => {
        if (visited.has(channel_id)) return;
        visited.add(channel_id);
        const ch = await NotificationChannel.findOne({
            where: { id: channel_id, enabled: 1 } as never,
            include: [{ model: DestinationRow, as: 'destinations_rows' }],
        });
        if (!ch) return;
        const row = ch.get({ plain: true }) as Row & { destinations_rows?: Array<{ type: string; config: Record<string, unknown> }> };
        if (row.user_id) add([row.user_id], via);
        const key = row.system_key ?? '';
        if ([REALM_MEMBERS_CHANNEL_KEY, ORG_IN_APP_CHANNEL_KEY, ORG_REALM_MEMBERS_CHANNEL_KEY].includes(key)) add(await members_of(row), via);
        for (const d of row.destinations_rows ?? []) {
            // A personal channel's endpoints are its owner's; only a shared channel's reach unnamed people.
            if (!row.user_id && (EXTERNAL_DESTINATIONS.has(d.type) || (d.type === 'email' && typeof d.config['address'] === 'string'))) external = true;
            if (!row.user_id && (d.type === 'cliqhub' || (d.type === 'email' && d.config['members'] === true))) add(await members_of(row), via);
            if (d.type === 'channel_ref' && typeof d.config['name'] === 'string') {
                for (const next of await NotificationService.find_realm_usable_channels(d.config['name'], realm_id)) await visit(next.id, via);
            }
        }
    };
    for (const d of destinations) await visit(d.channel_id, d.channel);

    if (found.size === 0) return { people: found, external };
    const live = new Set((await User.findAll({ where: { id: { [Op.in]: [...found.keys()] }, deleted_at: null, status: { [Op.ne]: 'suspended' } } as never, attributes: ['id'], raw: true }))
        .map((u) => String((u as { id: string }).id)));
    return { people: new Map([...found].filter(([id]) => live.has(id))), external };
}
