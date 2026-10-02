/**
 * `email_deliveries`: one row per email the Email channel tried to send for
 * an invite, a password link or an account (never the link or the body).
 */

import type { CreationAttributes } from 'sequelize';

import { BaseRepository } from './base_repository.js';
import { EmailDelivery, type EmailSubjectType } from '../models/email_delivery.model.js';

/** One send attempt to record. */
export interface EmailDeliveryRecord {
    subject_type: EmailSubjectType;
    subject_id: string;
    event: string;
    event_id: string | null;
    org_id: string | null;
    channel_id: string | null;
    to: string;
    ok: boolean;
    provider_message_id: string | null;
    error: string | null;
}

/** Longest `error` kept on a row. */
const MAX_ERROR_LENGTH = 500;

/** Writes and reads `email_deliveries`. */
export class EmailDeliveryRepository extends BaseRepository<EmailDelivery> {
    protected readonly model = EmailDelivery;

    /**
     * Records one send attempt (sent now).
     *
     * @param r - Subject, event, recipient and outcome.
     * @throws Error when the insert fails.
     */
    async record(r: EmailDeliveryRecord): Promise<EmailDelivery> {
        return this.create_one({
            ...r,
            error: r.error ? r.error.slice(0, MAX_ERROR_LENGTH) : null,
            sent_at: new Date(),
        } as CreationAttributes<EmailDelivery>);
    }
}
