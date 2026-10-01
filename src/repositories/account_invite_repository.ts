import { BaseRepository } from './base_repository.js';
import { AccountInvite } from '../models/index.js';

export class AccountInviteRepository extends BaseRepository<AccountInvite> {
    protected readonly model = AccountInvite;
}
