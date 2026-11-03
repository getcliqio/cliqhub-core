/**
 * A version is its files (PLAN-team-bundle S1.4b): what it runs, its inputs and when to use it are read from its
 * team.yml, not from columns on the version row. These tests publish versions that way, into local storage.
 */
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { TeamVersion } from '../../../src/models/index.js';
import { get_sequelize } from '../../../src/db/sequelize.js';
import { TeamFileRepository } from '../../../src/repositories/team_file_repository.js';
import { team_file_content_type, write_team_file_objects } from '../../../src/services/team_file_objects.js';
import { create_package_storage } from '../../../src/storage/package_storage.js';

/**
 * The test database's file storage. A fixed folder, not a fresh one per run: the database keeps versions (the
 * built-ins are seeded once), and their files must still be there on the next run.
 */
export const test_packages_path = path.join(os.tmpdir(), 'cliqhub_test-packages');

export const test_package_storage = () => create_package_storage({
    packages_path: test_packages_path, storage_backend: 'local',
    s3_endpoint: '', s3_teams_bucket: '', s3_access_key_id: '', s3_secret_access_key: '',
});

/**
 * Publish a version as files: its team.yml (an object is written as YAML) and any other files.
 *
 * @returns The version's id.
 */
export async function publish_version(
    team_id: string,
    version: string,
    team_yml: Record<string, unknown> | string,
    other_files: Record<string, string> = {},
    status: 'published' | 'draft' = 'published',
): Promise<string> {
    const files = { 'team.yml': typeof team_yml === 'string' ? team_yml : yaml.dump({ version, ...team_yml }), ...other_files };
    const rows = await write_team_file_objects(test_package_storage(), team_id, Object.entries(files).map(([p, text]) => ({
        path: p, content_type: team_file_content_type(p), data: Buffer.from(text, 'utf8'),
    })));
    return get_sequelize().transaction(async (t) => {
        const row = await TeamVersion.create({
            team_id, status, version, changelog: '', package_path: '',
            ...(status === 'published' ? { published_at: new Date() } : {}),
        } as never, { transaction: t });
        for (const r of rows) r.version_id = row.id;
        await new TeamFileRepository().replace_paths(row.id, rows, t);
        return row.id as string;
    });
}
