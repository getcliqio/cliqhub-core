import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { TeamVersionSubTeam } from '../models/index.js';
import { BaseRepository } from './base_repository.js';

/** One sub-team call of a version, as written at publish (PLAN-team-bundle S8). */
export interface SubTeamRow {
    version_id: string;
    position: number;
    phase: string;
    ref: string;
    team_id: string | null;
    pinned_version_id: string | null;
    may_call: boolean;
}

/** `cliq.team_version_sub_teams`: which teams each published version calls. */
export class TeamVersionSubTeamRepository extends BaseRepository<TeamVersionSubTeam> {
    protected readonly model = TeamVersionSubTeam;

    /** A version's sub-team calls, in team.yml order. */
    async list_by_version(version_id: string): Promise<SubTeamRow[]> {
        return this.list_by_versions([version_id]);
    }

    /** Several versions' sub-team calls (for walking a tree). */
    async list_by_versions(version_ids: string[]): Promise<SubTeamRow[]> {
        if (version_ids.length === 0) return [];
        const rows = await TeamVersionSubTeam.findAll({
            where: { version_id: { [Op.in]: version_ids } },
            attributes: ['version_id', 'position', 'phase', 'ref', 'team_id', 'pinned_version_id', 'may_call'],
            order: [['version_id', 'ASC'], ['position', 'ASC']],
            raw: true,
        });
        return rows as unknown as SubTeamRow[];
    }

    /** Record a version's calls (at publish). */
    async create_many(rows: SubTeamRow[], transaction: Transaction): Promise<void> {
        if (rows.length > 0) await TeamVersionSubTeam.bulkCreate(rows as never[], { transaction });
    }
}
