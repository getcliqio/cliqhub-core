import { BaseRepository } from './base_repository.js';
import { NotificationRule } from '../models/index.js';

export class NotificationRuleRepository extends BaseRepository<NotificationRule> {
    protected readonly model = NotificationRule;
}
