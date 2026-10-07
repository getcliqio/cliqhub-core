/**
 * Run history — the lifecycle of one run as people see it: started, resumed
 * (and by whom), failed, completed … read from the Hub event log
 * (`cliq.events`, `HubEvent`) and returned by `runs/get_by_id` with
 * `with_history: true`.
 *
 * Resume keeps the run_id, so a run that failed and was resumed has one row
 * but several attempts; this is where the attempts come from. Core records
 * who asked for a resume (`run.resume_requested`, `actor_id`); the daemon
 * later reports `run.resumed` when it actually restarts.
 */
import { Op } from 'sequelize';
import { HubEvent, Run, User } from '../models/index.js';
import { EventSubmitService } from './events_service.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.run_history');

/** Event types that make up a run's history, oldest first. */
export const RUN_HISTORY_TYPES = ['run.started', 'run.resume_requested', 'run.resumed', 'run.completed', 'run.failed', 'run.crashed', 'run.cancelled'] as const;

/** One history entry on the wire. */
export interface RunHistoryEntry {
    type: (typeof RUN_HISTORY_TYPES)[number];
    /** Unix ms. */
    at: number;
    /** The phase the run resumed from (resume entries). */
    from_phase: string | null;
    /** The phase current at the time (e.g. where it failed). */
    phase: string | null;
    error: string | null;
    /** Who did it, when a person did (resume requests). */
    actor: { id: string; username: string | null; display_name: string | null } | null;
}

/** Cap per run: history is for people, not an audit export. */
const MAX_ENTRIES = 200;

export class RunHistoryService {
    /**
     * Record that a person asked to resume a run from a phase (best effort; never fails the resume).
     * Skipped for a run with no realm or daemon — the event catalog requires both for run.*.
     */
    static async record_resume_request(run_id: string, from_phase: string, actor_id: string | null | undefined): Promise<void> {
        try {
            const row = await Run.findByPk(run_id, { attributes: ['run_id', 'realm_id', 'daemon_id', 'run_name', 'team_id'], raw: true }) as unknown as
                { run_id: string; realm_id: string | null; daemon_id: string | null; run_name: string | null; team_id: string | null } | null;
            if (!row?.realm_id || !row.daemon_id) return;
            await EventSubmitService.submit({
                type: 'run.resume_requested',
                realm_id: row.realm_id,
                run_id: row.run_id,
                daemon_id: row.daemon_id,
                phase: from_phase,
                payload: { run_name: row.run_name, team_id: row.team_id, from_phase },
                actor_id: actor_id ?? null,
            });
        } catch (err) {
            log.warn('resume_request_event_failed', { run_id, error: (err as Error).message });
        }
    }

    /** The run's history, oldest first, with the people behind resume requests. */
    static async history(run_id: string): Promise<RunHistoryEntry[]> {
        const rows = await HubEvent.findAll({
            where: { run_id, type: { [Op.in]: [...RUN_HISTORY_TYPES] } },
            attributes: ['type', 'created_at', 'payload_json', 'actor_id'],
            order: [['created_at', 'ASC']],
            limit: MAX_ENTRIES,
            raw: true,
        }) as unknown as Array<{ type: RunHistoryEntry['type']; created_at: number | string; payload_json: string | null; actor_id: string | null }>;

        const actor_ids = [...new Set(rows.map((r) => r.actor_id).filter((x): x is string => Boolean(x)))];
        const users = actor_ids.length
            ? await User.findAll({ where: { id: { [Op.in]: actor_ids } }, attributes: ['id', 'username', 'display_name'], raw: true }) as unknown as
                Array<{ id: string; username: string | null; display_name: string | null }>
            : [];
        const by_id = new Map(users.map((u) => [String(u.id), u]));

        return rows.map((r) => {
            let payload: Record<string, unknown> = {};
            try { payload = r.payload_json ? JSON.parse(r.payload_json) as Record<string, unknown> : {}; } catch { /* a bad payload still has a type and time */ }
            const user = r.actor_id ? by_id.get(String(r.actor_id)) : undefined;
            const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
            return {
                type: r.type,
                at: Number(r.created_at),
                from_phase: str(payload.from_phase),
                phase: str(payload.phase),
                error: str(payload.error),
                actor: r.actor_id ? { id: String(r.actor_id), username: user?.username ?? null, display_name: user?.display_name ?? null } : null,
            };
        });
    }
}
