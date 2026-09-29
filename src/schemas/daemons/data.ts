import { z } from 'zod';

/**
 * Canonical wire shape for a daemon (cliqd instance).
 * Replaces DaemonFields = Record<string, unknown> in daemons_controller.
 * Timestamps are milliseconds since epoch (matching daemon.model.ts).
 */
export const DaemonRealmInfo = z.object({
    id: z.string()
        .describe('Realm UUID'),
    slug: z.string()
        .describe('Realm slug'),
    name: z.string()
        .describe('Realm display name'),
    role: z.string()
        .describe('Daemon\'s role in this realm (e.g. "member", "admin")'),
});

export const DaemonData = z.object({
    id: z.string()
        .describe('Daemon identifier (opaque string, not UUID)'),
    name: z.string().nullable()
        .describe('Human-assigned name; null when not set'),
    user_id: z.string().nullable()
        .describe('UUID of the user who registered this daemon; null for unclaimed'),
    user_email: z.string().nullable()
        .describe('Email of the registering user; null for unclaimed'),
    hostname: z.string().nullable()
        .describe('Machine hostname; null when not reported'),
    ip: z.string().nullable()
        .describe('Last-known IP address'),
    port: z.number().int().nullable()
        .describe('Listening port; null when not reported'),
    public_url: z.string().nullable()
        .describe('Computed public base URL; null when unreachable'),
    status: z.enum(['online', 'stale', 'offline', 'removed'])
        .describe('Last-known connection status'),
    last_heartbeat: z.number().nullable()
        .describe('Epoch ms of last heartbeat; null when never received'),
    capacity: z.number().int()
        .describe('Maximum concurrent runs'),
    created_at: z.number()
        .describe('Epoch ms of registration'),
    last_registered_at: z.number()
        .describe('Epoch ms of most recent re-registration'),
    permissions: z.record(z.unknown())
        .describe('Daemon permission grants bag'),
    realms: z.array(DaemonRealmInfo)
        .describe('Realms this daemon belongs to'),
});

export type DaemonRealmInfo = z.infer<typeof DaemonRealmInfo>;
export type DaemonData = z.infer<typeof DaemonData>;
