/**
 * The Email channel: renders and sends notification email through the
 * process's {@link EmailSender} (Brevo when configured, otherwise the no-op
 * sender, set at boot by the container).
 *
 *   - {@link EmailDeliverer.deliver_message} sends one org-event email
 *     (invites, org lifecycle, account emails) to one resolved recipient,
 *     records the attempt in `email_deliveries` and reports `sent`, which
 *     the org event's `email_sent` is built from.
 *   - {@link EmailDeliverer.deliver} sends any event to a channel's fixed
 *     addresses (`to` / `cc` / `bcc` in the destination config).
 *
 * Send failures are reported, never thrown, by `deliver_message`. Links,
 * bodies, full recipient addresses and the provider key are never logged.
 */

import { AbstractChannelDeliverer } from './abstract_channel_deliverer.js';
import type { NotificationPayload } from '../types.js';
import type { EmailSubjectType } from '../../models/email_delivery.model.js';
import type { DeliveryLinks, EventActor, OrgEventData, OrgEventType } from '../org_events.js';
import type { ResolvedRecipient } from '../recipients.js';
import { get_logger } from '../../lib/log.js';
import { public_app_url } from '../../config/env.js';
import { NotificationChannel, Org, User } from '../../models/index.js';
import { EmailDeliveryRepository } from '../../repositories/email_delivery_repository.js';
import { EmailSendError, mask_email, type EmailAddress, type EmailSender } from '../../lib/email/email_sender.js';
import { NoopEmailSender } from '../../lib/email/noop_email_sender.js';
import { render_channel_email, render_event_email, type EventEmailContext } from '../../lib/email/event_emails.js';
import { email_images_in } from '../../lib/email/layout.js';

const log = get_logger('notify.email');

/**
 * One email for one recipient of an org event, as the fan-out hands it to the
 * Email channel. `links` is set only for the person the link belongs to (the
 * invitee, or the user of a password link); it must never be logged or stored.
 */
export interface EmailMessageInput {
	event: OrgEventType;
	/** `events.id`. */
	event_id: string;
	org_id: string;
	realm_id: string | null;
	channel_id: string;
	occurred_at: string;
	actor: EventActor;
	data: OrgEventData;
	links: DeliveryLinks;
	to: ResolvedRecipient;
	/** What `email_deliveries` records the send against. */
	subject: { type: EmailSubjectType; id: string };
	/** The channel's email destination config (e.g. `{ provider: 'brevo' }`). */
	destination: Record<string, unknown>;
}

/** Outcome of one send. */
export interface EmailSendResult {
	sent: boolean;
	provider_message_id: string | null;
	/** Short reason when not sent; never contains a key, link or body. */
	error: string | null;
}

/** Splits a comma / semicolon separated address list. */
function addresses(value: unknown): EmailAddress[] {
	if (typeof value !== 'string') return [];
	return value.split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((email) => ({ email }));
}

/**
 * A short failure reason for a send error (no key, link, body or address):
 * an {@link EmailSendError} message is built from the provider's status and
 * code only; other errors are this service's own (configuration, database).
 */
function failure_reason(err: unknown): string {
	if (err instanceof EmailSendError) return err.kind === 'not_configured' ? err.message : `${err.kind}: ${err.message}`;
	return err instanceof Error ? err.message : String(err);
}

/** Sends email for notification channels and org events. */
export class EmailDeliverer extends AbstractChannelDeliverer {
	readonly provider = 'email';
	private _sender: EmailSender = new NoopEmailSender();

	/** @param _deliveries - Where send attempts are recorded. */
	constructor(private readonly _deliveries: EmailDeliveryRepository = new EmailDeliveryRepository()) {
		super();
	}

	/**
	 * Sets the transport every later send uses (the container calls it at boot).
	 *
	 * @param sender - Brevo or the no-op sender.
	 */
	use_sender(sender: EmailSender): void {
		this._sender = sender;
	}

	/**
	 * Sends an event to a channel's fixed addresses. Without a configured
	 * transport it sends nothing and returns.
	 *
	 * @param config - `{ to, cc?, bcc? }` from the email destination.
	 * @param payload - The notification payload.
	 * @throws Error when the transport refuses or fails to send.
	 */
	async deliver(
		config: Record<string, unknown>,
		payload: NotificationPayload,
	): Promise<void> {
		const to = addresses(config.to);
		if (to.length === 0) {
			log.warn('email_destination_without_to', { event: payload.event });
			return;
		}
		if (!this._sender.configured) {
			log.debug('email_not_sent', { event: payload.event, reason: 'email sending is not configured' });
			return;
		}
		const rendered = render_channel_email(payload, public_app_url());
		try {
			await this._sender.send({
				to, cc: addresses(config.cc), bcc: addresses(config.bcc),
				subject: rendered.subject, html: rendered.html, text: rendered.text, tags: [payload.event],
				images: email_images_in(rendered.html),
			});
		} catch (err) {
			throw new Error(`email delivery failed: ${failure_reason(err)}`);
		}
	}

	/**
	 * Renders, sends and records one org-event email to one recipient.
	 *
	 * @param input - The event, recipient, links and delivery-log subject.
	 * @returns Whether the email was sent, with the provider message id or the reason;
	 *   never throws for a rendering, sending or recording failure.
	 */
	async deliver_message(input: EmailMessageInput): Promise<EmailSendResult> {
		let result: EmailSendResult;
		try {
			const ctx = await this._context(input);
			const rendered = render_event_email(
				{ event: input.event, data: input.data, occurred_at: input.occurred_at, links: input.links },
				ctx,
			);
			const to: EmailAddress = input.to.display_name ? { email: input.to.email, name: input.to.display_name } : { email: input.to.email };
			const sent = await this._sender.send({ to: [to], subject: rendered.subject, html: rendered.html, text: rendered.text, tags: [input.event], images: email_images_in(rendered.html) });
			result = { sent: true, provider_message_id: sent.message_id, error: null };
		} catch (err) {
			result = { sent: false, provider_message_id: null, error: failure_reason(err) };
		}

		try {
			await this._deliveries.record({
				subject_type: input.subject.type,
				subject_id: input.subject.id,
				event: input.event,
				event_id: input.event_id,
				org_id: input.org_id,
				channel_id: input.channel_id,
				to: input.to.email,
				ok: result.sent,
				provider_message_id: result.provider_message_id,
				error: result.error,
			});
		} catch (err) {
			log.error('email_delivery_record_failed', { event: input.event, event_id: input.event_id, error: err instanceof Error ? err.message : String(err) });
		}

		const line = {
			event: input.event, event_id: input.event_id, channel_id: input.channel_id,
			to: mask_email(input.to.email), provider: this._sender.name, sent: result.sent,
		};
		if (result.sent) log.info('org_email_sent', line);
		else log.warn('org_email_not_sent', { ...line, reason: result.error });
		return result;
	}

	/** App URL plus the names the templates show (org, actor, channel). */
	private async _context(input: EmailMessageInput): Promise<EventEmailContext> {
		const app_url = public_app_url();
		const actor_id = 'user_id' in input.actor ? input.actor.user_id : null;
		const [org, actor, channel] = await Promise.all([
			Org.findByPk(input.org_id, { attributes: ['id', 'display_name', 'status'], raw: true }),
			actor_id ? User.findByPk(actor_id, { attributes: ['id', 'display_name', 'username'], raw: true }) : null,
			NotificationChannel.findByPk(input.channel_id, { attributes: ['id', 'name'], raw: true }),
		]);
		return {
			app_url,
			org_id: input.org_id,
			org_display_name: org?.display_name ?? null,
			org_awaiting_owner: org?.status === 'waiting_for_owner',
			actor_name: actor ? (actor.display_name || actor.username || null) : null,
			channel_name: channel?.name ?? null,
		};
	}
}
