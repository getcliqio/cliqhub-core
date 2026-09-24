import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { DraftsService } from '../services/drafts_service.js';
import { drafts_get_by_id_schema, drafts_new_schema, drafts_update_schema, drafts_delete_schema } from '../schemas/drafts_schemas.js';
import { to_draft_dto, to_draft_list_item_dto } from '../types/mappers.js';

export class DraftsController extends BaseController {
    constructor(private _drafts_service: DraftsService) {
        super();
    }

    get = this.wrap(async (req: Request, res: Response) => {
        const result = await this._drafts_service.get(req.auth);
        const drafts = result.drafts.map(to_draft_list_item_dto);
        this.ok(res, { drafts });
    });

    get_by_id = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(drafts_get_by_id_schema, req);
        const draft = await this._drafts_service.get_by_id(req.auth, body);
        this.ok(res, to_draft_dto(draft));
    });

    new_draft = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(drafts_new_schema, req);
        const result = await this._drafts_service.new_draft(req.auth, body);
        this.ok(res, result);
    });

    update = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(drafts_update_schema, req);
        const result = await this._drafts_service.update(req.auth, body);
        this.ok(res, result);
    });

    delete_draft = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(drafts_delete_schema, req);
        const result = await this._drafts_service.delete_draft(req.auth, body);
        this.ok(res, result);
    });
}
