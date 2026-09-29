/**
 * Daemons API — Zod request schemas (SoT for inbound bodies).
 *
 * Paths under `/v1/daemons/*`. Envelope: flat (DAE-S0 — no `{ ok, data }` yet).
 *
 * Tenancy: org-scoped `get` requires body `org_id` unless `realm_id`.
 * Never invent org from X-Org-Id.
 */

import { z } from 'zod';

/** POST /v1/daemons/register — daemon enroll/register body (loose optional fields). */
export const DaemonRegisterInput = z.object({
    realm_id: z.string().optional().describe('Requested realm id (must be granted by token)'),
    daemon_id: z.string().optional().describe('Stable daemon id when re-registering'),
    hostname: z.string().optional().describe('Daemon hostname'),
    ip: z.string().optional().describe('Daemon IP'),
    port: z.coerce.number().optional().describe('Daemon listen port'),
    public_url: z.string().optional().describe('Public base URL for the daemon'),
    name: z.string().optional().describe('Display name'),
}).passthrough();
export type DaemonRegisterInput = z.infer<typeof DaemonRegisterInput>;

/** POST /v1/daemons/heartbeat */
export const DaemonHeartbeatInput = z.object({
    daemon_id: z.string().describe('Daemon id reporting liveness'),
    // Legacy fields — heartbeat is pure liveness now.
    teams_hash: z.string().optional().describe('Legacy teams hash (ignored)'),
    teams: z.array(z.unknown()).optional().describe('Legacy teams roster (ignored)'),
});
export type DaemonHeartbeatInput = z.infer<typeof DaemonHeartbeatInput>;

/** POST /v1/daemons/deregister */
export const DaemonDeregisterInput = z.object({
    daemon_id: z.string().describe('Daemon id to deregister'),
});
export type DaemonDeregisterInput = z.infer<typeof DaemonDeregisterInput>;

/** POST /v1/daemons/get — list daemons. */
export const DaemonGetInput = z.object({
    realm_id: z.string().optional().describe('When set, list daemons in this realm (org_id not required)'),
    org_id: z.string().uuid().optional().describe(
        'Organization UUID. Required when listing daemons without realm_id.',
    ),
    status: z.enum(['online', 'stale', 'offline']).optional().describe('Filter by status'),
    query: z.string().optional().describe('Substring match on daemon id / hostname'),
    limit: z.number().int().positive().optional().describe('Page size'),
    offset: z.number().int().nonnegative().optional().describe('Page offset'),
}).superRefine((v, ctx) => {
    if (v.realm_id?.trim()) return;
    if (!v.org_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'org_id is required when listing daemons without realm_id',
            path: ['org_id'],
        });
    }
});
export type DaemonGetInput = z.infer<typeof DaemonGetInput>;

/** POST /v1/daemons/get_by_id */
export const DaemonGetByIdInput = z.object({
    daemon_id: z.string().describe('Daemon id to fetch'),
});
export type DaemonGetByIdInput = z.infer<typeof DaemonGetByIdInput>;

/** POST /v1/daemons/remove */
export const DaemonRemoveInput = z.object({
    daemon_id: z.string().describe('Daemon id to remove'),
});
export type DaemonRemoveInput = z.infer<typeof DaemonRemoveInput>;


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
