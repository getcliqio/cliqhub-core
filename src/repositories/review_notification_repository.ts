import { BaseRepository } from './base_repository.js';
import { ReviewNotification } from '../models/index.js';

export class ReviewNotificationRepository extends BaseRepository<ReviewNotification> {
    protected readonly model = ReviewNotification;
}
