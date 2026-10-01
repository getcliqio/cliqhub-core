import { BaseRepository } from './base_repository.js';
import { Review } from '../models/index.js';

export class ReviewRepository extends BaseRepository<Review> {
    protected readonly model = Review;
}
