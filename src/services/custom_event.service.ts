/**
 * Service for custom event discovery — registers `custom.*` event types
 * from manifest declarations and runtime observations, and provides
 * a listing endpoint for the rules UI.
 */

import { Op } from 'sequelize';
import { CustomEvent } from '../models/index.js';
import { get_logger } from '../lib/log.js';
import { ApiError } from '../lib/api_error.js';

const log = get_logger('custom-events');

export interface CustomEventRecord {
    id: string;
    event_type: string;
    source: 'declared' | 'observed';
    realm_id: string | null;
    team_slug: string | null;
    label: string | null;
    created_at: number;
}

export class CustomEventService {

    /**
     * Register event types declared in a team manifest's `events:` array.
     * Upserts so re-installs are idempotent.
     */
    static async register_declared(opts: {
        event_types: string[];
        realm_id: string;
        team_slug: string;
    }): Promise<void> {
        const { event_types, realm_id, team_slug } = opts;
        const now = Date.now();

        for (const event_type of event_types) {
            if (!event_type.startsWith('custom.')) continue;

            const existing = await CustomEvent.findOne({
                where: { event_type, realm_id, team_slug },
            });

            if (existing) {
                if (existing.source !== 'declared') {
                    await existing.update({ source: 'declared' });
                }
                continue;
            }

            try {
                await CustomEvent.create({
                    event_type,
                    source: 'declared',
                    realm_id,
                    team_slug,
                    label: null,
                    created_at: now,
                });
            } catch (err: unknown) {
                if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') continue;
                log.warn(`Failed to register declared event '${event_type}': ${String(err)}`);
            }
        }
    }

    /**
     * Register an event type observed at runtime (first emission).
     * No-op if the event is already known for this realm/team combination.
     */
    static async register_observed(opts: {
        event_type: string;
        realm_id?: string | null;
        team_slug?: string | null;
    }): Promise<void> {
        const { event_type, realm_id = null, team_slug = null } = opts;
        if (!event_type.startsWith('custom.')) return;

        const existing = await CustomEvent.findOne({
            where: { event_type, realm_id: realm_id ?? null, team_slug: team_slug ?? null },
        });
        if (existing) return;

        try {
            await CustomEvent.create({
                event_type,
                source: 'observed',
                realm_id: realm_id ?? null,
                team_slug: team_slug ?? null,
                label: null,
                created_at: Date.now(),
            });
        } catch (err: unknown) {
            if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') return;
            log.warn(`Failed to register observed event '${event_type}': ${String(err)}`);
        }
    }

    /**
     * List all known custom events, optionally filtered by realm and/or team.
     */
    static async list(opts?: {
        realm_id?: string | null;
        team_slug?: string | null;
    }): Promise<CustomEventRecord[]> {
        const where: Record<string, unknown> = {};

        if (opts?.realm_id) {
            where.realm_id = { [Op.in]: [opts.realm_id, null] };
        }
        if (opts?.team_slug) {
            where.team_slug = opts.team_slug;
        }

        const rows = await CustomEvent.findAll({
            where,
            order: [['event_type', 'ASC']],
        });

        return rows.map((r) => ({
            id: r.id!,
            event_type: r.event_type,
            source: r.source,
            realm_id: r.realm_id,
            team_slug: r.team_slug,
            label: r.label,
            created_at: r.created_at,
        }));
    }

    /**
     * Remove declared events for a team — called on uninstall.
     * Only removes `declared` entries; `observed` entries are retained.
     */
    static async remove_declared_for_team(opts: {
        realm_id: string;
        team_slug: string;
    }): Promise<void> {
        await CustomEvent.destroy({
            where: {
                source: 'declared',
                realm_id: opts.realm_id,
                team_slug: opts.team_slug,
            },
        });
    }

    /** Get a single custom event by ID. */
    static async get(id: string): Promise<CustomEventRecord | null> {
        const row = await CustomEvent.findByPk(id);
        if (!row) return null;
        return {
            id: row.id!,
            event_type: row.event_type,
            source: row.source,
            realm_id: row.realm_id,
            team_slug: row.team_slug,
            label: row.label,
            created_at: row.created_at,
        };
    }

    /**
     * Manually create a custom event type from the UI.
     * Enforces uniqueness of the fully-qualified event_type within the realm.
     */
    static async create_manual(opts: {
        event_type: string;
        realm_id: string;
        label: string | null;
    }): Promise<CustomEventRecord> {
        const { event_type, realm_id, label } = opts;

        if (!event_type.startsWith('custom.')) {
            throw ApiError.bad_request('Event type must start with "custom."');
        }

        const existing = await CustomEvent.findOne({
            where: { event_type, realm_id },
        });
        if (existing) {
            throw ApiError.conflict(
                `Event '${event_type}' already exists in this realm.`,
            );
        }

        const row = await CustomEvent.create({
            event_type,
            source: 'declared',
            realm_id,
            team_slug: null,
            label,
            created_at: Date.now(),
        });

        return {
            id: row.id!,
            event_type: row.event_type,
            source: row.source,
            realm_id: row.realm_id,
            team_slug: row.team_slug,
            label: row.label,
            created_at: row.created_at,
        };
    }

    /** Remove a custom event by ID. */
    static async remove(id: string): Promise<void> {
        const row = await CustomEvent.findByPk(id);
        if (!row) throw ApiError.not_found('Custom event not found');
        await row.destroy();
    }
}
