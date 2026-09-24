import pg from 'pg';

import type { SyncEnvConfig } from '../config/env.js';

type NotifyHandler = (daemon_id: string) => void;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const JITTER_FACTOR = 0.25;

/**
 * Manages a dedicated PG connection for LISTEN/NOTIFY.
 * Used to wake held poll connections when a new command arrives,
 * and to notify waiting relay callers when a response is ready.
 */
export class NotifyService {
    private client: pg.Client | null = null;
    private command_handlers: NotifyHandler[] = [];
    private response_handlers: NotifyHandler[] = [];
    private reconnect_timer: ReturnType<typeof setTimeout> | null = null;
    private reconnect_attempt = 0;
    private _connected = false;

    constructor(private readonly config: SyncEnvConfig) {}

    /** Whether the NOTIFY listener is currently connected. */
    get connected(): boolean {
        return this._connected;
    }

    async connect(): Promise<void> {
        this.client = new pg.Client({
            connectionString: this.config.database_url,
            ssl: this.config.database_url.includes('sslmode=require')
                ? { rejectUnauthorized: false }
                : undefined,
        });

        this.client.on('error', (err) => {
            console.error('[Sync] NOTIFY client error:', err.message);
            this.schedule_reconnect();
        });

        this.client.on('notification', (msg) => {
            if (!msg.payload) return;

            if (msg.channel === this.config.notify_channel) {
                for (const handler of this.command_handlers) {
                    handler(msg.payload);
                }
            }

            if (msg.channel === this.config.response_notify_channel) {
                for (const handler of this.response_handlers) {
                    handler(msg.payload);
                }
            }
        });

        await this.client.connect();
        await this.client.query(`LISTEN ${this.config.notify_channel}`);
        await this.client.query(`LISTEN ${this.config.response_notify_channel}`);
        this._connected = true;
        this.reconnect_attempt = 0;
        console.log('[Sync] NOTIFY listener connected');
    }

    /** Register a handler invoked when a new command is ready for a daemon. */
    on_command_ready(handler: NotifyHandler): void {
        this.command_handlers.push(handler);
    }

    /** Register a handler invoked when a daemon delivers a command response. */
    on_response_ready(handler: NotifyHandler): void {
        this.response_handlers.push(handler);
    }

    async close(): Promise<void> {
        if (this.reconnect_timer) {
            clearTimeout(this.reconnect_timer);
            this.reconnect_timer = null;
        }
        this._connected = false;
        if (this.client) {
            await this.client.end().catch(() => {});
            this.client = null;
        }
    }

    private schedule_reconnect(): void {
        if (this.reconnect_timer) return;

        this._connected = false;
        this.reconnect_attempt++;

        const base_delay = Math.min(
            RECONNECT_BASE_MS * Math.pow(2, this.reconnect_attempt - 1),
            RECONNECT_MAX_MS,
        );
        const jitter = base_delay * JITTER_FACTOR * (Math.random() * 2 - 1);
        const delay = Math.max(0, base_delay + jitter);

        this.reconnect_timer = setTimeout(async () => {
            this.reconnect_timer = null;
            console.log(`[Sync] Reconnecting NOTIFY client (attempt ${this.reconnect_attempt})...`);
            try {
                await this.client?.end().catch(() => {});
                await this.connect();
            } catch (err) {
                console.error('[Sync] NOTIFY reconnect failed:', (err as Error).message);
                this.schedule_reconnect();
            }
        }, delay);
    }
}
