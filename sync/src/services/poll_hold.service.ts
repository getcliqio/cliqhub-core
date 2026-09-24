import type pg from 'pg';

import type { SyncEnvConfig } from '../config/env.js';
import type { NotifyService } from './notify.service.js';

export interface Command {
    id: string;
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    delivery_count?: number;
}

interface HeldPoll {
    resolve: (commands: Command[]) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface PendingWaiter {
    resolve: (response: CommandResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export interface CommandResponse {
    status_code: number;
    headers?: Record<string, string>;
    body?: unknown;
}

/**
 * In-memory coordination for held poll connections and pending relay waiters.
 *
 * active_polls: daemons with an open long-poll waiting for commands.
 * pending_waiters: relay callers waiting for a daemon's response to their command.
 */
export class PollHoldService {
    private active_polls = new Map<string, HeldPoll>();
    private pending_waiters = new Map<string, PendingWaiter>();

    constructor(
        private readonly config: SyncEnvConfig,
        private readonly pool: pg.Pool,
        notify_service: NotifyService,
    ) {
        // When a command is inserted on another instance, wake the local poll if held
        notify_service.on_command_ready((daemon_id) => {
            this.wake_poll(daemon_id);
        });

        // When a response arrives on another instance, resolve the local waiter
        notify_service.on_response_ready((command_id) => {
            this.notify_response_available(command_id);
        });
    }

    /**
     * Hold a daemon's poll connection open until commands arrive or timeout.
     * Returns resolved commands or empty array on timeout.
     */
    hold_poll(daemon_id: string, timeout_ms?: number): Promise<Command[]> {
        // If there's already a held poll for this daemon, release the old one
        this.release_poll(daemon_id);

        const poll_timeout = timeout_ms ?? this.config.poll_timeout_ms;

        return new Promise<Command[]>((resolve) => {
            const timer = setTimeout(() => {
                this.active_polls.delete(daemon_id);
                resolve([]);
            }, poll_timeout);

            this.active_polls.set(daemon_id, { resolve, timer });
        });
    }

    /** Wake a held poll with commands (called when commands are queued). */
    wake_poll(daemon_id: string): void {
        // The actual command fetching happens in the poll controller;
        // we just signal the held promise to re-check.
        const held = this.active_polls.get(daemon_id);
        if (!held) return;

        clearTimeout(held.timer);
        this.active_polls.delete(daemon_id);
        // Resolve with empty — controller will re-query commands before responding
        held.resolve([]);
    }

    /** Release a held poll (e.g. on deregister). Resolves with empty. */
    release_poll(daemon_id: string): void {
        const held = this.active_polls.get(daemon_id);
        if (!held) return;

        clearTimeout(held.timer);
        this.active_polls.delete(daemon_id);
        held.resolve([]);
    }

    /** Check if a daemon currently has a held poll on this instance. */
    has_active_poll(daemon_id: string): boolean {
        return this.active_polls.has(daemon_id);
    }

    /**
     * Wait for a daemon to deliver a response to a specific command.
     * Called by the relay endpoint to hold the backend caller's connection.
     */
    wait_for_response(command_id: string): Promise<CommandResponse> {
        return new Promise<CommandResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending_waiters.delete(command_id);
                reject(new Error('Command response timeout'));
            }, this.config.client_timeout_ms);

            this.pending_waiters.set(command_id, { resolve, reject, timer });
        });
    }

    /** Resolve a pending waiter when the daemon delivers a response. */
    resolve_waiter(command_id: string, response: CommandResponse): boolean {
        const waiter = this.pending_waiters.get(command_id);
        if (!waiter) return false;

        clearTimeout(waiter.timer);
        this.pending_waiters.delete(command_id);
        waiter.resolve(response);
        return true;
    }

    /** Reject a pending waiter (e.g. command expired, daemon went offline). */
    reject_waiter(command_id: string, err: Error): void {
        const waiter = this.pending_waiters.get(command_id);
        if (!waiter) return;

        clearTimeout(waiter.timer);
        this.pending_waiters.delete(command_id);
        waiter.reject(err);
    }

    /**
     * Called via NOTIFY when a response was written on another instance.
     * Queries the DB for the response and resolves the local waiter.
     */
    notify_response_available(command_id: string): void {
        const waiter = this.pending_waiters.get(command_id);
        if (!waiter) return;

        void this._resolve_from_db(command_id);
    }

    private async _resolve_from_db(command_id: string): Promise<void> {
        const row = await this.pool.query<{
            status_code: number;
            headers: Record<string, string> | null;
            body: unknown;
        }>(`
            SELECT status_code, headers, body
            FROM cliq.sync_command_responses
            WHERE command_id = $1
        `, [command_id]);

        if (row.rows[0]) {
            this.resolve_waiter(command_id, {
                status_code: row.rows[0].status_code,
                headers: row.rows[0].headers ?? undefined,
                body: row.rows[0].body,
            });
            return;
        }

        // Commit race — response not visible yet. Retry once after 200ms.
        await new Promise((r) => setTimeout(r, 200));

        const retry = await this.pool.query<{
            status_code: number;
            headers: Record<string, string> | null;
            body: unknown;
        }>(`
            SELECT status_code, headers, body
            FROM cliq.sync_command_responses
            WHERE command_id = $1
        `, [command_id]);

        if (retry.rows[0]) {
            this.resolve_waiter(command_id, {
                status_code: retry.rows[0].status_code,
                headers: retry.rows[0].headers ?? undefined,
                body: retry.rows[0].body,
            });
        }
    }

    /**
     * Reject all pending waiters for a daemon's in-flight commands.
     * Called when a daemon goes offline or deregisters.
     */
    async reject_all_for_daemon(daemon_id: string, err: Error): Promise<void> {
        const result = await this.pool.query<{ id: string }>(`
            SELECT id FROM cliq.sync_command_queue
            WHERE daemon_id = $1 AND status IN ('pending', 'delivered')
        `, [daemon_id]);

        for (const row of result.rows) {
            this.reject_waiter(row.id, err);
        }
    }

    /** Reject all pending waiters on this instance. Used during graceful shutdown. */
    reject_all_waiters(err: Error): void {
        for (const [command_id, waiter] of this.pending_waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(err);
        }
        this.pending_waiters.clear();
    }

    /** Release all held polls on this instance. Used during graceful shutdown. */
    release_all_polls(): void {
        for (const [daemon_id, held] of this.active_polls) {
            clearTimeout(held.timer);
            held.resolve([]);
        }
        this.active_polls.clear();
    }

    /** Get count of active polls (for health endpoint). */
    get active_poll_count(): number {
        return this.active_polls.size;
    }

    /** Get count of pending waiters (for health endpoint). */
    get pending_waiter_count(): number {
        return this.pending_waiters.size;
    }
}
