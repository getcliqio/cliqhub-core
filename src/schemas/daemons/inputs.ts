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
