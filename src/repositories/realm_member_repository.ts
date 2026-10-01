import { BaseRepository } from './base_repository.js';
import { RealmMember } from '../models/index.js';

export class RealmMemberRepository extends BaseRepository<RealmMember> {
    protected readonly model = RealmMember;
}
