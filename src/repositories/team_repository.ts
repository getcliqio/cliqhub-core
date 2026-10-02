import { Team, User } from '../models/index.js';
import { fn, literal, Op, type OrderItem, type Transaction, type WhereOptions } from 'sequelize';
import { BaseRepository } from './base_repository.js';

// "Latest" = highest semver, NOT most recently published. Splits the
// version on '.', casts to int[], and orders natural-numerically so
// `1.10.0 > 1.9.0` (a plain lexicographic sort or `MAX(published_at)`
// would flip that). Strips any `-prerelease` suffix before splitting;
// prefers stable over prerelease at numeric ties. See lib/semver.ts
// for the TS-side equivalent used by the repositories/services layer.
const LATEST_VERSION_SUBQUERY = `(
    SELECT version FROM team_versions
    WHERE team_id = "Team"."id"
    ORDER BY
        string_to_array(regexp_replace(version, '-.*$', ''), '.')::int[] DESC,
        CASE WHEN version LIKE '%-%' THEN 0 ELSE 1 END DESC
    LIMIT 1
)`;

export class TeamRepository extends BaseRepository<Team> {
    protected readonly model = Team;
    async find_by_name_and_scope(name: string, scope: string | null) {
        const where: any = { name };
        if (scope) { where.scope = scope; }
        else { where.scope = null; }
        return Team.findOne({ where, raw: true });
    }

    /** Catalog page; `order` defaults to most installed first. */
    async list_filtered(where: WhereOptions, limit: number, offset: number, order: OrderItem[] = [['install_count', 'DESC'], ['id', 'ASC']]) {
        const rows = await Team.findAll({
            attributes: [
                'id', 'name', 'scope', 'description', 'install_count', 'visibility', 'listed',
                [literal(LATEST_VERSION_SUBQUERY), 'latest_version'],
            ],
            include: [{ model: User, as: 'author', attributes: ['username'] }],
            where,
            order,
            limit,
            offset,
            raw: true,
            nest: true,
        });
        return rows.map((r: any) => ({ ...r, author: r.author?.username ?? null }));
    }

    /**
     * Site-admin catalog listing: every team (no visibility filter applied
     * here), most recently updated first unless `order` says otherwise, with
     * the author's username, latest version and number of published versions.
     */
    async list_admin(where: WhereOptions, limit: number, offset: number, order: OrderItem[] = [['updated_at', 'DESC'], ['id', 'ASC']]) {
        const { count, rows } = await Team.findAndCountAll({
            attributes: [
                'id', 'name', 'scope', 'description', 'author_id', 'install_count', 'visibility', 'listed',
                'created_at', 'updated_at',
                [literal(LATEST_VERSION_SUBQUERY), 'latest_version'],
                [literal('(SELECT count(*)::int FROM team_versions tv WHERE tv.team_id = "Team"."id")'), 'version_count'],
            ],
            include: [{ model: User, as: 'author', attributes: ['username'] }],
            where,
            order,
            limit,
            offset,
            raw: true,
            nest: true,
        });
        return {
            total: count,
            rows: rows.map((r: any) => ({ ...r, author: r.author?.username ?? null })),
        };
    }

    async count_filtered(where: WhereOptions): Promise<number> {
        return Team.count({ where });
    }

    async find_author_username(author_id: string): Promise<string | null> {
        const user = await User.findByPk(author_id, { attributes: ['username'], raw: true });
        return user?.username ?? null;
    }

    async create(
        name: string, scope: string | null, scope_type: string | null,
        description: string, author_id: string,
        license: string, visibility: string, transaction?: Transaction,
        listed: number = 1,
    ): Promise<string> {
        const team = await Team.create(
            { name, scope, scope_type, description, author_id, license, visibility, listed },
            { transaction },
        );
        return team.id;
    }

    /** Records the team and version `id` was forked from. */
    async set_fork_origin(id: string, origin_team_id: string, origin_version: string, transaction?: Transaction): Promise<void> {
        await Team.update(
            { forked_from_team_id: origin_team_id, forked_from_version: origin_version },
            { where: { id }, transaction },
        );
    }

    /** How many teams were forked from `id`. */
    async count_forks(id: string): Promise<number> {
        return Team.count({ where: { forked_from_team_id: id } });
    }

    async update(id: string, description: string, license: string, visibility: string, transaction?: Transaction): Promise<void> {
        await Team.update(
            { description, license, visibility, updated_at: fn('NOW') },
            { where: { id }, transaction },
        );
    }

    async update_visibility_and_listed(
        id: string, visibility: string, listed: number, transaction?: Transaction,
    ): Promise<void> {
        await Team.update(
            { visibility, listed, updated_at: fn('NOW') },
            { where: { id }, transaction },
        );
    }

    async update_description(id: string, description: string, transaction?: Transaction): Promise<void> {
        await Team.update(
            { description, updated_at: fn('NOW') },
            { where: { id }, transaction },
        );
    }

    async find_by_id(id: string) {
        return Team.findByPk(id, { raw: true });
    }

    async update_name(id: string, new_name: string): Promise<void> {
        await Team.update({ name: new_name, updated_at: fn('NOW') }, { where: { id } });
    }

    async update_listed(id: string, listed: number, transaction?: Transaction): Promise<void> {
        await Team.update({ listed }, { where: { id }, transaction });
    }

    async update_install_count(id: string): Promise<void> {
        await Team.increment('install_count', { by: 1, where: { id } });
    }

    async delete_by_id(id: string, transaction?: Transaction): Promise<number> {
        return Team.destroy({ where: { id }, transaction });
    }

    async list_by_scope(scope: string) {
        const rows = await Team.findAll({
            attributes: [
                'id', 'name', 'scope', 'description', 'install_count', 'listed', 'visibility',
                [literal(LATEST_VERSION_SUBQUERY), 'latest_version'],
            ],
            include: [{ model: User, as: 'author', attributes: ['username'] }],
            where: { scope },
            order: [['updated_at', 'DESC']],
            raw: true,
            nest: true,
        });
        return rows.map((r: any) => ({ ...r, author: r.author?.username ?? null }));
    }

    async list_by_scope_list(scopes: string[]) {
        if (scopes.length === 0) return [];
        const rows = await Team.findAll({
            attributes: [
                'id', 'name', 'scope', 'description', 'install_count', 'listed', 'visibility',
                [literal(LATEST_VERSION_SUBQUERY), 'latest_version'],
            ],
            include: [{ model: User, as: 'author', attributes: ['username'] }],
            where: { scope: { [Op.in]: scopes } },
            order: [['scope', 'ASC'], ['updated_at', 'DESC']],
            raw: true,
            nest: true,
        });
        return rows.map((r: any) => ({ ...r, author: r.author?.username ?? null }));
    }
}
