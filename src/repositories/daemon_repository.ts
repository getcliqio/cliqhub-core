import { BaseRepository } from './base_repository.js';
import { Daemon } from '../models/index.js';

export class DaemonRepository extends BaseRepository<Daemon> {
    protected readonly model = Daemon;
}
