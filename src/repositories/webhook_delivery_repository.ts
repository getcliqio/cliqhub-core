import { BaseRepository } from './base_repository.js';
import { WebhookDelivery } from '../models/index.js';

export class WebhookDeliveryRepository extends BaseRepository<WebhookDelivery> {
    protected readonly model = WebhookDelivery;
}
