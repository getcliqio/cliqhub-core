import { ApiError } from '../errors/api_error.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { AuthContext } from '../types/vo.js';
import { assert_admin_access } from '../auth/assert_grant.js';

export class ReportsService {
    constructor(
        private _audit_repo: AuditRepository,
    ) {}

    private _require_admin(auth: AuthContext) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        assert_admin_access(auth, 'reports');
    }

    async audit(auth: AuthContext, params: {
        action?: string; target_type?: string; admin_id?: string;
        limit?: number; offset?: number;
    }) {
        this._require_admin(auth);

        const limit = Math.min(params.limit || 50, 100);
        const offset = params.offset || 0;

        const filters = {
            action: params.action,
            target_type: params.target_type,
            admin_id: params.admin_id,
        };

        const [entries, total] = await Promise.all([
            this._audit_repo.list_paginated(filters, limit, offset),
            this._audit_repo.count_filtered(filters),
        ]);

        return { entries, total, limit, offset };
    }
}
