/**
 * Dashboard API — Zod request schemas (SoT for inbound bodies).
 *
 * Paths (internal plane only):
 *   POST /internal/dashboard/summary
 *   POST /internal/dashboard/realms
 *
 * Envelope: flat (DASH-S0 — no `{ ok, data }` yet).
 * Tenancy: body `org_id` required — never invent from X-Org-Id.
 */

import { z } from 'zod';

/** Shared org invent field for dashboard rollups. */
export const DashboardOrgIdField = z.string().uuid().describe(
    'Organization UUID. Required for dashboard rollups — never invent from X-Org-Id.',
);

/** POST /internal/dashboard/summary */
export const DashboardSummaryInput = z.object({
    org_id: DashboardOrgIdField,
});
export type DashboardSummaryInput = z.infer<typeof DashboardSummaryInput>;

/** POST /internal/dashboard/realms */
export const DashboardRealmsInput = z.object({
    org_id: DashboardOrgIdField,
});
export type DashboardRealmsInput = z.infer<typeof DashboardRealmsInput>;
