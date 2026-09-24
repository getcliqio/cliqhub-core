import { TeamVersion } from '../db/models/index.js';
import type { Transaction } from 'sequelize';
import { max_semver, sort_semver_desc } from '../lib/semver.js';

export class TeamVersionRepository {
    async find_by_team_and_version(team_id: string, version: string) {
        return TeamVersion.findOne({ where: { team_id, version }, raw: true });
    }

    async find_by_id(id: string) {
        return TeamVersion.findOne({
            where: { id },
            attributes: ['id', 'team_id', 'version', 'workflow_json', 'manifest_yaml'],
            raw: true,
        });
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
            where: { team_id },
            attributes: ['version'],
            raw: true,
        });
        return max_semver(rows.map((r) => r.version));
    }

    async find_detail_by_team_and_version(team_id: string, version: string) {
        return TeamVersion.findOne({
            where: { team_id, version },
            attributes: ['id', 'version', 'workflow_json', 'manifest_yaml', 'agents_json', 'readme', 'cliq_version', 'tools', 'capability_json', 'roles_json'],
            raw: true,
        });
    }

    async list_by_team_id(team_id: string) {
        const rows = await TeamVersion.findAll({
            where: { team_id },
            attributes: ['version', 'changelog', 'published_at'],
            raw: true,
        });
        return sort_semver_desc(rows);
    }

    async list_versions(team_id: string): Promise<string[]> {
        const rows = await TeamVersion.findAll({
            where: { team_id },
            attributes: ['version'],
            raw: true,
        });
        return rows.map((r) => r.version);
    }

    async create(
        team_id: string, version: string, changelog: string, pkg_path: string,
        cliq_version: string | null, tools: string, workflow_json: string,
        manifest_yaml: string,
        readme: string, capability_json: string, agents_json: string,
        roles_json: string,
        transaction?: Transaction,
    ): Promise<string> {
        const row = await TeamVersion.create(
            { team_id, version, changelog, package_path: pkg_path, cliq_version, tools, workflow_json, manifest_yaml, readme, capability_json, agents_json, roles_json },
            { transaction },
        );
        return row.id;
    }

    async delete_by_id(id: string): Promise<void> {
        await TeamVersion.destroy({ where: { id } });
    }

    async find_id_and_package(team_id: string, version: string) {
        return TeamVersion.findOne({
            where: { team_id, version },
            attributes: ['id', 'package_path'],
            raw: true,
        });
    }

    async list_packages_by_team(team_id: string) {
        return TeamVersion.findAll({
            where: { team_id },
            attributes: ['package_path'],
            raw: true,
        });
    }

    async list_all_by_team(team_id: string) {
        return TeamVersion.findAll({
            where: { team_id },
            attributes: ['id', 'version', 'package_path'],
            raw: true,
        });
    }

    async find_latest_package(team_id: string) {
        const rows = await TeamVersion.findAll({
            where: { team_id },
            attributes: ['package_path', 'version'],
            raw: true,
        });
        if (rows.length === 0) return null;
        return sort_semver_desc(rows)[0];
    }

    async find_package_by_version(team_id: string, version: string) {
        return TeamVersion.findOne({
            where: { team_id, version },
            attributes: ['package_path', 'version'],
            raw: true,
        });
    }

    async update_package_path(id: string, pkg_path: string): Promise<void> {
        await TeamVersion.update({ package_path: pkg_path }, { where: { id } });
    }
}
