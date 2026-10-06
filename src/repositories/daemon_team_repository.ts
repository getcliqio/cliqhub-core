import type { Attributes, FindOptions } from 'sequelize';
import { BaseRepository } from './base_repository.js';
import { DaemonTeam } from '../models/index.js';

/**
 * Daemon team slots. The inherited reads see installed teams only (the model's
 * default scope); the `_any` reads also see uninstalled ones — for a run's
 * team (label, manifest), reactivation and sync.
 */
export class DaemonTeamRepository extends BaseRepository<DaemonTeam> {
    protected readonly model = DaemonTeam;

    /** A slot by id, installed or not. */
    async find_by_id_any(id: string, options?: Omit<FindOptions<Attributes<DaemonTeam>>, 'where'>): Promise<DaemonTeam | null> {
        return DaemonTeam.unscoped().findByPk(id, options);
    }

    /** Slots matching `options`, installed or not. */
    async find_all_any(options?: FindOptions<Attributes<DaemonTeam>>): Promise<DaemonTeam[]> {
        return DaemonTeam.unscoped().findAll(options);
    }

    /** One slot matching `options`, installed or not. */
    async find_one_any(options?: FindOptions<Attributes<DaemonTeam>>): Promise<DaemonTeam | null> {
        return DaemonTeam.unscoped().findOne(options);
    }
}
