import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { TeamFile } from '../models/index.js';
import { BaseRepository } from './base_repository.js';

/** One file row as written (PLAN-team-bundle §2.2). */
export interface TeamFileRow {
    id: string;
    team_id: string;
    version_id: string;
    path: string;
    name: string;
    size: number;
    sha256: string;
    content_type: string;
    storage_key: string;
}

/** `cliq.team_files`: which files a version (draft or published) has, and where their bytes are. */
export class TeamFileRepository extends BaseRepository<TeamFile> {
    protected readonly model = TeamFile;

    /** A version's files, by path. */
    async list_by_version(version_id: string): Promise<TeamFileRow[]> {
        const rows = await TeamFile.findAll({
            where: { version_id },
            attributes: ['id', 'team_id', 'version_id', 'path', 'name', 'size', 'sha256', 'content_type', 'storage_key'],
            order: [['path', 'ASC']],
            raw: true,
        });
        return rows as unknown as TeamFileRow[];
    }

    /** Put these rows in the version, replacing any it has at the same paths. */
    async replace_paths(version_id: string, rows: TeamFileRow[], transaction: Transaction): Promise<void> {
        await TeamFile.destroy({ where: { version_id, path: { [Op.in]: rows.map((r) => r.path) } }, transaction });
        await TeamFile.bulkCreate(rows as never[], { transaction });
    }

    /** Take these paths out of the version; returns how many were there. */
    async delete_paths(version_id: string, paths: string[], transaction?: Transaction): Promise<number> {
        return TeamFile.destroy({ where: { version_id, path: { [Op.in]: paths } }, transaction });
    }
}
