import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { DraftsService } from '../services/drafts_service.js';
import { drafts_get_by_id_schema, drafts_new_schema, drafts_update_schema, drafts_delete_schema } from '../schemas/draft_types.js';
import { to_draft_dto, to_draft_list_item_dto } from '../lib/mappers.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('ctrl.drafts');

export class DraftsController extends BaseController {
    constructor(private _drafts_service: DraftsService) {
        super();
    }

    async get(req: Request, res: Response): Promise<void> {
        log.debug('get', { user_id: req.auth?.user?.id });
        const result = await this._drafts_service.get(req.auth);
        const drafts = result.drafts.map(to_draft_list_item_dto);
        this.ok(res, { drafts });
    }

    async get_by_id(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(drafts_get_by_id_schema, req);
        log.debug('get_by_id', { draft_id: body.id, user_id: req.auth?.user?.id });
        const draft = await this._drafts_service.get_by_id(req.auth, body);
        this.ok(res, to_draft_dto(draft));
    }

    async new_draft(req: Request, res: Response): Promise<void> {
        log.debug('new_draft', { user_id: req.auth?.user?.id });
        const body = this.parse_body(drafts_new_schema, req);
        const result = await this._drafts_service.new_draft(req.auth, body);
        log.info('draft_created', { user_id: req.auth?.user?.id });
        this.ok(res, result);
    }

    async update(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(drafts_update_schema, req);
        log.debug('update', { user_id: req.auth?.user?.id });
        const result = await this._drafts_service.update(req.auth, body);
        this.ok(res, result);
    }

    async delete_draft(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(drafts_delete_schema, req);
        log.debug('delete_draft', { user_id: req.auth?.user?.id });
        const result = await this._drafts_service.delete_draft(req.auth, body);
        log.info('draft_deleted', { user_id: req.auth?.user?.id });
        this.ok(res, result);
    }
}
