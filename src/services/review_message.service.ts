/**
 * ReviewMessageService — chat messages within a HUG review.
 *
 * Handles storing user and agent messages, enforcing claim-based
 * access control, and pushing user messages to the daemon via the
 * command outbox for agent processing.
 */

import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';

import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { Review } from '../models/review.model.js';
import { ReviewMessage } from '../models/review_message.model.js';
import { get_sequelize } from '../lib/sequelize.js';

const log = get_logger('review_messages');

/** DTO for a single message returned to callers. */
export interface ReviewMessageDto {
    id: string;
    review_id: string;
    role: string;
    text: string;
    sender_id: string | null;
    created_at: string;
}

/** Result of a claim attempt. */
export interface ClaimResult {
    ok: boolean;
    claimed_by: string;
    claimed_by_name?: string;
}

export class ReviewMessageService {

    /**
     * Store a user (human reviewer) message and push it to the daemon.
     *
     * Enforces:
     *   - Review must be pending
     *   - If review is claimed by another user, rejects with 403
     *   - Auto-claims the review on first user message if unclaimed
     */
    static async send_user_message(
        review_id: string,
        user_id: string,
        text: string,
    ): Promise<ReviewMessageDto> {
        const review = await Review.findByPk(review_id);
        if (!review) throw ApiError.not_found('Review not found');
        if (review.status !== 'pending') {
            throw ApiError.conflict(`Cannot send message to ${review.status} review`);
        }

        /** Reject if claimed by someone else. */
        if (review.claimed_by !== null && review.claimed_by !== user_id) {
            throw ApiError.forbidden('Review is claimed by another reviewer');
        }

        /** Auto-claim on first message if unclaimed. */
        if (review.claimed_by === null) {
            const [affected] = await Review.update(
                { claimed_by: user_id, claimed_at: new Date() },
                { where: { id: review_id, claimed_by: null } },
            );
            if (affected === 0) {
                throw ApiError.conflict('Review was just claimed by another reviewer');
            }
        }

        const id = randomUUID();
        const msg = await ReviewMessage.create({
            id,
            review_id,
            role: 'user',
            text,
            sender_id: user_id,
            created_at: new Date(),
        });

        /** Push the message to the daemon via unified HUG inbox. */
        if (review.daemon_id) {
            try {
                const { command_outbox_enqueue } = await import('./command_outbox.service.js');
                await command_outbox_enqueue(review.daemon_id, '/v1/hug/inbox', {
                    review_id,
                    run_id: review.run_id ?? '',
                    type: 'chat',
                    role: 'user',
                    payload: { text, sender_id: user_id },
                });
            } catch (err) {
                log.error('push_message_to_daemon_failed', {
                    review_id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        log.info('user_message_stored', { review_id, user_id, message_id: id });

        return _to_dto(msg);
    }

    /**
     * Store an agent (assistant) message sent from the daemon.
     *
     * Validates that the daemon_id matches the review's daemon.
     */
    static async send_agent_message(
        review_id: string,
        daemon_id: string,
        text: string,
    ): Promise<ReviewMessageDto> {
        const review = await Review.findByPk(review_id);
        if (!review) throw ApiError.not_found('Review not found');
        if (review.daemon_id !== daemon_id) {
            log.warn('agent_message_daemon_mismatch', {
                review_id,
                expected: review.daemon_id,
                received: daemon_id,
            });
            throw ApiError.forbidden('Daemon ID does not match review');
        }
        if (review.status !== 'pending') {
            throw ApiError.conflict(`Cannot send message to ${review.status} review`);
        }

        /** Apply content filters before storing. */
        const filter_result = apply_content_filters(text);
        if (filter_result.blocked) {
            log.warn('agent_message_blocked', {
                review_id,
                daemon_id,
                warnings: filter_result.warnings,
            });
            throw new ApiError(422, 'Message blocked by content filter');
        }

        const filtered_text = filter_result.text;
        if (filter_result.warnings.length > 0) {
            log.info('agent_message_filtered', {
                review_id,
                daemon_id,
                warnings: filter_result.warnings,
            });
        }

        const id = randomUUID();
        const msg = await ReviewMessage.create({
            id,
            review_id,
            role: 'assistant',
            text: filtered_text,
            sender_id: null,
            created_at: new Date(),
        });

        log.info('agent_message_stored', { review_id, daemon_id, message_id: id });

        return _to_dto(msg);
    }

    /**
     * List messages for a review, ordered chronologically.
     *
     * Supports cursor-based pagination via `after_id` — returns only
     * messages created after the message with that ID.
     */
    static async list_messages(
        review_id: string,
        after_id?: string,
    ): Promise<ReviewMessageDto[]> {
        let after_created_at: Date | null = null;

        if (after_id) {
            const cursor_msg = await ReviewMessage.findByPk(after_id, {
                attributes: ['created_at'],
            });
            if (cursor_msg) {
                after_created_at = cursor_msg.created_at;
            }
        }

        const where: Record<string, unknown> = { review_id };
        if (after_created_at) {
            const { Op } = await import('sequelize');
            where['created_at'] = { [Op.gt]: after_created_at };
        }

        const rows = await ReviewMessage.findAll({
            where,
            order: [['created_at', 'ASC']],
            limit: 200,
        });

        return rows.map(_to_dto);
    }

    /**
     * Claim a review for exclusive chat interaction.
     *
     * Uses atomic compare-and-swap: only succeeds if no one has claimed yet.
     * Returns the user_id of whoever holds the claim (self on success,
     * other on conflict).
     */
    static async claim_review(
        review_id: string,
        user_id: string,
    ): Promise<ClaimResult> {
        const review = await Review.findByPk(review_id);
        if (!review) throw ApiError.not_found('Review not found');
        if (review.status !== 'pending') {
            throw ApiError.conflict(`Cannot claim a ${review.status} review`);
        }

        /** Already claimed by this user — idempotent success. */
        if (review.claimed_by === user_id) {
            return { ok: true, claimed_by: user_id };
        }

        /** Already claimed by someone else — return conflict info. */
        if (review.claimed_by !== null) {
            return { ok: false, claimed_by: review.claimed_by };
        }

        /** Atomic CAS — only set if still unclaimed. */
        const sq = get_sequelize();
        const [results] = await sq.query(
            `UPDATE cliq."reviews"
                SET "claimed_by" = $1, "claimed_at" = NOW()
              WHERE "id" = $2
                AND "status" = 'pending'
                AND "claimed_by" IS NULL
              RETURNING "claimed_by"`,
            { bind: [user_id, review_id], type: QueryTypes.SELECT },
        );

        if (!results) {
            /** CAS failed — someone else claimed between our check and update. */
            const fresh = await Review.findByPk(review_id, { attributes: ['claimed_by'] });
            return { ok: false, claimed_by: fresh?.claimed_by ?? '' };
        }

        log.info('review_claimed', { review_id, user_id });
        return { ok: true, claimed_by: user_id };
    }

    /**
     * Release a claim on a review.
     *
     * Only the current claimer (or an admin via separate path) can unclaim.
     */
    static async unclaim_review(
        review_id: string,
        user_id: string,
    ): Promise<{ ok: boolean }> {
        const review = await Review.findByPk(review_id);
        if (!review) throw ApiError.not_found('Review not found');

        if (review.claimed_by === null) {
            return { ok: true };
        }
        if (review.claimed_by !== user_id) {
            throw ApiError.forbidden('Only the current claimer can unclaim');
        }

        await Review.update(
            { claimed_by: null, claimed_at: null },
            { where: { id: review_id, claimed_by: user_id } },
        );

        log.info('review_unclaimed', { review_id, user_id });
        return { ok: true };
    }
}


// ---------------------------------------------------------------------------
// Content filters (guardrails on agent messages)
// ---------------------------------------------------------------------------

/** A single content filter rule. */
export interface ContentFilterRule {
    /** Regex pattern to match against the message text. */
    pattern: string;
    /** Action to take when the pattern matches. */
    action: 'warn' | 'redact' | 'block';
    /** Optional label for logging. */
    label?: string;
    /** Replacement text for 'redact' action. Defaults to '[REDACTED]'. */
    replacement?: string;
}

/** Result of running content filters on a message. */
export interface ContentFilterResult {
    /** Whether the message was blocked (should not be stored). */
    blocked: boolean;
    /** The (possibly redacted) text. */
    text: string;
    /** Warnings generated by matching filters. */
    warnings: Array<{ label: string; pattern: string; action: string }>;
}

/** Default content filter rules — applied to all agent messages. */
const DEFAULT_CONTENT_FILTERS: ContentFilterRule[] = [
    {
        pattern: '(?:sk-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{35}|ghp_[a-zA-Z0-9]{36}|xoxb-[a-zA-Z0-9-]+)',
        action: 'redact',
        label: 'api_key_leak',
        replacement: '[REDACTED_KEY]',
    },
    {
        pattern: '-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----',
        action: 'redact',
        label: 'private_key_leak',
        replacement: '[REDACTED_PRIVATE_KEY]',
    },
    {
        pattern: 'AKIA[A-Z0-9]{16}',
        action: 'redact',
        label: 'aws_access_key_leak',
        replacement: '[REDACTED_AWS_KEY]',
    },
];

/**
 * Apply content filters to a message text.
 *
 * Runs each filter in order. `redact` replaces matches inline.
 * `block` stops processing and returns blocked=true.
 * `warn` logs but allows the message through.
 */
export function apply_content_filters(
    text: string,
    rules?: ContentFilterRule[],
): ContentFilterResult {
    const filters = rules ?? DEFAULT_CONTENT_FILTERS;
    const warnings: ContentFilterResult['warnings'] = [];
    let current_text = text;

    for (const rule of filters) {
        let regex: RegExp;
        try {
            regex = new RegExp(rule.pattern, 'g');
        } catch {
            log.warn('invalid_content_filter_pattern', { pattern: rule.pattern, label: rule.label });
            continue;
        }

        if (!regex.test(current_text)) continue;

        /** Reset regex lastIndex after test. */
        regex.lastIndex = 0;

        const label = rule.label ?? rule.pattern;

        if (rule.action === 'block') {
            warnings.push({ label, pattern: rule.pattern, action: 'block' });
            log.warn('content_filter_blocked', { label, pattern: rule.pattern });
            return { blocked: true, text: current_text, warnings };
        }

        if (rule.action === 'redact') {
            current_text = current_text.replace(regex, rule.replacement ?? '[REDACTED]');
            warnings.push({ label, pattern: rule.pattern, action: 'redact' });
            log.info('content_filter_redacted', { label, pattern: rule.pattern });
            continue;
        }

        /** action === 'warn' — log but don't modify. */
        warnings.push({ label, pattern: rule.pattern, action: 'warn' });
        log.warn('content_filter_warning', { label, pattern: rule.pattern });
    }

    return { blocked: false, text: current_text, warnings };
}


/** Convert a model instance to a plain DTO. */
function _to_dto(msg: import('../models/review_message.model.js').ReviewMessageModel): ReviewMessageDto {
    const raw = msg.get({ plain: true }) as ReviewMessageAttributes;
    return {
        id: raw.id,
        review_id: raw.review_id,
        role: raw.role,
        text: raw.text,
        sender_id: raw.sender_id,
        created_at: raw.created_at instanceof Date
            ? raw.created_at.toISOString()
            : String(raw.created_at),
    };
}

/** Re-export for _to_dto's typed access. */
type ReviewMessageAttributes = import('../models/review_message.model.js').ReviewMessageAttributes;
