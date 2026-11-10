/**
 * Hugs — Core's side of the one protocol for asking people (PLAN-hug-requests §6, §9).
 *
 * Covers: create (the envelope, bundles stored once by hash — BUNDLE_MISSING / BUNDLE_INVALID /
 * BUNDLE_REJECTED, built-ins are ordinary hugs, a `template` spec refused, a pre-hug Hug has no hug; channels resolved, unknown
 * channels raised, none left → 422, a retried create adopts its id, attachments must be the run's), who may respond (their own channel; a
 * shared channel only for people who can see the realm), values never interpreted (only uploads
 * under upload slots; a one-line summary), a response replaced
 * keeps one row with a new seq, file values must be the responder's uploads, the event stream and
 * its delivery (deliver_until), closed and expired Hugs refuse answers (the clock counts, not just
 * the status — checked again inside the write), a response stored only with its delivery, file
 * reuse on resubmit, only the opening daemon closes, get_events catch-up (own Hugs only, terminal
 * status), old events deleted after 7 days, cancel_for_run, expiry and reminders, and the inbox list.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

vi.mock('../../src/auth/password.js', () => ({
	hash_password: vi.fn().mockResolvedValue('hash'),
	verify_password: vi.fn().mockResolvedValue(true),
}));

import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { HugsService } from '../../src/services/hugs.service.js';
import { HugBundlesService } from '../../src/services/hug_bundles.service.js';
import { HugsRespondInput } from '../../src/schemas/hug_types.js';
import { hug_bundle_hash } from '@getcliqio/cliq-sdk';
import { HugPendingService } from '../../src/services/hug_pending.service.js';
import { ArtifactsController } from '../../src/controllers/artifacts_controller.js';
import { RealmService } from '../../src/services/realm.service.js';
import { REALM_MEMBERS_CHANNEL_NAME } from '../../src/notifications/defaults.js';
import { ensure_personal_channel } from '../../src/services/per_user_channel.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import {
	Hug, HugBundle, HugDelivery, HugEventRow, HugResponse, HubEvent, OrgMember, OrgRole, Realm, RealmMember, StoredArtifact, User,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const OUTSIDER = hub_legacy_uuid(9_999);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** A minimal valid bundle of a hug called `name` (`tag` changes its hash). */
const bundle_of = (name: string, tag = '') => ({
	'hug.json': JSON.stringify({ name, title: `The ${name} hug`, entry: 'index.html', sdk_version: '0.1.0', definition: 'definition.mjs' }),
	'index.html': `<!doctype html><script type="module" src="./main.js"></script>${tag}`,
	'main.js': 'export {};',
	'definition.mjs': 'export default {};',
});
const RELEASE = bundle_of('release-name');
const RELEASE_SHA = hug_bundle_hash(RELEASE);
const SPEC = {
	hug: { name: 'release-name', sha256: RELEASE_SHA },
	title: 'Release name',
	summary: 'What should this release be called?',
	params: { suggestions: ['autumn', 'winter'] },
	files: [{ name: 'contract', accept: ['application/pdf'] }],
	channels: [REALM_MEMBERS_CHANNEL_NAME],
	expires_in_min: 60,
};

describe.skipIf(!has_postgres)('Hugs (Core)', () => {
	let realm_id: string;
	let org_id: string;

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
		await HugBundlesService.store(RELEASE, null);
	});
	beforeEach(async () => {
		if (!has_postgres) return;
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status_code: 200 })));
		const realm = await RealmService.create(OWNER, `hug-${uid()}`.slice(0, 40), 'Hugs');
		realm_id = realm.id;
		org_id = String((await Realm.findByPk(realm_id, { raw: true }))!.org_id);
	});
	afterEach(() => { vi.unstubAllGlobals(); });
	afterAll(async () => {
		if (!has_postgres) return;
		await HugEventRow.destroy({ where: {} });
		await HugResponse.destroy({ where: {} });
		await HugDelivery.destroy({ where: {} });
		await Hug.destroy({ where: {} });
		await HugBundle.destroy({ where: {} });
		await get_sequelize().query(`DELETE FROM cliq."command_outbox" WHERE "endpoint" = '/v1/hugs/deliver'`);
		await OrgMember.destroy({ where: { user_id: people } as never });
		await User.destroy({ where: { id: people }, force: true } as never);
		await close_test_control_plane_store();
	});

	const open = (over: Record<string, unknown> = {}, input: Partial<Parameters<typeof HugsService.create>[0]> = {}) =>
		HugsService.create({
			run_id: `run-${uid()}`, daemon_id: 'daemon-1', realm_id, phase: 'release', iteration: 0,
			spec: { ...SPEC, ...over }, actor_id: OWNER, ...input,
		});
	const people: string[] = [];
	/** A realm member with a personal channel and an org role holding `permissions`. */
	const person = async (permissions: string[]) => {
		const n = people.length + 1;
		const id = hub_legacy_uuid(72_000 + n + Math.floor(Math.random() * 1000) * 10);
		const name = `hugp${Date.now().toString(36)}${n}`;
		people.push(id);
		await User.create({ id, username: name, email: `${name}@cliq.test`, status: 'active', role: 'user', password_hash: 'x' } as never);
		const role = await OrgRole.create({
			id: randomUUID(), org_id, slug: `r-${uid()}`.slice(0, 40), name: 'Custom', permissions, is_system: false, is_default: false, created_at: new Date(),
		} as never);
		await OrgMember.create({ org_id, user_id: id, role: 'member', role_id: role.id, status: 'active' } as never);
		await RealmMember.create({ id: `${realm_id}:${id}`, realm_id, member_type: 'user', member_id: id, role: 'member', created_at: Date.now() } as never);
		await ensure_personal_channel(id, name);
		return { id, name, role };
	};
	const deliveries = (hug_id: string) => get_sequelize().query<{ payload: string; deliver_until: string | null; daemon_id: string }>(
		`SELECT "payload"::text, "deliver_until", "daemon_id" FROM cliq."command_outbox" WHERE "endpoint" = '/v1/hugs/deliver' AND "payload"::jsonb->>'hug_id' = :hug_id ORDER BY "created_at"`,
		{ replacements: { hug_id }, type: QueryTypes.SELECT },
	);

	describe('create', () => {
		it('stores the Hug, one delivery row per destination, and returns its Hub URL', async () => {
			const { hug_id, hug_url } = await open();
			expect(hug_url).toMatch(new RegExp(`/hugs/${hug_id}$`));
			const hug = (await Hug.findByPk(hug_id, { raw: true }))!;
			expect(hug).toMatchObject({
				status: 'open', org_id, realm_id, channels: [REALM_MEMBERS_CHANNEL_NAME], last_seq: 0,
				hug_name: 'release-name', hug_sha256: RELEASE_SHA, summary: SPEC.summary, params: SPEC.params, files: SPEC.files, attachments: [],
			});
			expect(hug).not.toHaveProperty('template');
			expect(await HugsService.get(hug_id)).toMatchObject({
				hug: { name: 'release-name', sha256: RELEASE_SHA }, summary: SPEC.summary, params: SPEC.params, files: SPEC.files, attachments: [],
			});
			expect(await HugsService.get(hug_id)).not.toHaveProperty('template');
			expect(hug.expires_at.getTime() - hug.created_at.getTime()).toBe(60 * 60_000);
			const rows = await HugDelivery.findAll({ where: { hug_id }, raw: true });
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.channel === REALM_MEMBERS_CHANNEL_NAME)).toBe(true);
		});

		it('refuses an invalid spec and one without an expiry (422)', async () => {
			await expect(open({ files: [{ name: 'x' }, { name: 'x' }] })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining("'x' is listed twice") });
			await expect(open({ params: { big: 'x'.repeat(257 * 1024) } })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining('params is larger') });
			await expect(open({ hug: { name: 'Bad Name', sha256: RELEASE_SHA } })).rejects.toMatchObject({ status_code: 422 });
			await expect(open({ expires_in_min: undefined })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining('expires') });
			await expect(open({ expires_in_min: 10_081 })).rejects.toMatchObject({ status_code: 422 });
		});

		it('a spec from an older cliq (templates) is refused: update cliq', async () => {
			await expect(open({ hug: undefined, template: 'form' })).rejects.toMatchObject({ status_code: 422, code: 'invalid_hug', message: expect.stringContaining('update cliq') });
		});

		it('a bundle Core lacks: 409 BUNDLE_MISSING; the retry with the bundle from a daemon stores it once and opens the Hug', async () => {
			const files = bundle_of('review-batch', '<!-- v2 -->');
			const sha256 = hug_bundle_hash(files);
			const hug = { name: 'review-batch', sha256 };
			await expect(open({ hug })).rejects.toMatchObject({ status: 409, code: 'BUNDLE_MISSING', details: { sha256 } });
			await expect(open({ hug }, { bundle: files, may_upload_bundle: false })).rejects.toMatchObject({ status: 403, code: 'BUNDLE_REJECTED' });
			const { hug_id } = await open({ hug }, { bundle: files, may_upload_bundle: true });
			expect((await Hug.findByPk(hug_id, { raw: true }))!.hug_sha256).toBe(sha256);
			expect(await HugBundle.findByPk(sha256, { raw: true })).toMatchObject({ name: 'review-batch', realm_id, file_count: 4 });
			const page = await HugBundlesService.get_file(sha256, 'index.html');
			expect(page).toMatchObject({ content_type: 'text/html; charset=utf-8' });
			expect(page!.body.toString()).toContain('<!-- v2 -->');
			expect(await HugBundlesService.get_file(sha256, '../hug.json')).toBeNull();
			expect(await HugBundlesService.get_file(sha256, 'nope.js')).toBeNull();
			// Held now: the next Hug opens without it.
			await expect(open({ hug })).resolves.toBeTruthy();
		});

		it('a bad bundle is refused (422 BUNDLE_INVALID): a hash mismatch, broken rules, another name', async () => {
			const files = bundle_of('bad-one', '<!-- bad -->');
			const sha256 = hug_bundle_hash(files);
			const up = (bundle: Record<string, string>, hug = { name: 'bad-one', sha256 }) => open({ hug }, { bundle, may_upload_bundle: true });
			await expect(up({ ...files, 'main.js': 'changed' })).rejects.toMatchObject({ status: 422, code: 'BUNDLE_INVALID', details: { problems: [expect.stringContaining("doesn't hash")] } });
			const outside = { ...files, 'index.html': '<script src="https://cdn.example/x.js"></script>' };
			await expect(up(outside, { name: 'bad-one', sha256: hug_bundle_hash(outside) })).rejects.toMatchObject({ status: 422, code: 'BUNDLE_INVALID', details: { problems: [expect.stringContaining('outside URLs are blocked')] } });
			await expect(up(files, { name: 'other-name', sha256 })).rejects.toMatchObject({ status: 422, code: 'BUNDLE_INVALID', details: { problems: ["hug.json names 'bad-one', not 'other-name'"] } });
			expect(await HugBundle.count({ where: { name: 'bad-one' } })).toBe(0);
		});

		it('built-ins are ordinary hugs: every Hug names its bundle, and approval arrives like any other', async () => {
			await expect(open({ hug: { name: 'approval', sha256: null } })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining('hug.sha256') });
			const files = bundle_of('approval', `<!-- ${uid()} -->`);
			const hug = { name: 'approval', sha256: hug_bundle_hash(files) };
			await expect(open({ hug })).rejects.toMatchObject({ status: 409, code: 'BUNDLE_MISSING' });
			const { hug_id } = await open({ hug }, { bundle: files, may_upload_bundle: true });
			expect((await Hug.findByPk(hug_id, { raw: true }))).toMatchObject({ hug_name: 'approval', hug_sha256: hug.sha256 });
		});

		it('a Hug opened before hugs (no hug) is returned with hug: null, for the fallback view', async () => {
			const { hug_id } = await open();
			await Hug.update({ hug_name: null, hug_sha256: null }, { where: { id: hug_id } });
			expect((await HugsService.get(hug_id)).hug).toBeNull();
		});

		it('raises Unknown channel for names the realm cannot use; none left → 422', async () => {
			const run_id = `run-${uid()}`;
			const { hug_id } = await open({ channels: [REALM_MEMBERS_CHANNEL_NAME, 'no-such-channel'] }, { run_id });
			expect(hug_id).toBeTruthy();
			const notices = await HubEvent.findAll({ where: { type: 'notification.unknown_channel', run_id }, raw: true });
			expect(notices.map((n) => n.message)).toEqual([expect.stringContaining("'no-such-channel'")]);
			await expect(open({ channels: ['nope-1', 'nope-2'] })).rejects.toMatchObject({ status_code: 422 });
			await expect(open({ channels: [] })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining('names no hug channel') });
		});

		it("a Hug that reaches nobody who could answer is refused (422 no_one_can_answer); with runs.view it opens", async () => {
			const p = await person(['realms.view']);
			await expect(open({ channels: [p.name] })).rejects.toMatchObject({
				status_code: 422, code: 'no_one_can_answer', message: expect.stringContaining(`${p.name} (via '${p.name}')`),
			});
			expect(await Hug.count({ where: { realm_id } })).toBe(0);
			await OrgRole.update({ permissions: ['realms.view', 'runs.view'] } as never, { where: { id: p.role.id } });
			const { hug_id } = await open({ channels: [p.name] });
			expect((await HugDelivery.findAll({ where: { hug_id }, raw: true })).map((d) => d.user_id)).toEqual([p.id]);
			expect((await HugsService.get(hug_id)).not_sent_to).toEqual([]);
		});

		it('people, not channels, and transitively: a realm member without runs.view is left out of "All realm members", recorded, and an admin notice is raised once per run', async () => {
			const p = await person(['realms.view']);
			const run_id = `run-${uid()}`;
			const { hug_id } = await open({}, { run_id });
			expect((await HugsService.get(hug_id)).not_sent_to).toEqual([{ name: p.name, channel: REALM_MEMBERS_CHANNEL_NAME }]);
			await open({}, { run_id }); // the gate loops: no second notice
			const notices = await HubEvent.findAll({ where: { type: 'notification.no_access', run_id }, raw: true });
			expect(notices).toHaveLength(1);
			expect(notices[0]!.message).toBe(`'${REALM_MEMBERS_CHANNEL_NAME}' reaches ${p.name}, who can't view runs in this realm — nothing was sent to them.`);
		});

		it("follows channel_ref; a channel that also reaches people Core can't name (Slack) opens, recording who was left out", async () => {
			const p = await person(['realms.view']);
			const relay = `relay-${uid()}`.slice(0, 40);
			await NotificationService.create_channel({ realm_id, name: relay, destinations: [{ type: 'channel_ref', name: p.name }] });
			await expect(open({ channels: [relay] })).rejects.toMatchObject({ status_code: 422, code: 'no_one_can_answer', message: expect.stringContaining(`via '${relay}'`) });
			const mixed = `mixed-${uid()}`.slice(0, 40);
			await NotificationService.create_channel({ realm_id, name: mixed, destinations: [{ type: 'channel_ref', name: p.name }, { type: 'slack', webhook_url: 'https://hooks.slack.test/x' }] });
			const { hug_id } = await open({ channels: [mixed] });
			expect((await HugsService.get(hug_id)).not_sent_to).toEqual([{ name: p.name, channel: mixed }]);
		});

		it('a retried create adopts its daemon-minted id', async () => {
			const run_id = `run-${uid()}`;
			const hug_id = `h-${uid()}`;
			const first = await open({}, { run_id, hug_id });
			const again = await open({}, { run_id, hug_id });
			expect(again.hug_id).toBe(first.hug_id);
			expect(await Hug.count({ where: { id: hug_id } })).toBe(1);
			await expect(open({}, { run_id: `run-${uid()}`, hug_id })).rejects.toMatchObject({ status_code: 409 });
		});

		it('unused bundles are swept (built-ins too); those of open or recently closed Hugs, new ones and just-resolved ones stay', async () => {
			const day = 24 * 60 * 60 * 1000;
			const stored = async (name: string) => {
				const { sha256 } = await HugBundlesService.store(bundle_of(name, `<!-- ${uid()} -->`), null);
				await HugBundle.update({ created_at: new Date(Date.now() - 2 * day), last_used_at: new Date(Date.now() - 2 * day) }, { where: { sha256 } });
				return sha256;
			};
			const unused = await stored('sweep-unused');
			const old_closed = await stored('sweep-old');
			const recent_closed = await stored('sweep-recent');
			const old_open = await stored('sweep-open');
			const builtin = await stored('form');
			const fresh = (await HugBundlesService.store(bundle_of('sweep-fresh', `<!-- ${uid()} -->`), null)).sha256;
			// Old, but a Hug being opened just resolved it (its row isn't written yet): it stays.
			const resolving = await stored('sweep-resolving');
			await HugBundlesService.resolve({ name: 'sweep-resolving', sha256: resolving }, { may_upload: false, realm_id: 'r' });
			for (const [sha256, days] of [[old_closed, 100], [recent_closed, 10]] as const) {
				const { hug_id } = await open({ hug: { name: 'x', sha256: RELEASE_SHA } });
				await Hug.update({ hug_sha256: sha256, status: 'closed', closed_at: new Date(Date.now() - days * day) }, { where: { id: hug_id } });
			}
			// An open Hug keeps its bundle however old both are.
			const { hug_id: open_id } = await open({ hug: { name: 'x', sha256: RELEASE_SHA } });
			await Hug.update({ hug_sha256: old_open, created_at: new Date(Date.now() - 200 * day) }, { where: { id: open_id } });
			expect(await HugBundlesService.sweep_unused()).toBe(3);
			const left = (await HugBundle.findAll({ where: { sha256: [unused, old_closed, recent_closed, old_open, builtin, fresh, resolving] }, raw: true })).map((b) => b.sha256);
			expect(left.sort()).toEqual([recent_closed, old_open, fresh, resolving].sort());
			expect(await HugBundlesService.get_file(unused, 'index.html')).toBeNull();
			expect(await HugBundlesService.get_file(recent_closed, 'index.html')).not.toBeNull();
		});

		it("attachments must be ready files of the Hug's run", async () => {
			const run_id = `run-${uid()}`;
			const ready = await StoredArtifact.create({
				id: crypto.randomUUID(), run_id, phase: 'draft', name: 'lld.md', description: null, mime_type: 'text/markdown',
				size_bytes: 3, storage_key: 'k', uploaded_by: null, created_at: Date.now(), status: 'ready', source: 'daemon',
				hug_id: null, hug_requested_input: null, sha256: null,
			});
			const attachments = [{ artifact_id: ready.id, name: 'lld.md', size: 3, content_type: 'text/markdown', sha256: '' }];
			const { hug_id } = await open({ attachments }, { run_id });
			expect((await HugsService.get(hug_id)).attachments).toEqual(attachments);
			await expect(open({ attachments }, { run_id: `run-${uid()}` })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining('Attachment not found') });
			await StoredArtifact.destroy({ where: { id: ready.id } });
		});
	});

	describe('respond', () => {
		it('a realm member reached through a shared channel answers; the event is stored and delivered until shortly after expiry', async () => {
			const { hug_id } = await open();
			const r = await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'autumn', comment: 'ok' } });
			expect(r.seq).toBe(1);
			const event = (await HugEventRow.findOne({ where: { hug_id, seq: 1 }, raw: true }))!;
			expect(event.type).toBe('response');
			expect(event.payload).toMatchObject({ response: { values: { release: 'autumn', comment: 'ok' }, via: [REALM_MEMBERS_CHANNEL_NAME] } });
			const [delivery] = await deliveries(hug_id);
			expect(JSON.parse(delivery!.payload)).toMatchObject({ hug_id, seq: 1, type: 'response' });
			const hug = (await Hug.findByPk(hug_id, { raw: true }))!;
			expect(Number(delivery!.deliver_until)).toBe(hug.expires_at.getTime() + 60 * 60 * 1000);
			expect(delivery!.daemon_id).toBe('daemon-1');
		});

		it("Core doesn't interpret values; the answer's one-line summary is kept and delivered", async () => {
			const { hug_id } = await open();
			const r = await HugsService.respond({ hug_id, user_id: OWNER, values: { verdicts: [{ id: 'a', ok: false, note: 'blurry' }] }, summary: '0 of 1 OK' });
			const event = (await HugEventRow.findOne({ where: { hug_id, seq: r.seq }, raw: true }))!;
			expect(event.payload).toMatchObject({ response: { values: { verdicts: [{ id: 'a', ok: false, note: 'blurry' }] }, summary: '0 of 1 OK' } });
			expect((await HugsService.get(hug_id)).responses[0]).toMatchObject({ summary: '0 of 1 OK' });
			// The route's envelope: values ≤ 256 KB, the summary one line ≤ 120.
			expect(HugsRespondInput.safeParse({ hug_id, values: { big: 'x'.repeat(257 * 1024) } }).success).toBe(false);
			expect(HugsRespondInput.safeParse({ hug_id, values: {}, summary: 'two\nlines' }).success).toBe(false);
			expect(HugsRespondInput.safeParse({ hug_id, values: {}, summary: 'x'.repeat(121) }).success).toBe(false);
		});

		it('the requester\'s status line (§6.1 progress): only the Hug\'s own daemon sets it, only while open; the latest in a batch wins', async () => {
			const { hug_id } = await open();
			const run_id = (await Hug.findByPk(hug_id, { raw: true }))!.run_id;
			await HugsService.set_progress(run_id, 'daemon-2', hug_id, 'from another daemon');
			expect((await HugsService.get(hug_id)).progress).toBeNull();
			const { RunService } = await import('../../src/services/run.service.js');
			const ev = (progress: string | null) => ({ event_type: 'hug.progress', payload_json: JSON.stringify({ hug_id, progress }) });
			await (RunService as unknown as { _hug_progress: (r: string, d: string, e: unknown[]) => Promise<void> })
				._hug_progress(run_id, 'daemon-1', [ev('first'), { event_type: 'phase.progress', payload_json: '{}' }, ev("1 answer couldn't be used;\n  waiting")]);
			expect((await HugsService.get(hug_id)).progress).toBe("1 answer couldn't be used; waiting");
			await HugsService.set_progress(run_id, 'daemon-1', hug_id, null);
			expect((await HugsService.get(hug_id)).progress).toBeNull();
			await HugsService.set_progress(run_id, 'daemon-1', hug_id, 'waiting for product');
			await HugsService.close({ hug_id, outcome: 'done', daemon_id: 'daemon-1' });
			expect((await HugsService.get(hug_id)).progress).toBeNull();     // ended: no line
			await HugsService.set_progress(run_id, 'daemon-1', hug_id, 'too late');
			expect((await Hug.findByPk(hug_id, { raw: true }))!.progress).toBe('waiting for product');
		});

		it('notifications carry the summaries: the Hug\'s where its page can\'t be shown, the answer\'s for "Ann responded: …" (§3.1, §3.2)', async () => {
			const { NotificationFanOutService } = await import('../../src/notifications/fan_out.service.js');
			const { EventSubmitService } = await import('../../src/services/events_service.js');
			const opened = vi.spyOn(NotificationFanOutService, 'deliver_to_channels');
			const submitted = vi.spyOn(EventSubmitService, 'submit');
			try {
				const { hug_id } = await open();
				const sent = opened.mock.calls.at(-1)![1] as { message: string; payload: Record<string, unknown> };
				expect(sent.message).toBe(`${SPEC.summary}\n\nOpen: ${sent.payload['hug_url']}`);
				expect(sent.payload).toMatchObject({ hug_id, summary: SPEC.summary });

				await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'autumn' }, summary: 'autumn' });
				const responded = submitted.mock.calls.map((c) => c[0]).find((e) => e.type === 'hug.responded')!;
				expect(responded.message).toMatch(/ responded: autumn$/);
				expect(responded.payload).toMatchObject({ hug_id, summary: 'autumn' });
			} finally {
				opened.mockRestore();
				submitted.mockRestore();
			}
		});

		it('file references only under upload slots (422 invalid_values elsewhere); a slot takes only file references, one unless multiple', async () => {
			const { hug_id } = await open();
			await expect(HugsService.respond({ hug_id, user_id: OWNER, values: { nested: { doc: { artifact_id: 'x' } } } }))
				.rejects.toMatchObject({ status_code: 422, code: 'invalid_values', message: expect.stringContaining('nested.doc') });
			await expect(HugsService.respond({ hug_id, user_id: OWNER, values: { contract: 'a string' } })).rejects.toMatchObject({ status_code: 422, code: 'HUG_FILE_INVALID' });
			await expect(HugsService.respond({ hug_id, user_id: OWNER, values: { contract: [{ artifact_id: 'a' }, { artifact_id: 'b' }] } }))
				.rejects.toMatchObject({ status_code: 422, code: 'HUG_FILE_INVALID', message: 'contract: takes one file' });
		});

		it('refuses someone the Hug did not reach (403)', async () => {
			const { hug_id } = await open();
			await expect(HugsService.respond({ hug_id, user_id: OUTSIDER, values: { release: 'x' } })).rejects.toMatchObject({ status_code: 403 });
		});

		it("being asked grants nothing: a person addressed through their own channel without runs.view on the realm is refused (403)", async () => {
			const { hug_id } = await open();
			await HugDelivery.create({ id: `d-${uid()}`, hug_id, channel: 'outsider', channel_id: `ch-${uid()}`, user_id: OUTSIDER, created_at: new Date() });
			await expect(HugsService.respond({ hug_id, user_id: OUTSIDER, values: { release: 'own' } })).rejects.toMatchObject({ status_code: 403 });
			expect((await HugPendingService.list_for_user({ user_id: OUTSIDER, realm_id })).hugs).toEqual([]);
		});

		it('a person with runs.view addressed through their own channel answers via that channel', async () => {
			const p = await person(['realms.view', 'runs.view']);
			const { hug_id } = await open({ channels: [p.name] });
			await HugsService.respond({ hug_id, user_id: p.id, values: { release: 'own' } });
			expect((await HugResponse.findOne({ where: { hug_id, responder_user_id: p.id }, raw: true }))!.via_channels).toEqual([p.name]);
			// The role loses runs.view: the open Hug can no longer be answered or listed.
			await OrgRole.update({ permissions: ['realms.view'] } as never, { where: { id: p.role.id } });
			await expect(HugsService.respond({ hug_id, user_id: p.id, values: { release: 'again' } })).rejects.toMatchObject({ status_code: 403 });
			expect((await HugPendingService.list_for_user({ user_id: p.id, realm_id })).hugs).toEqual([]);
		});

		it('viewer: can_answer is exactly what respond would accept — open and reaching them — with the channels that did; null for a daemon', async () => {
			const p = await person(['realms.view', 'runs.view']);
			const q = await person(['realms.view', 'runs.view']);
			const { hug_id } = await open({ channels: [p.name] });
			expect((await HugsService.get(hug_id, p.id)).viewer).toEqual({ can_answer: true, via: [p.name] });
			// Can view runs, but it wasn't sent to them: read-only.
			expect((await HugsService.get(hug_id, q.id)).viewer).toEqual({ can_answer: false, via: [] });
			await expect(HugsService.respond({ hug_id, user_id: q.id, values: {} })).rejects.toMatchObject({ status_code: 403 });
			expect((await HugsService.get(hug_id)).viewer).toBeNull();
			// A shared channel reaches anyone in the realm who can view runs (today's rule).
			const shared = await open();
			expect((await HugsService.get(shared.hug_id, q.id)).viewer).toEqual({ can_answer: true, via: [REALM_MEMBERS_CHANNEL_NAME] });
			// Ended, or past its expiry before the sweep: nobody can answer.
			await HugsService.close({ hug_id, outcome: 'done', daemon_id: 'daemon-1' });
			expect((await HugsService.get(hug_id, p.id)).viewer).toEqual({ can_answer: false, via: [p.name] });
			await Hug.update({ expires_at: new Date(Date.now() - 1_000) }, { where: { id: shared.hug_id } });
			expect((await HugsService.get(shared.hug_id, q.id)).viewer).toMatchObject({ can_answer: false });
		});

		it('resubmitting replaces the response: one row, a new seq', async () => {
			const { hug_id } = await open();
			await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'one' } });
			const second = await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'two' } });
			expect(second.seq).toBe(2);
			const rows = await HugResponse.findAll({ where: { hug_id }, raw: true });
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ values: { release: 'two' }, seq: 2 });
		});

		it("file values must be the responder's pending uploads for this slot; they become ready with their metadata", async () => {
			const { hug_id } = await open();
			const hug = (await Hug.findByPk(hug_id, { raw: true }))!;
			const upload = (over: Record<string, unknown> = {}) => StoredArtifact.create({
				id: crypto.randomUUID(), run_id: hug.run_id, phase: hug.phase, name: 'MSA.pdf', description: null, mime_type: 'application/pdf',
				size_bytes: 1234, storage_key: 'k', uploaded_by: OWNER, created_at: Date.now(), status: 'pending', source: 'hug',
				hug_id, hug_requested_input: 'contract', sha256: 'abc', ...over,
			});
			const someone_elses = await upload({ uploaded_by: OUTSIDER });
			await expect(HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'x', contract: { artifact_id: someone_elses.id } } }))
				.rejects.toMatchObject({ status_code: 422, code: 'HUG_FILE_INVALID' });
			const mine = await upload();
			await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'x', contract: { artifact_id: mine.id } } });
			const row = (await HugResponse.findOne({ where: { hug_id }, raw: true }))!;
			expect(row.values.contract).toEqual({ artifact_id: mine.id, name: 'MSA.pdf', size: 1234, content_type: 'application/pdf', sha256: 'abc' });
			expect((await StoredArtifact.findByPk(mine.id, { raw: true }))!.status).toBe('ready');
			await StoredArtifact.destroy({ where: { hug_id } });
		});

		it('a close that lands after the first check still wins: the Hug is checked again inside the write (409, nothing stored)', async () => {
			const { hug_id } = await open();
			const real = HugsService.channels_reaching.bind(HugsService);
			const spy = vi.spyOn(HugsService, 'channels_reaching').mockImplementationOnce(async (hug, user_id) => {
				await HugsService.close({ hug_id, outcome: 'done', daemon_id: 'daemon-1' });
				return real(hug, user_id);
			});
			await expect(HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'late' } })).rejects.toMatchObject({ status_code: 409 });
			spy.mockRestore();
			expect(await HugResponse.count({ where: { hug_id } })).toBe(0);
			expect(await HugEventRow.count({ where: { hug_id, type: 'response' } })).toBe(0);
		});

		it('a response is stored only with its delivery: if the delivery cannot be queued, nothing is kept', async () => {
			const { hug_id } = await open();
			const sq = get_sequelize();
			const real = sq.query.bind(sq);
			const spy = vi.spyOn(sq, 'query').mockImplementation(((sql: unknown, opts: unknown) => {
				if (typeof sql === 'string' && sql.includes('INSERT INTO cliq."command_outbox"')) return Promise.reject(new Error('outbox down'));
				return real(sql as never, opts as never);
			}) as never);
			await expect(HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'x' } })).rejects.toThrow('outbox down');
			spy.mockRestore();
			expect(await HugResponse.count({ where: { hug_id } })).toBe(0);
			expect(await HugEventRow.count({ where: { hug_id } })).toBe(0);
			expect((await Hug.findByPk(hug_id, { raw: true }))!.last_seq).toBe(0);
		});

		it('a resubmitted response may reuse files already attached to the earlier one', async () => {
			const { hug_id } = await open();
			const hug = (await Hug.findByPk(hug_id, { raw: true }))!;
			const file = await StoredArtifact.create({
				id: crypto.randomUUID(), run_id: hug.run_id, phase: hug.phase, name: 'MSA.pdf', description: null, mime_type: 'application/pdf',
				size_bytes: 10, storage_key: 'k', uploaded_by: OWNER, created_at: Date.now(), status: 'pending', source: 'hug',
				hug_id, hug_requested_input: 'contract', sha256: 'def',
			});
			await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'one', contract: { artifact_id: file.id } } });
			await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'two', contract: { artifact_id: file.id } } });
			const row = (await HugResponse.findOne({ where: { hug_id }, raw: true }))!;
			expect(row.values).toMatchObject({ release: 'two', contract: { artifact_id: file.id, sha256: 'def' } });
			expect((await StoredArtifact.findByPk(file.id, { raw: true }))!.status).toBe('ready');
			await StoredArtifact.destroy({ where: { hug_id } });
		});

		it('a closed Hug refuses answers (409); an expired one refuses them (410) even before the sweep runs', async () => {
			const closed = await open();
			await HugsService.close({ hug_id: closed.hug_id, outcome: 'done', daemon_id: 'daemon-1' });
			await expect(HugsService.respond({ hug_id: closed.hug_id, user_id: OWNER, values: { release: 'x' } })).rejects.toMatchObject({ status_code: 409 });

			const late = await open();
			await Hug.update({ expires_at: new Date(Date.now() - 1_000) }, { where: { id: late.hug_id } });
			expect((await Hug.findByPk(late.hug_id, { raw: true }))!.status).toBe('open');
			await expect(HugsService.respond({ hug_id: late.hug_id, user_id: OWNER, values: { release: 'x' } })).rejects.toMatchObject({ status_code: 410, code: 'HUG_EXPIRED' });
		});
	});

	describe('close, catch-up, cancel, expiry, reminders', () => {
		it('close is idempotent and keeps the outcome', async () => {
			const { hug_id } = await open();
			expect(await HugsService.close({ hug_id, outcome: 'Release named', daemon_id: 'daemon-1' })).toEqual({ status: 'closed' });
			expect(await HugsService.close({ hug_id, outcome: 'again', daemon_id: 'daemon-1' })).toEqual({ status: 'closed' });
			expect((await Hug.findByPk(hug_id, { raw: true }))!.outcome).toBe('Release named');
		});

		it('only the daemon that opened a Hug may close it (403)', async () => {
			const { hug_id } = await open();
			await expect(HugsService.close({ hug_id, outcome: 'mine now', daemon_id: 'daemon-2' })).rejects.toMatchObject({ status_code: 403 });
			expect((await Hug.findByPk(hug_id, { raw: true }))!.status).toBe('open');
			await expect(HugsService.close({ hug_id: 'no-such-hug', outcome: 'x', daemon_id: 'daemon-1' })).rejects.toMatchObject({ status_code: 404 });
		});

		it('the events of Hugs that ended more than 7 days ago are deleted; the Hug keeps how it ended', async () => {
			const old = await open();
			const recent = await open();
			const still_open = await open();
			for (const h of [old, recent, still_open]) await HugsService.respond({ hug_id: h.hug_id, user_id: OWNER, values: { release: 'x' } });
			await HugsService.close({ hug_id: old.hug_id, outcome: 'done', daemon_id: 'daemon-1' });
			await HugsService.close({ hug_id: recent.hug_id, outcome: 'done', daemon_id: 'daemon-1' });
			await Hug.update({ closed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }, { where: { id: old.hug_id } });
			expect(await HugsService.delete_old_events()).toBeGreaterThanOrEqual(1);
			expect(await HugEventRow.count({ where: { hug_id: old.hug_id } })).toBe(0);
			expect(await HugEventRow.count({ where: { hug_id: recent.hug_id } })).toBe(1);
			expect(await HugEventRow.count({ where: { hug_id: still_open.hug_id } })).toBe(1);
			const out = await HugsService.get_events({ daemon_id: 'daemon-1', cursors: [{ hug_id: old.hug_id, after_seq: 0 }] });
			expect(out.hugs).toEqual([{ hug_id: old.hug_id, status: 'closed', last_seq: 1 }]);
		});

		it("get_events returns the daemon's own events after each cursor, and every Hug's status", async () => {
			const mine = await open();
			const other = await open({}, { daemon_id: 'daemon-2' });
			await HugsService.respond({ hug_id: mine.hug_id, user_id: OWNER, values: { release: 'a' } });
			await HugsService.respond({ hug_id: mine.hug_id, user_id: OWNER, values: { release: 'b' } });
			await HugsService.respond({ hug_id: other.hug_id, user_id: OWNER, values: { release: 'c' } });
			const out = await HugsService.get_events({ daemon_id: 'daemon-1', cursors: [{ hug_id: mine.hug_id, after_seq: 1 }, { hug_id: other.hug_id, after_seq: 0 }] });
			expect(out.events.map((e) => [e.hug_id, e.seq])).toEqual([[mine.hug_id, 2]]);
			expect(out.hugs).toEqual([{ hug_id: mine.hug_id, status: 'open', last_seq: 2 }]);
			expect(out.has_more).toBe(false);
		});

		it('an ended Hug reports how it ended even after its events were cleaned up', async () => {
			const { hug_id } = await open();
			await HugsService.cancel_for_run((await Hug.findByPk(hug_id, { raw: true }))!.run_id);
			await HugEventRow.destroy({ where: { hug_id } });
			const out = await HugsService.get_events({ daemon_id: 'daemon-1', cursors: [{ hug_id, after_seq: 0 }] });
			expect(out.events).toEqual([]);
			expect(out.hugs).toEqual([{ hug_id, status: 'cancelled', last_seq: 1 }]);
		});

		it('cancel_for_run cancels open Hugs and tells the requester', async () => {
			const run_id = `run-${uid()}`;
			const a = await open({}, { run_id });
			const b = await open({}, { run_id });
			await HugsService.close({ hug_id: b.hug_id, outcome: 'done', daemon_id: 'daemon-1' });
			expect(await HugsService.cancel_for_run(run_id)).toBe(1);
			expect((await Hug.findByPk(a.hug_id, { raw: true }))!.status).toBe('cancelled');
			expect((await HugEventRow.findOne({ where: { hug_id: a.hug_id }, raw: true }))!.type).toBe('cancelled');
			expect((await deliveries(a.hug_id)).map((d) => JSON.parse(d.payload).type)).toEqual(['cancelled']);
		});

		it('expire_due ends open Hugs past expires_at, once', async () => {
			const { hug_id } = await open();
			await Hug.update({ expires_at: new Date(Date.now() - 1_000) }, { where: { id: hug_id } });
			expect(await HugsService.expire_due()).toBeGreaterThanOrEqual(1);
			expect((await Hug.findByPk(hug_id, { raw: true }))!.status).toBe('expired');
			await HugsService.expire_due();
			expect(await HugEventRow.count({ where: { hug_id, type: 'expired' } })).toBe(1);
		});

		it('reminders are scheduled at open, sent when due, rescheduled, and never delivered to the requester', async () => {
			const { hug_id } = await open({ reminders: { every_min: 30, at_min: [10] } });
			const hug = (await Hug.findByPk(hug_id, { raw: true }))!;
			expect(hug.next_remind_at!.getTime()).toBe(hug.created_at.getTime() + 10 * 60_000);
			await Hug.update({ next_remind_at: new Date(Date.now() - 1_000) }, { where: { id: hug_id } });
			const now = new Date();
			expect(await HugsService.remind_due(now)).toBeGreaterThanOrEqual(1);
			const after = (await Hug.findByPk(hug_id, { raw: true }))!;
			expect(after.last_reminded_at!.getTime()).toBe(now.getTime());
			// The 10-minute nudge is still ahead, so it comes before the next 30-minute tick.
			expect(after.next_remind_at!.getTime()).toBe(hug.created_at.getTime() + 10 * 60_000);
			expect(await HubEvent.count({ where: { type: 'hug.reminded', run_id: hug.run_id } })).toBe(1);
			expect(await deliveries(hug_id)).toEqual([]);
		});
	});

	describe('file uploads for a Hug (artifacts/upload, responder branch)', () => {
		const storage = { upload: vi.fn(async () => ({ artifact_id: 'a1' })) };
		const ctrl = new ArtifactsController(storage as never);
		const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() });
		const upload = async (hug_id: string, requested_input: string, who: { id: string; via?: string }) => {
			const next = vi.fn();
			const req = {
				query: { hug_id, requested_input, name: 'MSA.pdf' },
				headers: { 'content-type': 'application/pdf', 'content-length': '4' },
				auth: who.via === 'daemon_token' ? { auth_via: 'daemon_token', realm_id } : { auth_via: 'pat', user: { id: who.id } },
			};
			await ctrl.wrap(ctrl.upload)(req as never, res() as never, next);
			return next.mock.calls[0]?.[0] as { status_code?: number; status?: number; code?: string } | undefined;
		};

		it('a person the Hug was addressed to uploads into one of its upload slots; the target carries the slot rules', async () => {
			storage.upload.mockClear();
			const { hug_id } = await open();
			const hug = (await Hug.findByPk(hug_id, { raw: true }))!;
			expect(await upload(hug_id, 'contract', { id: OWNER })).toBeUndefined();
			expect(storage.upload).toHaveBeenCalledWith(expect.objectContaining({
				name: 'MSA.pdf', content_length: 4, uploaded_by: OWNER,
				target: { kind: 'hug', run_id: hug.run_id, phase: hug.phase, hug_id, requested_input: 'contract', accept: ['application/pdf'], max_bytes: undefined, pending_count: 0 },
			}));
		});

		it('refuses: not an upload slot (422), not addressed / no runs.view (403), a daemon (403), a closed Hug (409)', async () => {
			storage.upload.mockClear();
			const { hug_id } = await open();
			expect(await upload(hug_id, 'release', { id: OWNER })).toMatchObject({ status: 422, code: 'HUG_FILE_INVALID' });
			expect(await upload(hug_id, 'contract', { id: OUTSIDER })).toMatchObject({ status: 403 });
			expect(await upload(hug_id, 'contract', { id: '', via: 'daemon_token' })).toMatchObject({ status: 403 });
			await HugsService.close({ hug_id, outcome: 'done', daemon_id: 'daemon-1' });
			expect(await upload(hug_id, 'contract', { id: OWNER })).toMatchObject({ status_code: 409 });
			expect(storage.upload).not.toHaveBeenCalled();
		});
	});

	describe('inbox', () => {
		it("lists the open Hugs addressed to a person, with whether they've answered; what's waiting on them leaves out the answered ones", async () => {
			const a = await open();
			const b = await open();
			const c = await open();
			// a: answered but still open (a Hug can wait on several people); b: closed; c: waiting.
			await HugsService.respond({ hug_id: a.hug_id, user_id: OWNER, values: { release: 'x' } });
			await HugsService.close({ hug_id: b.hug_id, outcome: 'done', daemon_id: 'daemon-1' });
			const { hugs } = await HugPendingService.list_for_user({ user_id: OWNER, realm_id });
			expect(hugs.map((h) => [h.hug_id, h.responded])).toEqual([[c.hug_id, false], [a.hug_id, true]]);
			const waiting = await HugPendingService.list_for_user({ user_id: OWNER, realm_id, unanswered: true });
			expect([waiting.total, waiting.hugs.map((h) => h.hug_id)]).toEqual([1, [c.hug_id]]);
			expect(await HugPendingService.count_open_by_realm_for_user({ user_id: OWNER, realm_ids: [realm_id] })).toEqual(new Map([[realm_id, 1]]));
			expect((await HugPendingService.list_for_user({ user_id: OUTSIDER, realm_id })).hugs).toEqual([]);
			const closed = await HugPendingService.list_for_user({ user_id: OWNER, realm_id, statuses: ['closed'] });
			expect(closed.hugs.map((h) => h.hug_id)).toEqual([b.hug_id]);
		});
	});
});
