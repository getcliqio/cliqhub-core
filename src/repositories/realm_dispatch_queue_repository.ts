import { BaseRepository } from './base_repository.js';
import { RealmDispatchQueue } from '../models/index.js';

export class RealmDispatchQueueRepository extends BaseRepository<RealmDispatchQueue> {
    protected readonly model = RealmDispatchQueue;
}
