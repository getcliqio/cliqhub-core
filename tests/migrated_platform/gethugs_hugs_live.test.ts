/**
 * PLAN-gethugs-step3-asking.md sub-step 4, live: an org (test database) reconciled into a real getHugs (the
 * local stack); Core opens a Hug there through `HugsService.create` (built-in template read from getHugs, channel names
 * translated, `ref_id`, `Idempotency-Key`), a retry gives the same Hug, close and the run's end reach getHugs. Reads
 * only GETHUGS_URL, GETHUGS_PARTNER_TOKEN and GETHUGS_APP_URL from `.env`; skips without the first two.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Daemon, Hug, Org, OrgMember, OrgRole, RealmMember, Run, User, Workspace } from '../../src/models/index.js';
import { ArtifactStorageService } from '../../src/services/artifact_storage.service.js';
import { seed_default_roles_for_org } from '../../src/models/migrations/migrate_org_roles.js';
import { gethugs_partner } from '../../src/services/gethugs.service.js';
import { gethugs_reconcile } from '../../src/services/gethugs_reconcile.js';
import { HugsService } from '../../src/services/hugs.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';

function gethugs_from_dotenv(): boolean {
    let text = '';
    try {
        text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    } catch {
        return false;
    }
    const env = parseEnv(text);
    if (!env.GETHUGS_URL || !env.GETHUGS_PARTNER_TOKEN) return false;
    process.env.GETHUGS_URL = env.GETHUGS_URL;
    process.env.GETHUGS_PARTNER_TOKEN = env.GETHUGS_PARTNER_TOKEN;
    if (env.GETHUGS_APP_URL) process.env.GETHUGS_APP_URL = env.GETHUGS_APP_URL;
    return true;
}

const configured = gethugs_from_dotenv();
const has_postgres = await postgres_reachable();
const uid = () => `la${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!configured || !has_postgres)('asking through getHugs, live (local stack)', () => {
    let org_id = '';

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });
    afterAll(async () => {
        if (org_id) {
            const r = { replacements: { org_id } };
            await get_sequelize().query('DELETE FROM cliq.hugs WHERE org_id = :org_id', r);
            await get_sequelize().query('DELETE FROM cliq.notification_channels WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = :org_id)', r);
            await get_sequelize().query('DELETE FROM cliq.realm_members WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = :org_id)', r);
            await get_sequelize().query('DELETE FROM cliq.realms WHERE org_id = :org_id', r);
            await Org.destroy({ where: { id: org_id } });
        }
        await close_test_control_plane_store();
    });

    it('opens a Hug in getHugs, a retry gives the same Hug, close and the run’s end reach getHugs', async () => {
        const partner = gethugs_partner();
        const person = async () => {
            const name = uid();
            const id = randomUUID();
            await User.create({ id, username: name, email: `${name}@cliq.test`, display_name: name, status: 'active', role: 'user', password_hash: 'x' } as never);
            return { id, username: name, email: `${name}@cliq.test` };
        };
        const owner = await person();
        const bob = await person();
        const org = await Org.create({ slug: uid(), display_name: `Ask ${uid()}`, status: 'active', owner_id: owner.id, activated_at: new Date() } as never);
        org_id = org.id;
        await seed_default_roles_for_org(org.id);
        for (const [u, slug] of [[owner, 'owner'], [bob, 'member']] as const) {
            const role = await OrgRole.findOne({ where: { org_id: org.id, slug }, attributes: ['id'], raw: true });
            await OrgMember.create({ org_id: org.id, user_id: u.id, role: slug === 'member' ? 'member' : 'admin', role_id: role!.id, status: 'active', joined_at: new Date() } as never);
        }
        await RealmService.create(owner.id, 'default', 'Main', { org_id: org.id });
        const ops = await RealmService.create(owner.id, uid(), 'Ops', { org_id: org.id });
        await RealmMember.create({ id: randomUUID(), realm_id: ops.id, member_type: 'user', member_id: bob.id, role: 'operator', created_at: Date.now() } as never);
        await NotificationService.create_channel({ realm_id: ops.id, name: 'reviewers', destinations: [{ type: 'email', address: 'rev@cliq.test' }] });
        await gethugs_reconcile(org.id, partner);

        const run_id = `run-${uid()}`;
        const hug_id = randomUUID();
        const ask = () => HugsService.create({
            hug_id, run_id, daemon_id: 'daemon-live', realm_id: ops.id, phase: 'review', iteration: 1, actor_id: null,
            spec: {
                hug: { name: 'approval', sha256: 'b'.repeat(64) }, title: 'Ship 4.2?', summary: 'Live check',
                params: { prompt: 'Ship 4.2?' }, channels: ['All realm members', bob.username, 'reviewers'], expires_in_min: 30,
            },
        });
        const first = await ask();
        const row = (await Hug.findByPk(hug_id, { raw: true }))!;
        expect(row).toMatchObject({ status: 'open' });
        expect(first.hug_url).toBe(`${process.env.GETHUGS_APP_URL ?? process.env.GETHUGS_URL}/hugs/${row.gethugs_id}`);
        expect(await ask()).toEqual(first);

        const g_org = (await gethugs_reconcile(org.id, partner)).gethugs_org_id!;
        const in_ws = partner.in_workspace(g_org, row.gethugs_workspace_id!);
        const listed = await in_ws.call<{ items: Array<{ id: string; status: string; requester: string | null; template: { id: string }; channels: string[] }> }>(
            'hugs/get', { workspace_id: row.gethugs_workspace_id, org_id: g_org, ref_id: `cliqhub:run:${run_id}` },
        );
        expect(listed.items.map((h) => h.id)).toEqual([row.gethugs_id]);
        expect(listed.items[0]).toMatchObject({ status: 'open', template: { id: 'tpl_approval' } });
        expect(listed.items[0]!.channels.sort()).toEqual(['all-workspace', bob.email, 'reviewers'].sort());
        expect(listed.items[0]!.requester).toMatch(/run run-/);

        // A second Hug of the run, closed by its daemon; then the run ends and the first is cancelled.
        const second = await HugsService.create({
            hug_id: randomUUID(), run_id, daemon_id: 'daemon-live', realm_id: ops.id, phase: 'review', iteration: 2, actor_id: null,
            spec: { hug: { name: 'form', sha256: 'c'.repeat(64) }, title: 'Notes?', params: {}, channels: ['All realm members'], expires_in_min: 30 },
        });
        expect(await HugsService.close({ hug_id: second.hug_id, outcome: 'done', daemon_id: 'daemon-live' })).toEqual({ status: 'closed' });
        expect(await HugsService.cancel_for_run(run_id)).toBe(1);
        const after = await in_ws.call<{ items: Array<{ id: string; status: string }> }>(
            'hugs/get', { workspace_id: row.gethugs_workspace_id, org_id: g_org, ref_id: `cliqhub:run:${run_id}` },
        );
        expect(Object.fromEntries(after.items.map((h) => [h.id, h.status]))).toEqual({
            [row.gethugs_id!]: 'cancelled',
            [(await Hug.findByPk(second.hug_id, { raw: true }))!.gethugs_id!]: 'closed',
        });

        // A run file shown with a Hug (PLAN-gethugs-step5-files.md): uploaded as a document of the workspace. Files stay
        // in a temp folder, never the bucket a shell's S3_* points at.
        const saved = { ...process.env };
        const dir = mkdtempSync(path.join(tmpdir(), 'gethugs-live-'));
        for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[k];
        Object.assign(process.env, { STORAGE_BACKEND: 'local', ARTIFACTS_LOCAL_DIR: dir });
        try {
            const file_run = `run-${uid()}`;
            const daemon_id = `daemon-${uid()}`;
            const ws = `ws-${uid()}`;
            await Daemon.create({ id: daemon_id, api_key_hash: 'h', hostname: 'd', ip: '127.0.0.1', port: 4900, public_url: 'http://127.0.0.1:4900', status: 'online', last_heartbeat: Date.now(), capacity: 5, created_at: Date.now(), last_registered_at: Date.now() } as never);
            await Workspace.create({ id: ws, path: `/tmp/${ws}`, created_at: Date.now(), updated_at: Date.now() } as never);
            await Run.create({ run_id: file_run, workspace_id: ws, team_id: 't', state: 'running', started_at: Date.now(), realm_id: ops.id, daemon_id } as never);
            const bytes = Buffer.from('Q3 numbers: all green');
            const file = await new ArtifactStorageService().upload({
                stream: Readable.from([bytes]), content_length: bytes.length, content_type: 'text/plain', name: 'q3.txt',
                target: { kind: 'run', run_id: file_run, phase: 'review' }, uploaded_by: null,
            });
            const with_file = await HugsService.create({
                hug_id: randomUUID(), run_id: file_run, daemon_id, realm_id: ops.id, phase: 'review', iteration: 1, actor_id: null,
                spec: {
                    hug: { name: 'approval', sha256: 'd'.repeat(64) }, title: 'Approve Q3?', channels: ['All realm members'], expires_in_min: 30,
                    attachments: [{ artifact_id: file.artifact_id, name: file.name, size: file.size, content_type: file.content_type, sha256: file.sha256 }],
                    params: { prompt: 'Approve Q3?', context: [{ type: 'artifact', artifact_id: file.artifact_id }] },
                },
            });
            const g_hug = (await Hug.findByPk(with_file.hug_id, { raw: true }))!;
            const shown = await in_ws.call<{ attachments: Array<{ document_id: string; name: string; size: number }>; params: { context: Array<{ type: string; document_id?: string }> } }>(
                'hugs/get_by_id', { workspace_id: g_hug.gethugs_workspace_id, org_id: g_org, hug_id: g_hug.gethugs_id },
            );
            expect(shown.attachments.map((a) => [a.name, a.size])).toEqual([['q3.txt', bytes.length]]);
            expect(shown.params.context).toEqual([{ type: 'document', document_id: shown.attachments[0]!.document_id }]);
            const doc = await in_ws.documents.download(shown.attachments[0]!.document_id);
            expect(Buffer.from(await doc.arrayBuffer()).toString()).toBe('Q3 numbers: all green');
            await HugsService.cancel_for_run(file_run);
            await Run.destroy({ where: { run_id: file_run } });
            await Daemon.destroy({ where: { id: daemon_id } });
        } finally {
            for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'STORAGE_BACKEND', 'ARTIFACTS_LOCAL_DIR']) {
                if (saved[k] === undefined) delete process.env[k];
                else process.env[k] = saved[k];
            }
            rmSync(dir, { recursive: true, force: true });
        }

        await Org.update({ status: 'deleted', deleted_at: new Date() } as never, { where: { id: org.id } });
        await gethugs_reconcile(org.id, partner);
    });
});
