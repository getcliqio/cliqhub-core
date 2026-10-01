import { BaseRepository } from './base_repository.js';
import { AccountMeshSetting } from '../models/index.js';

export class AccountMeshSettingRepository extends BaseRepository<AccountMeshSetting> {
    protected readonly model = AccountMeshSetting;
}
