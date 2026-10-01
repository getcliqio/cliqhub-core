import { BaseRepository } from './base_repository.js';
import { ReviewMessage } from '../models/index.js';

export class ReviewMessageRepository extends BaseRepository<ReviewMessage> {
    protected readonly model = ReviewMessage;
}
