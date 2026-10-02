/**
 * Raises org-scoped identity events (invites, org lifecycle, account emails;
 * see notifications/org_events.ts).
 *
 * An event is stored in `events` (payload `{ actor, data }`, no token or
 * link) and delivered through the org's notification rules by
 * {@link NotificationFanOutService.notify_org}. Services raise events with
 * {@link OrgEventService.raise_after_commit} inside their transaction, so an
 * event exists only for a committed change, then read the outcome
 * (`email_sent`) once the transaction has returned.
 */

import { randomUUID } from 'node:crypto';
import type { Transaction } from 'sequelize';

import { get_logger } from '../lib/log.js';
import { HubEventRepository } from '../repositories/hub_event_repository.js';
import { NotificationFanOutService } from '../notifications/fan_out.service.js';
import { EVENT_TYPE_SEVERITY } from '../schemas/event_types.js';
import {
    describe_org_event,
    type OrgEventPayload,
    type OrgEventResult,
    type OrgEventType,
    type RaiseOrgEventInput,
} from '../notifications/org_events.js';
import { to_dto } from './events_service.js';

const log = get_logger('svc.org_events');
const hub_event_repo = new HubEventRepository();

/** A raised event whose delivery runs when its transaction commits. */
export interface PendingOrgEvent {
    /**
     * Settles once the transaction committed and the event was delivered.
     * Never rejects; if the transaction rolls back it never settles, so only
     * await it after the transaction returned.
     */
    result: Promise<OrgEventResult>;
}

/**
 * Stores and delivers org events.
 */
export class OrgEventService {
    /**
     * Stores the event and delivers it now. Use it outside a transaction (the
     * sweep); inside one use {@link raise_after_commit}. Never throws: a failure
     * is logged and reported as `status: 'failed'`.
     *
     * @param input - The event name, org, actor, data and optional link source.
     */
    static async raise<T extends OrgEventType>(input: RaiseOrgEventInput<T>): Promise<OrgEventResult> {
        let event_id: string | null = null;
        try {
            const { title, message } = describe_org_event(input.event, input.data);
            const payload: OrgEventPayload = { actor: input.actor, data: input.data };
            const row = await hub_event_repo.create_one({
                id: randomUUID(),
                type: input.event,
                occurred_at: input.occurred_at ?? new Date().toISOString(),
                realm_id: input.realm_id ?? null,
                org_id: input.org_id,
                team: null,
                run_id: null,
                phase: null,
                daemon_id: null,
                title,
                message,
                severity: EVENT_TYPE_SEVERITY[input.event],
                payload_json: JSON.stringify(payload),
                actor_id: 'user_id' in input.actor ? input.actor.user_id : null,
                created_at: Date.now(),
            });
            event_id = row.id;
            const { status, deliveries } = await NotificationFanOutService.notify_org(to_dto(row), input.link);
            const emails = deliveries.filter((d) => d.type === 'email' && d.ok);
            const email_sent = input.link ? emails.some((d) => d.with_links) : emails.length > 0;
            log.info('org_event_raised', { event: input.event, event_id, org_id: input.org_id, notifications: status, email_sent });
            return { event_id, status: status === 'deferred' ? 'skipped' : status, deliveries, email_sent };
        } catch (err) {
            log.error('org_event_failed', { event: input.event, event_id, org_id: input.org_id, error: err instanceof Error ? err.message : String(err) });
            return { event_id, status: 'failed', deliveries: [], email_sent: false };
        }
    }

    /**
     * Raises the event when `t` commits (nothing happens on rollback).
     *
     * @param t - The caller's transaction.
     * @param input - The event name, org, actor, data and optional link source.
     * @returns A handle whose `result` settles after commit and delivery.
     */
    static raise_after_commit<T extends OrgEventType>(t: Transaction, input: RaiseOrgEventInput<T>): PendingOrgEvent {
        let settle: (r: OrgEventResult) => void = () => undefined;
        const result = new Promise<OrgEventResult>((resolve) => { settle = resolve; });
        t.afterCommit(async () => { settle(await OrgEventService.raise(input)); });
        return { result };
    }
}
