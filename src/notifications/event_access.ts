/**
 * Who may receive an event — the fan-out's access filter.
 *
 * Channels route events anywhere; a person absorbs an event about a realm only when they may see it
 * there: a standing in the realm (member, org owner/admin, realm owner) and the event's permission on
 * their org role — the route policy's own rule (`visible_realm_ids`). Events without a realm (org and
 * account events, invites) are not filtered. Endpoints Core can't tie to a person (Slack, plain email
 * addresses, webhooks) are not filtered either: they get what their channel sends.
 */

import { visible_realm_ids } from '../auth/route_policy/visible.js';
import type { Permission } from '../auth/route_policy/policy.js';

/** The permission an event about a realm needs (none: seeing the realm is enough). */
export function event_permission(event: string): Permission | undefined {
	if (event.startsWith('daemon.')) return 'daemons.view';
	if (event.startsWith('realm.')) return undefined;
	return 'runs.view';
}

/** Whether `user_id` may receive `event` about `realm_id` (always, when the event has no realm). */
export async function can_receive(user_id: string, realm_id: string | null | undefined, event: string): Promise<boolean> {
	if (!realm_id) return true;
	return (await visible_realm_ids(user_id, { perm: event_permission(event) })).includes(realm_id);
}

/** Realm ids a person may receive events about, per kind of event (for filtering an inbox in one query). */
export interface ReceivableRealms {
	runs: string[];
	daemons: string[];
	visible: string[];
}

/** {@link ReceivableRealms} for one person. */
export async function receivable_realms(user_id: string): Promise<ReceivableRealms> {
	const [runs, daemons, visible] = await Promise.all([
		visible_realm_ids(user_id, { perm: 'runs.view' }),
		visible_realm_ids(user_id, { perm: 'daemons.view' }),
		visible_realm_ids(user_id),
	]);
	return { runs, daemons, visible };
}
