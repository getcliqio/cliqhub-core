import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { ReportsService } from '../services/reports_service.js';
import { reports_audit_schema } from '../schemas/reports_schemas.js';

export class ReportsController extends BaseController {
    constructor(private _reports_service: ReportsService) {
        super();
    }

    audit = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(reports_audit_schema, req);
        const result = await this._reports_service.audit(req.auth, body);
        this.ok(res, result);
    });
}
