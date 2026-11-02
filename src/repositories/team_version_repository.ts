import { TeamVersion } from '../models/index.js';
import { QueryTypes, type Transaction } from 'sequelize';
import { get_sequelize } from '../lib/sequelize.js';
import { SemVer } from '../lib/semver.js';
import { BaseRepository } from './base_repository.js';

/** Version reads mean published versions: a draft (PLAN-team-bundle §2.2) has no number and is never "a version". */
const PUBLISHED = { status: 'published' as const };

/** A published row: its number is set. */
function numbered<T extends { version: string | null }>(rows: T[]): Array<T & { version: string }> {
    return rows.filter((r): r is T & { version: string } => r.version !== null);
}

export class TeamVersionRepository extends BaseRepository<TeamVersion> {
    protected readonly model = TeamVersion;
    async find_by_team_and_version(team_id: string, version: string) {
        return TeamVersion.findOne({ where: { team_id, version, ...PUBLISHED }, raw: true });
    }

    /** A published version by id (a draft is not found here). */
    async find_by_id(id: string) {
        const row = await TeamVersion.findOne({
            where: { id, ...PUBLISHED },
            attributes: ['id', 'team_id', 'version'],
            raw: true,
        });
        return row ? numbered([row])[0] ?? null : null;
    }

    // "Latest" = highest semver, NOT most recently published — publishing an older
    // semver on top of a newer one must not flip the badge. See lib/semver.ts.
    async find_latest_version(team_id: string): Promise<string | null> {
        const rows = await TeamVersion.findAll({
            where: { team_id, ...PUBLISHED },
            attributes: ['version'],
            raw: true,
        });
        return SemVer.max(numbered(rows).map((r) => r.version));
    }

    /** A team's latest published version (highest semver): its id and number, or null. */
    async find_latest_ref(team_id: string): Promise<{ id: string; version: string } | null> {
        const rows = numbered(await TeamVersion.findAll({ where: { team_id, ...PUBLISHED }, attributes: ['id', 'version'], raw: true }));
        const latest = SemVer.max(rows.map((r) => r.version));
        return latest ? rows.find((r) => r.version === latest) ?? null : null;
    }

    /** Each team's latest published version (highest semver): team id → its id and number. */
    async find_latest_refs(team_ids: string[]): Promise<Map<string, { id: string; version: string }>> {
        const out = new Map<string, { id: string; version: string }>();
        if (!team_ids.length) return out;
        const rows = numbered(await TeamVersion.findAll({ where: { team_id: team_ids, ...PUBLISHED }, attributes: ['id', 'team_id', 'version'], raw: true }));
        for (const team_id of team_ids) {
            const mine = rows.filter((r) => r.team_id === team_id);
            const latest = SemVer.max(mine.map((r) => r.version));
            const row = latest ? mine.find((r) => r.version === latest) : undefined;
            if (row) out.set(team_id, { id: row.id, version: row.version });
        }
        return out;
    }

    async list_by_team_id(team_id: string) {
        const rows = await TeamVersion.findAll({
            where: { team_id, ...PUBLISHED },
            attributes: ['version', 'changelog', 'published_at'],
            raw: true,
        });
        return SemVer.sort_desc(numbered(rows));
    }

    async list_versions(team_id: string): Promise<string[]> {
        const rows = await TeamVersion.findAll({
            where: { team_id, ...PUBLISHED },
            attributes: ['version'],
            raw: true,
        });
        return numbered(rows).map((r) => r.version);
    }

    async delete_by_id(id: string): Promise<number> {
        return TeamVersion.destroy({ where: { id } });
    }

    async find_id_and_package(team_id: string, version: string) {
        return TeamVersion.findOne({
            where: { team_id, version, ...PUBLISHED },
            attributes: ['id', 'package_path'],
            raw: true,
        });
    }

    async list_packages_by_team(team_id: string) {
        return TeamVersion.findAll({
            where: { team_id, ...PUBLISHED },
            attributes: ['package_path'],
            raw: true,
        });
    }

    async list_all_by_team(team_id: string) {
        return TeamVersion.findAll({
            where: { team_id, ...PUBLISHED },
            attributes: ['id', 'version', 'package_path'],
            raw: true,
        });
    }

    async find_latest_package(team_id: string) {
        const rows = await TeamVersion.findAll({
            where: { team_id, ...PUBLISHED },
            attributes: ['id', 'package_path', 'version'],
            raw: true,
        });
        if (rows.length === 0) return null;
        return SemVer.sort_desc(numbered(rows))[0];
    }

    async find_package_by_version(team_id: string, version: string) {
        const row = await TeamVersion.findOne({
            where: { team_id, version, ...PUBLISHED },
            attributes: ['id', 'package_path', 'version'],
            raw: true,
        });
        return row ? numbered([row])[0] ?? null : null;
    }

    /** A published version by its id: its team, number and stored package. */
    async find_package_by_id(id: string) {
        const row = await TeamVersion.findOne({
            where: { id, ...PUBLISHED },
            attributes: ['id', 'team_id', 'package_path', 'version'],
            raw: true,
        });
        return row ? numbered([row])[0] ?? null : null;
    }

    /** Every version's id, team and stored package (the one-time move to id keys, S1.2). */
    async list_all_packages() {
        return TeamVersion.findAll({ attributes: ['id', 'team_id', 'version', 'package_path'], raw: true });
    }

    /**
     * Published versions with no `team_files` rows (made before S1.3b, or seeded): what the startup backfill
     * (PLAN-team-bundle S1.4a) gives files, from the zip or, without one, from these columns.
     */
    async list_published_without_files(): Promise<Array<{
        id: string; team_id: string; version: string; package_path: string;
        manifest_yaml: string | null; readme: string | null; dependencies_yaml: string | null; roles_json: string | null;
        workflow_json: string | null; capability_json: string | null; agents_json: string | null;
        team_scope: string | null; team_name: string; team_description: string | null;
    }>> {
        // Raw SQL: the content columns aren't in the model any more, and exist only until S1.5 drops them.
        const rows = await get_sequelize().query(
            `SELECT v.id, v.team_id, v.version, v.package_path, v.manifest_yaml, v.readme, v.dependencies_yaml, v.roles_json,
                    v.workflow_json, v.capability_json, v.agents_json,
                    t.scope AS team_scope, t.name AS team_name, t.description AS team_description
             FROM cliq.team_versions v JOIN cliq.teams t ON t.id = v.team_id
             WHERE v.status = 'published' AND NOT EXISTS (SELECT 1 FROM cliq.team_files f WHERE f.version_id = v.id)`,
            { type: QueryTypes.SELECT },
        );
        return numbered(rows as never[]);
    }

    /** Every published version with its team's name: what the old-zip cleanup (PLAN-team-bundle S1.5c) checks. */
    async list_published_packages(): Promise<Array<{ id: string; team_id: string; version: string; package_path: string; team_name: string }>> {
        const rows = await get_sequelize().query(
            `SELECT v.id, v.team_id, v.version, v.package_path, t.name AS team_name
             FROM cliq.team_versions v JOIN cliq.teams t ON t.id = v.team_id
             WHERE v.status = 'published'`,
            { type: QueryTypes.SELECT },
        );
        return numbered(rows as never[]);
    }

    /** A new draft version of a team (no number, no date yet): its id. */
    async create_draft(team_id: string, transaction?: Transaction): Promise<string> {
        const row = await TeamVersion.create(
            { team_id, status: 'draft', version: null, published_at: null, saved_at: new Date(), package_path: '', changelog: '' } as never,
            { transaction },
        );
        return row.id;
    }

    /**
     * Publish a draft: set its number and date, flip it to published, and fill the columns derived from its
     * files (read from them until S1.4). Nothing is created or copied.
     *
     * @returns false when the row isn't a draft (already published, or gone).
     */
    async publish_draft(id: string, fields: { version: string; changelog: string }, transaction: Transaction): Promise<boolean> {
        const [n] = await TeamVersion.update(
            { ...fields, status: 'published', published_at: new Date() } as never,
            { where: { id, status: 'draft' }, transaction },
        );
        return n === 1;
    }

    /** Mark a draft as just saved (its files changed). */
    async touch_draft(id: string, transaction?: Transaction): Promise<void> {
        await TeamVersion.update({ saved_at: new Date() } as never, { where: { id, status: 'draft' }, transaction });
    }

    /** A team's open draft: the most recently saved one, or null. */
    async find_open_draft(team_id: string): Promise<{ id: string; saved_at: Date | null } | null> {
        return TeamVersion.findOne({
            where: { team_id, status: 'draft' },
            attributes: ['id', 'saved_at'],
            order: [['saved_at', 'DESC NULLS LAST']],
            raw: true,
        });
    }

    /** Delete a draft (its team_files rows go with it); false when it isn't a draft. */
    async delete_draft(id: string, transaction?: Transaction): Promise<boolean> {
        return (await TeamVersion.destroy({ where: { id, status: 'draft' }, transaction })) === 1;
    }

    /** A draft version by id, or null (a published version is not a draft). */
    async find_draft(id: string): Promise<{ id: string; team_id: string } | null> {
        return TeamVersion.findOne({ where: { id, status: 'draft' }, attributes: ['id', 'team_id'], raw: true });
    }

    async update_package_path(id: string, pkg_path: string, transaction?: Transaction): Promise<void> {
        await TeamVersion.update({ package_path: pkg_path }, { where: { id }, transaction });
    }
}
