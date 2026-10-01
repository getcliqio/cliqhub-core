import { BaseRepository } from './base_repository.js';
import { WorkspaceTeam } from '../models/index.js';

export class WorkspaceTeamRepository extends BaseRepository<WorkspaceTeam> {
    protected readonly model = WorkspaceTeam;
}
