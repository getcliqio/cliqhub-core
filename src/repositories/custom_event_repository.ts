import { BaseRepository } from './base_repository.js';
import { CustomEvent } from '../models/index.js';

export class CustomEventRepository extends BaseRepository<CustomEvent> {
    protected readonly model = CustomEvent;
}
