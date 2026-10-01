import { BaseRepository } from './base_repository.js';
import { DaemonConfig } from '../models/index.js';

export class DaemonConfigRepository extends BaseRepository<DaemonConfig> {
    protected readonly model = DaemonConfig;
}
