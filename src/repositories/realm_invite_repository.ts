import { BaseRepository } from './base_repository.js';
import { RealmInvite } from '../models/index.js';

export class RealmInviteRepository extends BaseRepository<RealmInvite> {
    protected readonly model = RealmInvite;
}
