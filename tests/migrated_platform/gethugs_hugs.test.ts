/**
 * PLAN-gethugs-step3-asking.md sub-step 2: a switched org's Hug is created in getHugs (a fake one) — built-in templates
 * read from getHugs by name, a team hug installed once per bundle, channel names translated, the run's `ref_id`,
 * `requester` and the daemon's id as the `Idempotency-Key` — and Core keeps its row under the daemon's id. Errors:
 * unknown channels and non-members as today's 422, getHugs down 503, the token 502, not set up yet 503,
 * run files `not_supported_yet`.
 */
import { randomUUID } from 'node:crypto';
import { hug_bundle_hash } from '@getcliqio/cliq-sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { FakeGethugs } from '../helpers/fake_gethugs.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { Daemon, Hug, Org, OrgMember, OrgRole, RealmMember, Run, StoredArtifact, User, Workspace } from '../../src/models/index.js';
import { RunService } from '../../src/services/run.service.js';
import { ArtifactStorageService } from '../../src/services/artifact_storage.service.js';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crash_and_emit } from '../../src/services/run_reaper.service.js';
import { seed_default_roles_for_org } from '../../src/models/migrations/migrate_org_roles.js';
import { gethugs_partner } from '../../src/services/gethugs.service.js';
import { reset_gethugs_builtins } from '../../src/services/gethugs_hugs.js';
import { gethugs_reconcile } from '../../src/services/gethugs_reconcile.js';
import { HugsService } from '../../src/services/hugs.service.js';
import { gethugs_apply } from '../../src/services/gethugs_events.js';
import { GETHUGS_FEED_LOCK_KEY, run_gethugs_feed } from '../../src/services/gethugs_feed.js';
import pg from 'pg';
import { database_url } from './helpers/control_plane_store.js';
import { HugEventRow } from '../../src/models/index.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `gk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const bundle_of = (name: string, tag = '') => ({
    'hug.json': JSON.stringify({ name, title: `The ${name} hug`, entry: 'index.html', sdk_version: '0.1.0', definition: 'definition.mjs' }),
    'index.html': `<!doctype html><script type="module" src="./main.js"></script>${tag}`,
    'main.js': 'export {};',
    'definition.mjs': 'export default {};',
});

describe.skipIf(!has_postgres)('asking through getHugs', () => {
    const orgs: string[] = [];
    let fake: FakeGethugs;
    let o: { org_id: string; realm_id: string; bob: { id: string; username: string; email: string } };

    async function person() {
        const name = uid();
        const id = randomUUID();
        await User.create({ id, username: name, email: `${name}@cliq.test`, display_name: name, status: 'active', role: 'user', password_hash: 'x' } as never);
        return { id, username: name, email: `${name}@cliq.test` };
    }
    /** A switched org reconciled into the fake getHugs: owner, Bob (member of realm `ops`), channel `reviewers` in `ops`. */
    async function switched_org() {
        const owner = await person();
        const org = await Org.create({ slug: uid(), display_name: 'Ask', status: 'active', owner_id: owner.id, activated_at: new Date() } as never);
        orgs.push(org.id);
        await seed_default_roles_for_org(org.id);
        const role = async (slug: string) => (await OrgRole.findOne({ where: { org_id: org.id, slug }, attributes: ['id'], raw: true }))!.id;
        await OrgMember.create({ org_id: org.id, user_id: owner.id, role: 'admin', role_id: await role('owner'), status: 'active', joined_at: new Date() } as never);
        const bob = await person();
        await OrgMember.create({ org_id: org.id, user_id: bob.id, role: 'member', role_id: await role('member'), status: 'active', joined_at: new Date() } as never);
        await RealmService.create(owner.id, 'default', 'Main', { org_id: org.id });
        const ops = await RealmService.create(owner.id, uid(), 'Ops', { org_id: org.id });
        await RealmMember.create({ id: randomUUID(), realm_id: ops.id, member_type: 'user', member_id: bob.id, role: 'operator', created_at: Date.now() } as never);
        await NotificationService.create_channel({ realm_id: ops.id, name: 'reviewers', destinations: [{ type: 'email', address: 'rev@cliq.test' }] });
        await gethugs_reconcile(org.id, gethugs_partner()!);
        await Org.update({ hugs_provider: 'gethugs' } as never, { where: { id: org.id } });
        return { org_id: org.id, realm_id: ops.id, bob };
    }
    const spec = (over: Record<string, unknown> = {}) => ({
        hug: { name: 'approval', sha256: 'a'.repeat(64) },
        title: 'Ship it?',
        summary: 'Release 4.2',
        params: { question: 'Ship?' },
        channels: ['reviewers'],
        expires_in_min: 60,
        ...over,
    });
    const open = (over: Record<string, unknown> = {}, input: Record<string, unknown> = {}) => HugsService.create({
        hug_id: randomUUID(), run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id: o.realm_id, phase: 'review', iteration: 1,
        spec: spec(over), actor_id: null, ...input,
    } as never);

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });
    beforeEach(async () => {
        fake = new FakeGethugs();
        vi.stubGlobal('fetch', fake.fetch);
        process.env.GETHUGS_URL = 'http://gethugs.test';
        process.env.GETHUGS_PARTNER_TOKEN = 'hugs_svc_test';
        process.env.GETHUGS_APP_URL = 'http://app.gethugs.test';
        reset_gethugs_builtins();
        o = await switched_org();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.GETHUGS_URL;
        delete process.env.GETHUGS_PARTNER_TOKEN;
        delete process.env.GETHUGS_APP_URL;
    });
    afterAll(async () => {
        if (orgs.length) {
            const ids = { replacements: { ids: orgs } };
            await get_sequelize().query('DELETE FROM cliq.hugs WHERE org_id = ANY(ARRAY[:ids]::uuid[])', ids);
            await get_sequelize().query('DELETE FROM cliq.notification_channels WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[]))', ids);
            await get_sequelize().query('DELETE FROM cliq.realm_members WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[]))', ids);
            await get_sequelize().query('DELETE FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[])', ids);
            await Org.destroy({ where: { id: orgs } });
        }
        await close_test_control_plane_store();
    });

    it('a built-in hug opens getHugs’ template of that name; Core keeps its row under the daemon’s id; the link is getHugs’ page', async () => {
        const hug_id = randomUUID();
        const run_id = `run-${uid()}`;
        const out = await open({ channels: ['All realm members', o.bob.username, 'reviewers'] }, { hug_id, run_id });
        const h = fake.hugs[0]!;
        expect(out).toEqual({ hug_id, hug_url: `http://app.gethugs.test/hugs/${h.id}` });
        expect(h).toMatchObject({
            template: 'tpl_approval', ref_id: `cliqhub:run:${run_id}`, idempotency_key: hug_id, title: 'Ship it?',
            channels: ['all-workspace', o.bob.email, 'reviewers'],
            context: { org: o.org_id, realm: o.realm_id, run_id, phase: 'review', iteration: 1 },
        });
        expect(h.requester).toMatch(/· run run-/);
        expect(fake.calls).not.toContain('templates/create');

        const row = (await Hug.findByPk(hug_id, { raw: true }))!;
        expect(row).toMatchObject({ provider: 'gethugs', gethugs_id: h.id, status: 'open', run_id, hug_name: 'approval', next_remind_at: null });
        expect(row.gethugs_workspace_id).toBe(h.workspace_id);

        // A retry with the same id: the same Hug, also when Core lost its row (getHugs' Idempotency-Key).
        expect(await open({}, { hug_id, run_id })).toEqual(out);
        await Hug.destroy({ where: { id: hug_id } });
        expect(await open({ channels: ['All realm members', o.bob.username, 'reviewers'] }, { hug_id, run_id })).toEqual(out);
        expect(fake.hugs).toHaveLength(1);
    });

    it('a team hug is installed from its bundle once per bundle (asking cliqd for it as today); a new bundle is a new version', async () => {
        const files = bundle_of('review', uid());
        const hug = { name: 'review', sha256: hug_bundle_hash(files) };
        await expect(open({ hug })).rejects.toMatchObject({ status: 409, code: 'BUNDLE_MISSING' });
        await open({ hug }, { bundle: files, may_upload_bundle: true });
        const installed = fake.templates.find((t) => !t.builtin && t.org_id !== null)!;
        expect(installed.name).toMatch(/\/review$/);
        expect(fake.hugs.at(-1)!.template).toBe(installed.versions[0]!.id);

        await open({ hug });
        expect(fake.calls.filter((c) => c === 'templates/create' || c === 'templates/add_version')).toEqual(['templates/create']);

        const next = bundle_of('review', uid());
        await open({ hug: { name: 'review', sha256: hug_bundle_hash(next) } }, { bundle: next, may_upload_bundle: true });
        expect(installed.versions).toHaveLength(2);
        expect(fake.hugs.at(-1)!.template).toBe(installed.versions[1]!.id);
    });

    it('refusals come back as today’s 422: an unknown channel, a person who isn’t a workspace member', async () => {
        await expect(open({ channels: ['nowhere'] })).rejects.toMatchObject({ status_code: 422 });
        const carol = await person();
        await OrgMember.create({ org_id: o.org_id, user_id: carol.id, role: 'member', status: 'active', joined_at: new Date() } as never);
        await gethugs_reconcile(o.org_id, gethugs_partner()!);
        await expect(open({ channels: [carol.username] })).rejects.toMatchObject({ status_code: 422, code: 'not_a_member' });
        expect(fake.hugs).toHaveLength(0);
        expect(await Hug.count({ where: { org_id: o.org_id } })).toBe(0);
    });

    it('getHugs down: 503 (cliqd retries); the token refused: 502; the org not set up yet: 503, and it is marked', async () => {
        fake.fail_with = 401;
        await expect(open()).rejects.toMatchObject({ status_code: 502, code: 'gethugs_auth' });
        fake.fail_with = null;

        const bare = await switched_org();
        await get_sequelize().query('DELETE FROM cliq.gethugs_links WHERE org_id = :org_id', { replacements: { org_id: bare.org_id } });
        await get_sequelize().query('DELETE FROM cliq.gethugs_sync WHERE org_id = :org_id', { replacements: { org_id: bare.org_id } });
        await expect(HugsService.create({ hug_id: randomUUID(), run_id: 'run-x', daemon_id: 'd', realm_id: bare.realm_id, phase: 'p', iteration: 0, spec: spec(), actor_id: null } as never))
            .rejects.toMatchObject({ status_code: 503, code: 'gethugs_not_ready' });
        const [marks] = await get_sequelize().query('SELECT 1 FROM cliq.gethugs_sync WHERE org_id = :org_id', { replacements: { org_id: bare.org_id } });
        expect(marks).toHaveLength(1);
    });

    it('getHugs unavailable: 503', async () => {
        fake.fail_with = 503;
        await expect(open()).rejects.toMatchObject({ status_code: 503, code: 'gethugs_unavailable' });
    }, 60_000);

    describe('run files shown with a Hug (PLAN-gethugs-step5-files.md)', () => {
        // Files go to a local folder, never to the object store a developer's shell may point at (S3_*).
        const saved: Record<string, string | undefined> = {};
        beforeAll(() => {
            for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'STORAGE_BACKEND', 'ARTIFACTS_LOCAL_DIR']) saved[k] = process.env[k];
            for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[k];
            process.env.STORAGE_BACKEND = 'local';
            process.env.ARTIFACTS_LOCAL_DIR = mkdtempSync(path.join(tmpdir(), 'gethugs-files-'));
        });
        afterAll(() => {
            if (process.env.ARTIFACTS_LOCAL_DIR?.includes('gethugs-files-')) rmSync(process.env.ARTIFACTS_LOCAL_DIR, { recursive: true, force: true });
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        });

        /** A running run of a daemon, with one ready run file. */
        async function run_with_file(text = 'quarterly numbers') {
            const run_id = `run-${uid()}`;
            const daemon_id = `daemon-${uid()}`;
            const workspace_id = `ws-${uid()}`;
            await Daemon.create({ id: daemon_id, api_key_hash: 'h', hostname: 'd', ip: '127.0.0.1', port: 4900, public_url: 'http://127.0.0.1:4900', status: 'online', last_heartbeat: Date.now(), capacity: 5, created_at: Date.now(), last_registered_at: Date.now() } as never);
            await Workspace.create({ id: workspace_id, path: `/tmp/${workspace_id}`, created_at: Date.now(), updated_at: Date.now() } as never);
            await Run.create({ run_id, workspace_id, team_id: 't', state: 'running', started_at: Date.now(), realm_id: o.realm_id, daemon_id } as never);
            const bytes = Buffer.from(text);
            const file = await new ArtifactStorageService().upload({
                stream: Readable.from([bytes]), content_length: bytes.length, content_type: 'text/plain', name: 'report.txt',
                target: { kind: 'run', run_id, phase: 'review' }, uploaded_by: null,
            });
            return { run_id, daemon_id, file };
        }
        const attachment = (f: { artifact_id: string; name: string; size: number; content_type: string; sha256: string }) =>
            ({ artifact_id: f.artifact_id, name: f.name, size: f.size, content_type: f.content_type, sha256: f.sha256 });

        it('an attachment and an artifact block become one document of the workspace, uploaded once; a retry reuses it', async () => {
            const { run_id, daemon_id, file } = await run_with_file();
            const hug_id = randomUUID();
            const over = {
                attachments: [attachment(file)],
                params: { prompt: 'Approve?', context: [{ type: 'text', text: 'See the report' }, { type: 'artifact', artifact_id: file.artifact_id, title: 'Report' }] },
            };
            await open(over, { hug_id, run_id, daemon_id });
            expect(fake.documents).toHaveLength(1);
            const doc = fake.documents[0]!;
            expect([doc.name, new TextDecoder().decode(doc.bytes), doc.workspace_id]).toEqual(['report.txt', 'quarterly numbers', fake.hugs[0]!.workspace_id]);
            expect(fake.hugs[0]!.body.attachments).toEqual([{ document_id: doc.document_id }]);
            expect(fake.hugs[0]!.body.params.context).toEqual([{ type: 'text', text: 'See the report' }, { type: 'document', document_id: doc.document_id, title: 'Report' }]);
            // Core's row keeps cliq's own attachments.
            expect((await Hug.findByPk(hug_id, { raw: true }))!.attachments).toEqual([attachment(file)]);

            await Hug.destroy({ where: { id: hug_id } });
            await open(over, { hug_id, run_id, daemon_id });
            expect(fake.calls.filter((c) => c === 'documents/upload')).toHaveLength(1);
            await Run.destroy({ where: { run_id } });
        });

        it('files in an answer come back as ready run files of the Hug’s slots, in cliq’s shape; each once', async () => {
            const { run_id, daemon_id } = await run_with_file();
            const hug_id = randomUUID();
            await open({ files: [{ name: 'attachment' }, { name: 'docs', multiple: true }] }, { hug_id, run_id, daemon_id });
            const g_id = (await Hug.findByPk(hug_id, { raw: true }))!.gethugs_id!;
            const bob = fake.user_by_ref(fake.org_by_ref(`org:${o.org_id}`)!.id, `user:${o.bob.id}`)!.id;
            const one = fake.answer_file(g_id, 'attachment', 'notes.txt', 'hello from bob');
            const two = fake.answer_file(g_id, 'docs', 'a.txt', 'A');
            const three = fake.answer_file(g_id, 'docs', 'b.txt', 'BB');
            fake.respond(g_id, bob, { name: 'Bob', attachment: one, docs: [two, three] });
            const feed = fake.feed.filter((e) => e.type === 'hug.responded').at(-1)!;
            expect(await gethugs_apply(feed as never)).toBe(true);

            const [event] = await HugEventRow.findAll({ where: { hug_id }, raw: true });
            const values = (event!.payload as { response: { values: Record<string, any> } }).response.values;
            expect(values.name).toBe('Bob');
            expect(Object.keys(values.attachment).sort()).toEqual(['artifact_id', 'content_type', 'name', 'sha256', 'size']);
            expect(values.attachment).toMatchObject({ name: 'notes.txt', size: 14, content_type: 'text/plain' });
            expect(values.docs.map((d: { name: string; size: number }) => [d.name, d.size])).toEqual([['a.txt', 1], ['b.txt', 2]]);
            const stored = await StoredArtifact.findByPk(values.attachment.artifact_id, { raw: true });
            expect(stored).toMatchObject({ run_id, status: 'ready', source: 'hug', hug_id, hug_requested_input: 'attachment', uploaded_by: o.bob.id });
            const back = await new ArtifactStorageService().download(values.attachment.artifact_id, null);
            expect(Buffer.from(await new Response(back.body).arrayBuffer()).toString()).toBe('hello from bob');

            // The same event again: nothing stored again; a changed answer that keeps a file reuses its run file.
            const files_before = await StoredArtifact.count({ where: { hug_id } });
            expect(await gethugs_apply(feed as never)).toBe(false);
            fake.respond(g_id, bob, { name: 'Bob', attachment: one, docs: [] });
            await gethugs_apply(fake.feed.filter((e) => e.type === 'hug.responded').at(-1)! as never);
            expect(await StoredArtifact.count({ where: { hug_id } })).toBe(files_before);
            await Run.destroy({ where: { run_id } });
        });

        it('a file that can’t be downloaded leaves the answer unapplied — it comes again, files and all', async () => {
            const { run_id, daemon_id } = await run_with_file();
            const hug_id = randomUUID();
            await open({ files: [{ name: 'attachment' }] }, { hug_id, run_id, daemon_id });
            const g_id = (await Hug.findByPk(hug_id, { raw: true }))!.gethugs_id!;
            const bob = fake.user_by_ref(fake.org_by_ref(`org:${o.org_id}`)!.id, `user:${o.bob.id}`)!.id;
            fake.respond(g_id, bob, { name: 'Bob', attachment: fake.answer_file(g_id, 'attachment', 'n.txt', 'x') });
            const feed = fake.feed.filter((e) => e.type === 'hug.responded').at(-1)!;
            fake.fail_with = 503;
            await expect(gethugs_apply(feed as never)).rejects.toThrow();
            fake.fail_with = null;
            expect(await HugEventRow.count({ where: { hug_id } })).toBe(0);
            expect((await Hug.findByPk(hug_id, { raw: true }))!.gethugs_seq).toBe(0);
            expect(await gethugs_apply(feed as never)).toBe(true);
            expect(await HugEventRow.count({ where: { hug_id } })).toBe(1);
            await Run.destroy({ where: { run_id } });
        }, 60_000);

        it('a file that is not a ready file of the run is refused, as for Core’s own Hugs', async () => {
            const a = await run_with_file();
            const b = await run_with_file();
            await expect(open({ attachments: [attachment(a.file)] }, { run_id: b.run_id, daemon_id: b.daemon_id }))
                .rejects.toMatchObject({ status_code: 422, code: 'invalid_hug' });
            await expect(open({ params: { context: [{ type: 'artifact', artifact_id: a.file.artifact_id }] } }, { run_id: b.run_id, daemon_id: b.daemon_id }))
                .rejects.toMatchObject({ status_code: 422, code: 'invalid_hug' });
            expect(fake.documents).toHaveLength(0);
            await Run.destroy({ where: { run_id: [a.run_id, b.run_id] } });
        });
    });

    describe('close, progress, the run’s end', () => {
        it('the daemon that opened it closes it in getHugs; Core’s row takes getHugs’ status; another daemon may not', async () => {
            const { hug_id } = await open();
            await expect(HugsService.close({ hug_id, outcome: 'approved', daemon_id: 'other' })).rejects.toMatchObject({ status_code: 403 });
            expect(await HugsService.close({ hug_id, outcome: 'approved', daemon_id: 'daemon-1' })).toEqual({ status: 'closed' });
            expect(fake.hugs[0]).toMatchObject({ status: 'closed', outcome: 'approved' });
            expect((await Hug.findByPk(hug_id, { raw: true }))!).toMatchObject({ status: 'closed', outcome: 'approved' });
        });

        it('progress goes to getHugs', async () => {
            const run_id = `run-${uid()}`;
            const { hug_id } = await open({}, { run_id });
            await HugsService.set_progress(run_id, 'daemon-1', hug_id, '  2 of 3   answered ');
            expect(fake.hugs[0]!.progress).toBe('2 of 3 answered');
            // Not the daemon that opened it: ignored, as today.
            await HugsService.set_progress(run_id, 'other', hug_id, 'nope');
            expect(fake.hugs[0]!.progress).toBe('2 of 3 answered');
        });

        it('the run’s end cancels its open Hugs with one call by ref_id; again, nothing to do', async () => {
            const run_id = `run-${uid()}`;
            await open({}, { run_id });
            await open({}, { run_id });
            const other = await open();
            expect(await HugsService.cancel_for_run(run_id)).toBe(2);
            expect(fake.calls.filter((c) => c === 'hugs/cancel')).toHaveLength(1);
            expect(fake.hugs.map((h) => h.status)).toEqual(['cancelled', 'cancelled', 'open']);
            expect(await Hug.count({ where: { run_id, status: 'cancelled' } })).toBe(2);
            expect((await Hug.findByPk(other.hug_id, { raw: true }))!.status).toBe('open');
            expect(await HugsService.cancel_for_run(run_id)).toBe(0);
            expect(fake.calls.filter((c) => c === 'hugs/cancel')).toHaveLength(1);
        });

        it('the crash paths end a run’s Hugs too: a daemon restart (crash_stale) and the reaper', async () => {
            const make_run = async () => {
                const run_id = `run-${uid()}`;
                const daemon_id = `daemon-${uid()}`;
                const workspace_id = `ws-${uid()}`;
                await Daemon.create({ id: daemon_id, api_key_hash: 'h', hostname: 'd', ip: '127.0.0.1', port: 4900, public_url: 'http://127.0.0.1:4900', status: 'online', last_heartbeat: Date.now(), capacity: 5, created_at: Date.now(), last_registered_at: Date.now() } as never);
                await Workspace.create({ id: workspace_id, path: `/tmp/${workspace_id}`, created_at: Date.now(), updated_at: Date.now() } as never);
                await Run.create({ run_id, workspace_id, team_id: 't', state: 'running', started_at: Date.now(), realm_id: o.realm_id, daemon_id } as never);
                await open({}, { run_id, daemon_id });
                return { run_id, daemon_id };
            };
            const a = await make_run();
            expect(await RunService.crash_stale(a.daemon_id)).toBe(1);
            expect((await Hug.findOne({ where: { run_id: a.run_id }, raw: true }))!.status).toBe('cancelled');

            const b = await make_run();
            expect(await crash_and_emit(`"run_id" = :run_id`, { run_id: b.run_id }, 'lease expired')).toBe(1);
            expect((await Hug.findOne({ where: { run_id: b.run_id }, raw: true }))!.status).toBe('cancelled');
            expect(fake.hugs.map((h) => h.status)).toEqual(['cancelled', 'cancelled']);
            await Run.destroy({ where: { run_id: [a.run_id, b.run_id] } });
            await Daemon.destroy({ where: { id: [a.daemon_id, b.daemon_id] } });
        });
    });

    describe('events from getHugs (PLAN-gethugs-step4-answers.md)', () => {
        const events = async (hug_id: string) => (await HugEventRow.findAll({ where: { hug_id }, order: [['seq', 'ASC']], raw: true }))
            .map((e) => ({ seq: e.seq, type: e.type, payload: e.payload }));
        const delivered = async (hug_id: string) => {
            const [rows] = await get_sequelize().query(
                `SELECT payload FROM cliq.command_outbox WHERE endpoint = '/v1/hugs/deliver' AND payload::jsonb->>'hug_id' = :hug_id ORDER BY created_at, (payload::jsonb->>'seq')::int`,
                { replacements: { hug_id } },
            );
            return (rows as Array<{ payload: unknown }>).map((r) => {
                const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as { type: string; seq: number };
                return `${p.seq}:${p.type}`;
            });
        };
        const g = async (hug_id: string) => (await Hug.findByPk(hug_id, { raw: true }))!.gethugs_id!;
        const responded = (gethugs_id: string, seq: number, values: Record<string, unknown>) => ({
            type: 'hug.responded', hug: { id: gethugs_id }, seq,
            response: {
                response_id: `rsp_${seq}`, responder: { user_id: 'usr_bob', name: 'Bob in getHugs', external: { source: 'cliqhub', id: `user:${o.bob.id}` } },
                via: ['reviewers'], values, summary: 'Approved', responded_at: 1_795_400_000_000, changed: seq > 1,
            },
        });

        it('an answer reaches the daemon as a response by the cliq person; the same event twice is applied once; a changed answer is its own', async () => {
            const { hug_id } = await open();
            const id = await g(hug_id);
            expect(await gethugs_apply(responded(id, 1, { approved: true }))).toBe(true);
            expect(await gethugs_apply(responded(id, 1, { approved: true }))).toBe(false);
            expect(await gethugs_apply(responded(id, 2, { approved: false }))).toBe(true);
            const got = await events(hug_id);
            expect(got.map((e) => `${e.seq}:${e.type}`)).toEqual(['1:response', '2:response']);
            expect(got[0]!.payload).toEqual({ response: {
                response_id: 'rsp_1', responder: { user_id: o.bob.id, name: o.bob.username }, via: ['reviewers'],
                values: { approved: true }, summary: 'Approved', responded_at: new Date(1_795_400_000_000).toISOString(),
            } });
            expect(await delivered(hug_id)).toEqual(['1:response', '2:response']);
            expect((await Hug.findByPk(hug_id, { raw: true }))!.gethugs_seq).toBe(2);
        });

        it('expired reaches the daemon once; anything after the Hug ended is not delivered', async () => {
            const { hug_id } = await open();
            const id = await g(hug_id);
            expect(await gethugs_apply({ type: 'hug.expired', hug: { id }, seq: 1 })).toBe(true);
            expect((await Hug.findByPk(hug_id, { raw: true }))!.status).toBe('expired');
            await gethugs_apply({ type: 'hug.cancelled', hug: { id }, seq: 2, reason: 'late' });
            await gethugs_apply(responded(id, 3, { approved: true }));
            expect(await delivered(hug_id)).toEqual(['1:expired']);
        });

        it('the run’s end tells the daemon once; getHugs’ own cancel event then changes nothing', async () => {
            const run_id = `run-${uid()}`;
            const { hug_id } = await open({}, { run_id });
            await HugsService.cancel_for_run(run_id);
            expect(await delivered(hug_id)).toEqual(['1:cancelled']);
            expect((await events(hug_id))[0]!.payload).toEqual({ reason: 'The run ended' });
            await gethugs_apply({ type: 'hug.cancelled', hug: { id: await g(hug_id) }, seq: 1, reason: 'The run ended' });
            expect(await delivered(hug_id)).toEqual(['1:cancelled']);
        });

        it('a cancel in getHugs (not the run’s end) reaches the daemon with its reason; closed and other events tell it nothing', async () => {
            const { hug_id } = await open();
            const id = await g(hug_id);
            expect(await gethugs_apply({ type: 'hug.reminded', hug: { id }, seq: null })).toBe(false);
            expect(await gethugs_apply({ type: 'hug.cancelled', hug: { id }, seq: 1, reason: 'Not needed' })).toBe(true);
            expect((await events(hug_id)).map((e) => [e.type, e.payload])).toEqual([['cancelled', { reason: 'Not needed' }]]);

            const other = await open();
            await HugsService.close({ hug_id: other.hug_id, outcome: 'done', daemon_id: 'daemon-1' });
            await gethugs_apply({ type: 'hug.closed', hug: { id: await g(other.hug_id) }, seq: null, outcome: 'done' });
            expect(await delivered(other.hug_id)).toEqual([]);
            expect(await gethugs_apply({ type: 'hug.responded', hug: { id: 'hug_not_ours' }, seq: 1 })).toBe(false);
        });
    });

    describe('the feed reader (PLAN-gethugs-step4-answers.md)', () => {
        const delivered = async (hug_id: string) => {
            const [rows] = await get_sequelize().query(
                `SELECT payload FROM cliq.command_outbox WHERE endpoint = '/v1/hugs/deliver' AND payload::jsonb->>'hug_id' = :hug_id ORDER BY created_at, (payload::jsonb->>'seq')::int`,
                { replacements: { hug_id } },
            );
            return (rows as Array<{ payload: unknown }>).map((r) => {
                const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as { type: string; seq: number };
                return `${p.seq}:${p.type}`;
            });
        };
        const g = async (hug_id: string) => (await Hug.findByPk(hug_id, { raw: true }))!.gethugs_id!;
        const bob_in_gethugs = () => fake.user_by_ref(fake.org_by_ref(`org:${o.org_id}`)!.id, `user:${o.bob.id}`)!.id;
        const read = () => run_gethugs_feed(gethugs_partner()!, { wait_s: 0 });
        const set_cursor = (cursor: string | null) => cursor === null
            ? get_sequelize().query(`DELETE FROM cliq.settings WHERE key = 'gethugs.feed_cursor'`)
            : get_sequelize().query(`UPDATE cliq.settings SET value = :cursor WHERE key = 'gethugs.feed_cursor'`, { replacements: { cursor } });

        beforeEach(async () => { await set_cursor(null); });
        afterAll(async () => { await set_cursor(null); });

        it('starts from now (recovering open Hugs), then applies each answer once; a restart that re-reads applies nothing twice', async () => {
            const { hug_id } = await open();
            fake.respond(await g(hug_id), bob_in_gethugs(), { approved: true });
            // No cursor yet: the feed starts at its end, and the open Hug re-reads its own events.
            expect(await read()).toMatchObject({ ran: true, recovered: true, applied: 1 });
            expect(await delivered(hug_id)).toEqual(['1:response']);

            fake.respond(await g(hug_id), bob_in_gethugs(), { approved: false });
            expect(await read()).toMatchObject({ applied: 1, recovered: false });
            expect(await delivered(hug_id)).toEqual(['1:response', '2:response']);

            await set_cursor('0');
            expect(await read()).toMatchObject({ applied: 0 });
            expect(await delivered(hug_id)).toEqual(['1:response', '2:response']);
        });

        it('an answer given before Core stored its row arrives with the catch-up after create, once', async () => {
            await read();
            fake.on_create = (h) => fake.respond(h.id, bob_in_gethugs(), { approved: true });
            const { hug_id } = await open();
            fake.on_create = null;
            expect(await delivered(hug_id)).toEqual(['1:response']);
            await read();
            expect(await delivered(hug_id)).toEqual(['1:response']);
        });

        it('an expired cursor: start again from now and re-read the open Hugs — what came meanwhile arrives once', async () => {
            const { hug_id } = await open();
            await read();
            fake.respond(await g(hug_id), bob_in_gethugs(), { approved: true });
            fake.expire(await g(hug_id));
            fake.feed_kept_from = fake.feed.length + 1;
            expect(await read()).toMatchObject({ recovered: true, applied: 2 });
            expect(await delivered(hug_id)).toEqual(['1:response', '2:expired']);
            expect(await read()).toMatchObject({ applied: 0 });
        });

        it('one reader: while another process holds the lock, nothing is read; other callers’ Hugs are skipped', async () => {
            const other = new pg.Client({ connectionString: database_url });
            await other.connect();
            try {
                await other.query('SELECT pg_advisory_lock($1)', [GETHUGS_FEED_LOCK_KEY]);
                expect(await read()).toEqual({ ran: false, applied: 0, recovered: false });
                await other.query('SELECT pg_advisory_unlock($1)', [GETHUGS_FEED_LOCK_KEY]);
            } finally {
                await other.end();
            }
            await read();
            fake.feed.push({ id: 'evt_x', type: 'hug.responded', seq: 1, hug: { id: 'hug_someone_elses', ref_id: null, status: 'open' } });
            expect(await read()).toMatchObject({ ran: true, applied: 0 });
        });
    });
});
