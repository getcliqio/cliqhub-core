import { Draft } from '../db/models/index.js';
import { fn } from 'sequelize';
import type { DraftVO, DraftListItemVO } from '../types/vo.js';

// Coerce a possibly-Date Sequelize column into the ISO-string form expected
// by the VO contracts. Same shape as user_repository's helper; kept private
// to each repo to avoid leaky cross-imports.
function required_date_to_iso(value: Date | string): string {
    if (value instanceof Date) {
        return value.toISOString();
    }
    return value;
}

interface RawDraftRow {
    id: string;
    user_id: string;
    title: string;
    team_json: string;
    created_at: Date | string;
    updated_at: Date | string;
}

interface RawDraftListRow {
    id: string;
    title: string;
    updated_at: Date | string;
}

export class DraftRepository {
    async list_by_user_id(user_id: string): Promise<DraftListItemVO[]> {
        const rows = await Draft.findAll({
            where: { user_id },
            attributes: ['id', 'title', 'updated_at'],
            order: [['updated_at', 'DESC']],
            raw: true,
        }) as unknown as RawDraftListRow[];
        return rows.map(r => ({
            id: r.id,
            title: r.title,
            updated_at: required_date_to_iso(r.updated_at),
        }));
    }

    async find_by_id_and_user(id: string, user_id: string): Promise<DraftVO | null> {
        const row = await Draft.findOne({
            where: { id, user_id },
            raw: true,
        }) as unknown as RawDraftRow | null;
        if (!row) {
            return null;
        }
        return {
            id: row.id,
            user_id: row.user_id,
            title: row.title,
            team_json: row.team_json,
            created_at: required_date_to_iso(row.created_at),
            updated_at: required_date_to_iso(row.updated_at),
        };
    }

    async create(user_id: string, title: string, team_json: string): Promise<string> {
        const row = await Draft.create({ user_id, title, team_json });
        return row.id;
    }

    async update(id: string, team_json: string, title?: string): Promise<void> {
        const fields: Record<string, unknown> = { team_json, updated_at: fn('NOW') };
        if (title !== undefined) fields.title = title;
        await Draft.update(fields, { where: { id } });
    }

    async delete_by_id(id: string): Promise<void> {
        await Draft.destroy({ where: { id } });
    }

    async count_by_user_id(user_id: string): Promise<number> {
        return Draft.count({ where: { user_id } });
    }

    async count_total(): Promise<number> {
        return Draft.count();
    }
}
