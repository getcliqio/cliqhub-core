import { BaseRepository } from './base_repository.js';
import { OrgAgentSetting } from '../models/index.js';

export class OrgAgentSettingRepository extends BaseRepository<OrgAgentSetting> {
    protected readonly model = OrgAgentSetting;
}
