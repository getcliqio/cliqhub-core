import { BaseRepository } from './base_repository.js';
import { RunArtifact } from '../models/index.js';

export class RunArtifactRepository extends BaseRepository<RunArtifact> {
    protected readonly model = RunArtifact;
}
