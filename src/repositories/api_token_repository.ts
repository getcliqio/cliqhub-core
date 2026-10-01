import { BaseRepository } from './base_repository.js';
import { ApiToken } from '../models/index.js';

export class ApiTokenRepository extends BaseRepository<ApiToken> {
    protected readonly model = ApiToken;
}
