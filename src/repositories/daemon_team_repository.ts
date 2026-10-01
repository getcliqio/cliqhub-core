import { BaseRepository } from './base_repository.js';
import { DaemonTeam } from '../models/index.js';

export class DaemonTeamRepository extends BaseRepository<DaemonTeam> {
    protected readonly model = DaemonTeam;
}
