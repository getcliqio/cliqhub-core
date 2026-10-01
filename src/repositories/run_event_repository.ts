import { BaseRepository } from './base_repository.js';
import { RunEvent } from '../models/index.js';

export class RunEventRepository extends BaseRepository<RunEvent> {
    protected readonly model = RunEvent;
}
