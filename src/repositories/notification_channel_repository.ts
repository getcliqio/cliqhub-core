import { BaseRepository } from './base_repository.js';
import { NotificationChannel } from '../models/index.js';

export class NotificationChannelRepository extends BaseRepository<NotificationChannel> {
    protected readonly model = NotificationChannel;
}
