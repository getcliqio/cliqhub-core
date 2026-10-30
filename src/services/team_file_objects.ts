/**
 * A team's file bytes in storage (PLAN-team-bundle §2.2): each file under a new id at
 * `teams/<team_id>/files/<file_id>`, never overwritten, with the row that records it. Written by
 * uploads and the startup backfill (S1.4a); read by publish, the zip and every content read (S1.4b).
 */
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../errors/api_error.js';
import type { TeamFileRow } from '../repositories/team_file_repository.js';
import { team_file_key, type PackageStorage } from '../storage/package_storage.js';

/** One file to store: its path in the team, type and bytes. */
export interface TeamFileInput {
    path: string;
    content_type: string;
    data: Buffer;
}

/** The type a team file is stored with when none was sent: markdown or YAML (a team is text). */
export function team_file_content_type(path: string): string {
    return path.endsWith('.md') ? 'text/markdown' : 'text/yaml';
}

/**
 * Write each file's bytes under a new id and return the rows recording them. Bytes go first, so a row
 * only ever points at bytes that exist; `version_id` is left empty for the caller to set in its transaction.
 *
 * @param storage - Package storage.
 * @param team_id - The team the files belong to.
 * @param files - The files.
 */
export async function write_team_file_objects(storage: PackageStorage, team_id: string, files: TeamFileInput[]): Promise<TeamFileRow[]> {
    const rows: TeamFileRow[] = [];
    for (const f of files) {
        const id = randomUUID();
        const storage_key = team_file_key(team_id, id);
        await storage.write(storage_key, f.data, f.content_type);
        rows.push({
            id, team_id, version_id: '', path: f.path, name: f.path.split('/').pop()!,
            size: f.data.length, sha256: createHash('sha256').update(f.data).digest('hex'),
            content_type: f.content_type, storage_key,
        });
    }
    return rows;
}

/** Decodes UTF-8 and throws on bytes that aren't (a team's files are text). */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A version's files as text, by path, each checked against its recorded sha256.
 *
 * @param storage - Package storage.
 * @param rows - The version's file rows.
 * @throws ApiError 500 when bytes are missing or don't match; 422 when a file isn't UTF-8.
 */
export async function read_team_files(storage: PackageStorage, rows: TeamFileRow[]): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const row of rows) {
        const data = await storage.read(row.storage_key);
        if (!data || createHash('sha256').update(data).digest('hex') !== row.sha256) {
            throw new ApiError('internal', `${row.path}: stored bytes are missing or don't match their record`, 500);
        }
        try {
            files[row.path] = STRICT_UTF8.decode(data);
        } catch {
            throw new ApiError('invalid_package', `${row.path} isn't text (team.yml, roles and dependencies.yml are UTF-8)`, 422, { paths: [row.path] });
        }
    }
    return files;
}
