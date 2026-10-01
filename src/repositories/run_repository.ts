import { BaseRepository } from './base_repository.js';
import { Run } from '../models/index.js';

export class RunRepository extends BaseRepository<Run> {
    protected readonly model = Run;

    async exists_name_in_org(org_id: string, run_name: string): Promise<boolean> {
        const row = await this.model.findOne({ where: { org_id, run_name } });
        return row !== null;
    }
}
