import { BaseRepository } from './base_repository.js';
import { RunPhase } from '../models/index.js';

export class RunPhaseRepository extends BaseRepository<RunPhase> {
    protected readonly model = RunPhase;
}
