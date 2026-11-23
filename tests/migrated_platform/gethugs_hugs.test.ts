/**
 * PLAN-gethugs-step3-asking.md sub-step 2: an org's Hug is created in getHugs (a fake one) — built-in templates
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
import { HugBundlesService } from '../../src/services/hug_bundles.service.js';
import { HugsGetInput } from '../../src/schemas/hug_types.js';
import { gethugs_sign_in_link } from '../../src/services/gethugs_sign_in.js';
import { calculateJwkThumbprint, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { gethugs_apply } from '../../src/services/gethugs_events.js';
import { GETHUGS_FEED_LOCK_KEY, run_gethugs_feed } from '../../src/services/gethugs_feed.js';
import pg from 'pg';
import { database_url } from './helpers/control_plane_store.js';
import { HugBundle, HugEventRow } from '../../src/models/index.js';
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
    /** An org reconciled into the fake getHugs: owner, Bob (member of realm `ops`), channel `reviewers` in `ops`. */
    async function reconciled_org() {
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
        await gethugs_reconcile(org.id, gethugs_partner());
        return { org_id: org.id, realm_id: ops.id, bob };
    }
    const spec = (over: Record<string, unknown> = {}) => ({
        hug: { name: 'approval' },
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
        o = await reconciled_org();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
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
        expect(row).toMatchObject({ gethugs_id: h.id, status: 'open', run_id, hug_name: 'approval', hug_sha256: null });
        expect(row.gethugs_workspace_id).toBe(h.workspace_id);

        // A retry with the same id: the same Hug, also when Core lost its row (getHugs' Idempotency-Key).
        expect(await open({}, { hug_id, run_id })).toEqual(out);
        await Hug.destroy({ where: { id: hug_id } });
        expect(await open({ channels: ['All realm members', o.bob.username, 'reviewers'] }, { hug_id, run_id })).toEqual(out);
        expect(fake.hugs).toHaveLength(1);
    });

    it('a name without a bundle hash that isn’t a getHugs built-in is refused, naming the built-ins (PLAN-gethugs-step8-cutover.md decision 3)', async () => {
        const err = await open({ hug: { name: 'nope' } }).catch((e: unknown) => e) as { status_code: number; code: string; message: string };
        expect(err).toMatchObject({ status_code: 422, code: 'unknown_hug' });
        expect(err.message).toMatch(/'nope' isn't one of getHugs' built-in hugs \(.*approval.*\)/);
        expect(fake.hugs).toHaveLength(0);
        expect((await HugsService.create({
            hug_id: randomUUID(), run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id: o.realm_id, phase: 'review', iteration: 1,
            spec: { ...spec(), hug: { name: 'approval', sha256: 'b'.repeat(64) } }, actor_id: null,
        } as never)).hug_url).toMatch(/^http:\/\/app\.gethugs\.test\/hugs\//);
        expect(fake.hugs.at(-1)!.template).toBe('tpl_approval');
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

        const bare = await reconciled_org();
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

    it('refuses an invalid spec, one without an expiry, and one from an older cliq (templates): 422', async () => {
        await expect(open({ files: [{ name: 'x' }, { name: 'x' }] })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining("'x' is listed twice") });
        await expect(open({ params: { big: 'x'.repeat(257 * 1024) } })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining('params is larger') });
        await expect(open({ hug: { name: 'Bad Name' } })).rejects.toMatchObject({ status_code: 422 });
        await expect(open({ expires_in_min: undefined })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining('expires') });
        await expect(open({ expires_in_min: 10_081 })).rejects.toMatchObject({ status_code: 422 });
        await expect(open({ hug: undefined, template: 'form' })).rejects.toMatchObject({ status_code: 422, code: 'invalid_hug', message: expect.stringContaining('update cliq') });
        expect(fake.hugs).toHaveLength(0);
    });

    it('a run’s Hugs (hugs/get { run_id }): every round of every phase, oldest first, any status, with iteration and outcome', async () => {
        const run_id = `run-${uid()}`;
        const round1 = await open({}, { run_id, phase: 'review', iteration: 0 });
        await HugsService.close({ hug_id: round1.hug_id, outcome: 'Rejected by Ann', daemon_id: 'daemon-1' });
        await Hug.update({ outcome: 'Rejected by Ann' }, { where: { id: round1.hug_id } });
        const round2 = await open({}, { run_id, phase: 'review', iteration: 1 });
        const other = await open({}, { run_id: `run-${uid()}` });
        const { hugs, total } = await HugsService.list_for_run({ user_id: o.bob.id, run_id });
        expect(total).toBe(2);
        expect(hugs.map((h) => [h.hug_id, h.phase, h.iteration, h.status, h.outcome])).toEqual([
            [round1.hug_id, 'review', 0, 'closed', 'Rejected by Ann'],
            [round2.hug_id, 'review', 1, 'open', null],
        ]);
        expect(hugs.some((h) => h.hug_id === other.hug_id)).toBe(false);
        expect((await HugsService.list_for_run({ user_id: o.bob.id, run_id, statuses: ['open'] })).hugs.map((h) => h.hug_id)).toEqual([round2.hug_id]);
        expect(HugsGetInput.safeParse({ run_id }).success).toBe(true);
        expect(HugsGetInput.safeParse({}).success).toBe(false);
    });

    it('unused team hug bundles are swept; those of open or recently closed Hugs, new ones and just-resolved ones stay', async () => {
        const day = 24 * 60 * 60 * 1000;
        const stored = async (name: string) => {
            const { sha256 } = await HugBundlesService.store(bundle_of(name, uid()), null);
            await HugBundle.update({ created_at: new Date(Date.now() - 2 * day), last_used_at: new Date(Date.now() - 2 * day) }, { where: { sha256 } });
            return sha256;
        };
        const unused = await stored('sweep-unused');
        const old_closed = await stored('sweep-old');
        const recent_closed = await stored('sweep-recent');
        const old_open = await stored('sweep-open');
        const fresh = (await HugBundlesService.store(bundle_of('sweep-fresh', uid()), null)).sha256;
        // Old, but a Hug being opened just resolved it (its row isn't written yet): it stays.
        const resolving = await stored('sweep-resolving');
        await HugBundlesService.resolve({ name: 'sweep-resolving', sha256: resolving }, { may_upload: false, realm_id: 'r' });
        for (const [sha256, days] of [[old_closed, 100], [recent_closed, 10]] as const) {
            const { hug_id } = await open();
            await Hug.update({ hug_sha256: sha256, status: 'closed', closed_at: new Date(Date.now() - days * day) }, { where: { id: hug_id } });
        }
        // An open Hug keeps its bundle however old both are.
        const { hug_id: open_id } = await open();
        await Hug.update({ hug_sha256: old_open, created_at: new Date(Date.now() - 200 * day) }, { where: { id: open_id } });
        expect(await HugBundlesService.sweep_unused()).toBeGreaterThanOrEqual(2);
        const left = (await HugBundle.findAll({ where: { sha256: [unused, old_closed, recent_closed, old_open, fresh, resolving] }, raw: true })).map((b) => b.sha256);
        expect(left.sort()).toEqual([recent_closed, old_open, fresh, resolving].sort());
        expect(await HugBundlesService.read_files(unused)).toBeNull();
        expect(await HugBundlesService.read_files(recent_closed)).not.toBeNull();
    });

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
            expect(Object.keys(values.attachment).sort()).toEqual(['artifact_id', 'content_type', 'document_id', 'name', 'sha256', 'size']);
            expect(values.attachment).toMatchObject({ document_id: one.document_id, name: 'notes.txt', size: 14, content_type: 'text/plain' });
            expect(values.docs.map((d: { name: string; size: number }) => [d.name, d.size])).toEqual([['a.txt', 1], ['b.txt', 2]]);
            const stored = await StoredArtifact.findByPk(values.attachment.artifact_id, { raw: true });
            expect(stored).toMatchObject({ run_id, source: 'hug', hug_id, hug_requested_input: 'attachment', uploaded_by: o.bob.id });
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

        it('a file that is not a file of the run is refused', async () => {
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

        it('Core’s reads (PLAN-gethugs-step6-ui-link.md): the getHugs page, each person’s latest answer, responded', async () => {
            const run_id = `run-${uid()}`;
            const { hug_id } = await open({}, { run_id });
            const id = await g(hug_id);
            await gethugs_apply(responded(id, 1, { approved: true }));
            await gethugs_apply(responded(id, 2, { approved: false }));

            const detail = await HugsService.get(hug_id);
            expect(detail.hug_url).toBe(`http://app.gethugs.test/hugs/${id}`);
            expect(detail.responses).toEqual([{
                response_id: 'rsp_2', responder: { user_id: o.bob.id, name: o.bob.username }, via: ['reviewers'],
                values: { approved: false }, summary: 'Approved', responded_at: new Date(1_795_400_000_000).toISOString(),
            }]);
            expect(detail).not.toHaveProperty('viewer');

            const list = await HugsService.list_for_run({ user_id: o.bob.id, run_id });
            expect(list.hugs.map((h) => [h.hug_url, h.responded])).toEqual([[`http://app.gethugs.test/hugs/${id}`, true]]);
            const others = await HugsService.list_for_run({ user_id: (await person()).id, run_id }).catch(() => ({ hugs: [] }));
            expect(others.hugs.every((h) => !h.responded)).toBe(true);
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
        it('a daemon catches up on its own Hugs only: events after each cursor, and each Hug’s status', async () => {
            const mine = await open();
            const other = await open({}, { daemon_id: 'daemon-2' });
            await gethugs_apply(responded(await g(mine.hug_id), 1, { approved: true }));
            await gethugs_apply(responded(await g(mine.hug_id), 2, { approved: false }));
            await gethugs_apply(responded(await g(other.hug_id), 1, { approved: true }));
            const out = await HugsService.get_events({ daemon_id: 'daemon-1', cursors: [{ hug_id: mine.hug_id, after_seq: 1 }, { hug_id: other.hug_id, after_seq: 0 }] });
            expect(out.events.map((e) => [e.hug_id, e.seq, e.type])).toEqual([[mine.hug_id, 2, 'response']]);
            expect(out.hugs).toEqual([{ hug_id: mine.hug_id, status: 'open', last_seq: 2 }]);
            expect(out.has_more).toBe(false);
        });

        it('the events of Hugs that ended more than 7 days ago are deleted; an ended Hug still reports how it ended', async () => {
            const old = await open();
            const recent = await open();
            for (const h of [old, recent]) {
                await gethugs_apply(responded(await g(h.hug_id), 1, { approved: true }));
                await HugsService.close({ hug_id: h.hug_id, outcome: 'done', daemon_id: 'daemon-1' });
            }
            await Hug.update({ closed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }, { where: { id: old.hug_id } });
            expect(await HugsService.delete_old_events()).toBeGreaterThanOrEqual(1);
            expect(await HugEventRow.count({ where: { hug_id: old.hug_id } })).toBe(0);
            expect(await HugEventRow.count({ where: { hug_id: recent.hug_id } })).toBe(1);
            const out = await HugsService.get_events({ daemon_id: 'daemon-1', cursors: [{ hug_id: old.hug_id, after_seq: 0 }] });
            expect(out.events).toEqual([]);
            expect(out.hugs).toEqual([{ hug_id: old.hug_id, status: 'closed', last_seq: 1 }]);
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

    describe('sign-in links (PLAN-gethugs-step7-sign-in.md)', () => {
        let public_key: CryptoKey;
        let kid: string;
        beforeAll(async () => {
            const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
            public_key = pair.publicKey as CryptoKey;
            kid = await calculateJwkThumbprint(await exportJWK(pair.publicKey));
            process.env.GETHUGS_SIGNIN_JWK = JSON.stringify(await exportJWK(pair.privateKey));
            process.env.GETHUGS_PARTNER_ID = 'prt_test';
        });
        afterAll(() => {
            delete process.env.GETHUGS_SIGNIN_JWK;
            delete process.env.GETHUGS_PARTNER_ID;
        });
        const statement_of = (url: string) => {
            expect(url.startsWith('http://app.gethugs.test/sign-in/statement#')).toBe(true);
            return url.split('#')[1]!;
        };

        it('a Hug: a statement for the person, landing on its getHugs page — exactly getHugs’ claims, 60 s, once', async () => {
            const { hug_id } = await open();
            const g_id = (await Hug.findByPk(hug_id, { raw: true }))!.gethugs_id!;
            const { url } = await gethugs_sign_in_link({ user_id: o.bob.id, hug_id });
            const jws = statement_of(url);
            expect(decodeProtectedHeader(jws)).toEqual({ alg: 'EdDSA', kid });
            const { payload } = await jwtVerify(jws, public_key, { issuer: 'prt_test', audience: 'http://app.gethugs.test' });
            expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iss', 'jti', 'next', 'org', 'src', 'sub']);
            expect(payload).toMatchObject({ src: 'cliqhub', org: `org:${o.org_id}`, sub: `user:${o.bob.id}`, next: `/hugs/${g_id}` });
            expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
            const again = statement_of((await gethugs_sign_in_link({ user_id: o.bob.id, hug_id })).url);
            expect((await jwtVerify(again, public_key)).payload.jti).not.toBe(payload.jti);
        });

        it('the inbox of an org: next /hugs', async () => {
            const { url } = await gethugs_sign_in_link({ user_id: o.bob.id, org_id: o.org_id });
            expect((await jwtVerify(statement_of(url), public_key)).payload).toMatchObject({ next: '/hugs', org: `org:${o.org_id}` });
        });

        it('refused: someone who can’t see the Hug, a non-member, a person not in getHugs yet; no key here is an error', async () => {
            const { hug_id } = await open();
            const stranger = await person();
            await expect(gethugs_sign_in_link({ user_id: stranger.id, hug_id })).rejects.toMatchObject({ status_code: 404 });
            await expect(gethugs_sign_in_link({ user_id: stranger.id, org_id: o.org_id })).rejects.toMatchObject({ status_code: 403 });
            // A member cliqhub hasn't provisioned to getHugs yet.
            await OrgMember.create({ org_id: o.org_id, user_id: stranger.id, role: 'member', status: 'active', joined_at: new Date() } as never);
            await expect(gethugs_sign_in_link({ user_id: stranger.id, org_id: o.org_id })).rejects.toMatchObject({ status_code: 409, code: 'not_in_gethugs' });
            const saved = process.env.GETHUGS_SIGNIN_JWK;
            delete process.env.GETHUGS_SIGNIN_JWK;
            delete process.env.GETHUGS_PARTNER_ID;
            try {
                await expect(gethugs_sign_in_link({ user_id: o.bob.id, org_id: o.org_id })).rejects.toThrow(/Missing required env var/);
            } finally {
                process.env.GETHUGS_SIGNIN_JWK = saved;
                process.env.GETHUGS_PARTNER_ID = 'prt_test';
            }
        });
    });
});
