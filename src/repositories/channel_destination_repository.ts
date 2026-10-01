import { BaseRepository } from './base_repository.js';
import { ChannelDestination } from '../models/index.js';

export class ChannelDestinationRepository extends BaseRepository<ChannelDestination> {
    protected readonly model = ChannelDestination;
}
