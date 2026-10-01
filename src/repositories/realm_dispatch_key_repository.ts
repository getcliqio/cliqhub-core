import { BaseRepository } from './base_repository.js';
import { RealmDispatchKey } from '../models/index.js';

export class RealmDispatchKeyRepository extends BaseRepository<RealmDispatchKey> {
    protected readonly model = RealmDispatchKey;
}
