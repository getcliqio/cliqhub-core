/**
 * Publishing a team over HTTP the way cliqd and the builder do (PLAN-team-bundle S1.3b, §2.6): a new team is
 * created first (`teams/create`, which opens a draft), its files go into a draft (`teams/files/upload`, multipart),
 * and `teams/publish` turns that draft into the version.
 */
import request from 'supertest';
import type { Express } from 'express';

import { Team } from '../../src/models/index.js';

/** Upload files into a team's draft (a new draft when `version_id` is absent). */
export function upload_files(
    app: Express, token: string,
    payload: { team_id: string; version_id?: string; based_on_version_id?: string },
    files: Record<string, string>,
): request.Test {
    let r = request(app).post('/v1/teams/files/upload').set('Authorization', `Bearer ${token}`)
        .field('payload', JSON.stringify(payload));
    for (const [path, text] of Object.entries(files)) {
        r = r.attach('files', Buffer.from(text, 'utf8'), { filename: path, contentType: path.endsWith('.md') ? 'text/markdown' : 'text/yaml' });
    }
    return r;
}

export interface PublishTeam {
    name: string; scope: string; version: string;
    /** The team's files by path (team.yml, roles/<phase>.md, dependencies.yml, README.md). */
    files: Record<string, string>;
    visibility?: 'public' | 'private'; tags?: string[]; changelog?: string; description?: string;
}

/**
 * Create the team if it doesn't exist, upload its files into a draft and publish that draft.
 *
 * @returns The first response that isn't a success (create, upload or publish), else the publish response.
 */
export async function publish_team(app: Express, token: string, p: PublishTeam): Promise<request.Response> {
    const auth = `Bearer ${token}`;
    const existing = await Team.findOne({ where: { name: p.name, scope: p.scope }, attributes: ['id'], raw: true }) as { id: string } | null;
    let team_id = existing?.id;
    let draft_id: string | undefined;
    if (!team_id) {
        const created = await request(app).post('/v1/teams/create').set('Authorization', auth).send({ name: p.name, scope: p.scope });
        if (created.status !== 200) return created;
        team_id = String(created.body.data.id);
        draft_id = String(created.body.data.version_id);
    }
    const up = await upload_files(app, token, { team_id, ...(draft_id ? { version_id: draft_id } : {}) }, p.files);
    if (up.status !== 201) return up;
    const { name: _n, scope: _s, files: _f, ...rest } = p;
    return request(app).post('/v1/teams/publish').set('Authorization', auth)
        .send({ team_id, version_id: up.body.data.version_id, ...rest });
}
