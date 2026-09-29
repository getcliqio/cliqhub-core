import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { ReportsService } from '../services/reports_service.js';
import { reports_audit_schema } from '../schemas/report_types.js';

export class ReportsController extends BaseController {
    constructor(private _reports_service: ReportsService) {
        super();
    }

    async audit(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(reports_audit_schema, req);
        const result = await this._reports_service.audit(req.auth, body);
        this.ok(res, result);
    }
}
