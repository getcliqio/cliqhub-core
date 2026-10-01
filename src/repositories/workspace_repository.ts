import { BaseRepository } from './base_repository.js';
import { Workspace } from '../models/index.js';

export class WorkspaceRepository extends BaseRepository<Workspace> {
    protected readonly model = Workspace;
}
