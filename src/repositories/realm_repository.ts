import { BaseRepository } from './base_repository.js';
import { Realm } from '../models/index.js';

export class RealmRepository extends BaseRepository<Realm> {
    protected readonly model = Realm;
}
