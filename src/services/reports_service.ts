import { ApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { AuthContext } from '../schemas/auth_types.js';

const log = get_logger('svc.reports');

export class ReportsService {
    constructor(
        private _audit_repo: AuditRepository,
    ) {}

    async audit(auth: AuthContext, params: {
        action?: string; target_type?: string; admin_id?: string;
        target_id?: string; since_ms?: number; until_ms?: number;
        limit?: number; offset?: number;
    }) {
        log.debug('audit', { user_id: auth.user?.id });
        // Route policy: site admin.
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);

        const limit = Math.min(params.limit || 50, 100);
        const offset = params.offset || 0;

        const filters = {
            action: params.action,
            target_type: params.target_type,
            admin_id: params.admin_id,
            target_id: params.target_id,
            since_ms: params.since_ms,
            until_ms: params.until_ms,
        };

        const [entries, total] = await Promise.all([
            this._audit_repo.list_paginated(filters, limit, offset),
            this._audit_repo.count_filtered(filters),
        ]);

        return { entries, total, limit, offset };
    }
}
