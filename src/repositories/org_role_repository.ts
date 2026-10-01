import { BaseRepository } from './base_repository.js';
import { OrgRole } from '../models/index.js';

export class OrgRoleRepository extends BaseRepository<OrgRole> {
    protected readonly model = OrgRole;
}
