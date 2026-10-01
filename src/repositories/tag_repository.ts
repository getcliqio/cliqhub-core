import { TeamTag } from '../models/index.js';
import { Op, type Transaction } from 'sequelize';
import { BaseRepository } from './base_repository.js';

export class TagRepository extends BaseRepository<TeamTag> {
    protected readonly model = TeamTag;
    async find_by_team_ids(ids: string[]) {
        if (ids.length === 0) return [];
        return TeamTag.findAll({
            where: { team_id: { [Op.in]: ids } },
            attributes: ['team_id', 'tag'],
            raw: true,
        });
    }

    async find_by_team_id(id: string) {
        return TeamTag.findAll({
            where: { team_id: id },
            attributes: ['tag'],
            raw: true,
        });
    }

    async delete_by_team_id(team_id: string, transaction?: Transaction): Promise<void> {
        await TeamTag.destroy({ where: { team_id }, transaction });
    }

    async create(team_id: string, tag: string, transaction?: Transaction): Promise<void> {
        await TeamTag.create({ team_id, tag }, { transaction });
    }
}
