import { BaseRepository } from './base_repository.js';
import { InAppNotification } from '../models/index.js';

export class InAppNotificationRepository extends BaseRepository<InAppNotification> {
    protected readonly model = InAppNotification;
}
