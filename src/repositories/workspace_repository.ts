import type { Attributes, FindOptions } from 'sequelize';
import { BaseRepository } from './base_repository.js';
import { Workspace } from '../models/index.js';

/**
 * Workspaces. The inherited reads see registered workspaces only (the model's
 * default scope); the `_any` reads also see deleted ones — for revival on
 * re-register and for the runs that reference them.
 */
export class WorkspaceRepository extends BaseRepository<Workspace> {
    protected readonly model = Workspace;

    /** A workspace by id, deleted or not. */
    async find_by_id_any(id: string): Promise<Workspace | null> {
        return Workspace.unscoped().findByPk(id);
    }

    /** One workspace matching `options`, deleted or not. */
    async find_one_any(options?: FindOptions<Attributes<Workspace>>): Promise<Workspace | null> {
        return Workspace.unscoped().findOne(options);
    }
}
