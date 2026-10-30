import { TeamVersion } from '../models/index.js';
import type { Transaction } from 'sequelize';
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
            attributes: ['id', 'team_id', 'version', 'workflow_json', 'manifest_yaml'],
            raw: true,
        });
        return row ? numbered([row])[0] ?? null : null;
    }

    async find_latest_detail(team_id: string) {
        const version = await this.find_latest_version(team_id);
        if (!version) return null;
        return this.find_detail_by_team_and_version(team_id, version);
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

    async find_detail_by_team_and_version(team_id: string, version: string) {
        const row = await TeamVersion.findOne({
            where: { team_id, version, ...PUBLISHED },
            attributes: ['id', 'version', 'workflow_json', 'manifest_yaml', 'agents_json', 'readme', 'cliq_version', 'tools', 'capability_json', 'roles_json', 'dependencies_yaml'],
            raw: true,
        });
        return row ? numbered([row])[0] ?? null : null;
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

    async create(
        team_id: string, version: string, changelog: string, pkg_path: string,
        cliq_version: string | null, tools: string, workflow_json: string,
        manifest_yaml: string,
        readme: string, capability_json: string, agents_json: string,
        roles_json: string,
        transaction?: Transaction,
        dependencies_yaml = '',
    ): Promise<string> {
        const row = await TeamVersion.create(
            { team_id, version, changelog, package_path: pkg_path, cliq_version, tools, workflow_json, manifest_yaml, readme, capability_json, agents_json, roles_json, dependencies_yaml },
            { transaction },
        );
        return row.id;
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

    /** A new draft version of a team (no number, no date yet): its id. */
    async create_draft(team_id: string, transaction?: Transaction): Promise<string> {
        const row = await TeamVersion.create(
            { team_id, status: 'draft', version: null, published_at: null, package_path: '', changelog: '' } as never,
            { transaction },
        );
        return row.id;
    }

    /** A draft version by id, or null (a published version is not a draft). */
    async find_draft(id: string): Promise<{ id: string; team_id: string } | null> {
        return TeamVersion.findOne({ where: { id, status: 'draft' }, attributes: ['id', 'team_id'], raw: true });
    }

    async update_package_path(id: string, pkg_path: string, transaction?: Transaction): Promise<void> {
        await TeamVersion.update({ package_path: pkg_path }, { where: { id }, transaction });
    }
}
