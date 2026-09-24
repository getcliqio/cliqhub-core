import { ApiError } from '../errors/api_error.js';
import type { DraftRepository } from '../repositories/draft_repository.js';
import type { AuthContext } from '../types/vo.js';

export class DraftsService {
    constructor(private _draft_repo: DraftRepository) {}

    private _require_auth(auth: AuthContext) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    async get(auth: AuthContext) {
        this._require_auth(auth);
        const drafts = await this._draft_repo.list_by_user_id(auth.user!.id);
        return { drafts };
    }

    async get_by_id(auth: AuthContext, params: { id: string }) {
        this._require_auth(auth);
        const draft = await this._draft_repo.find_by_id_and_user(params.id, auth.user!.id);
        if (!draft) throw new ApiError('not_found', 'Draft not found', 404);
        return draft;
    }

    async new_draft(auth: AuthContext, params: { title?: string; team_json: string }) {
        this._require_auth(auth);
        const title = params.title || 'Untitled Team';
        const id = await this._draft_repo.create(auth.user!.id, title, params.team_json);
        return { id };
    }

    async update(auth: AuthContext, params: { id: string; title?: string; team_json: string }) {
        this._require_auth(auth);
        const existing = await this._draft_repo.find_by_id_and_user(params.id, auth.user!.id);
        if (!existing) throw new ApiError('not_found', 'Draft not found', 404);
        await this._draft_repo.update(params.id, params.team_json, params.title);
        return { id: params.id };
    }

    async delete_draft(auth: AuthContext, params: { id: string }) {
        this._require_auth(auth);
        const existing = await this._draft_repo.find_by_id_and_user(params.id, auth.user!.id);
        if (!existing) throw new ApiError('not_found', 'Draft not found', 404);
        await this._draft_repo.delete_by_id(params.id);
        return { deleted: true };
    }
}
