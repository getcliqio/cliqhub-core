import { BaseRepository } from './base_repository.js';
import { RunLogLine } from '../models/index.js';

export class RunLogLineRepository extends BaseRepository<RunLogLine> {
    protected readonly model = RunLogLine;
}
