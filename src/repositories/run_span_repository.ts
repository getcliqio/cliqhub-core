import { BaseRepository } from './base_repository.js';
import { RunSpan } from '../models/index.js';

export class RunSpanRepository extends BaseRepository<RunSpan> {
    protected readonly model = RunSpan;
}
