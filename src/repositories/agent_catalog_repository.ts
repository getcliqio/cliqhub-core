import { BaseRepository } from './base_repository.js';
import { AgentCatalog } from '../models/index.js';

export class AgentCatalogRepository extends BaseRepository<AgentCatalog> {
    protected readonly model = AgentCatalog;
}
