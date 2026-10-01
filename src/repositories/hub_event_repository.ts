import { BaseRepository } from './base_repository.js';
import { HubEvent } from '../models/index.js';

export class HubEventRepository extends BaseRepository<HubEvent> {
    protected readonly model = HubEvent;
}
