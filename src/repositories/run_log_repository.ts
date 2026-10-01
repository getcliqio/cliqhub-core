import { BaseRepository } from './base_repository.js';
import { RunLog } from '../models/index.js';

export class RunLogRepository extends BaseRepository<RunLog> {
    protected readonly model = RunLog;
}
