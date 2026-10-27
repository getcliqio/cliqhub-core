/**
 * Hugs — Core's side of the one protocol for asking people (PLAN-hug-requests §6, §9).
 *
 * Covers: create (validation, channels resolved, unknown channels raised, none left → 422, a retried
 * create adopts its id, context artifacts must be the run's), who may respond (their own channel; a
 * shared channel only for people who can see the realm), values validated, a response replaced
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
import { HugPendingService } from '../../src/services/hug_pending.service.js';
import { ArtifactsController } from '../../src/controllers/artifacts_controller.js';
import { RealmService } from '../../src/services/realm.service.js';
import { REALM_MEMBERS_CHANNEL_NAME } from '../../src/notifications/defaults.js';
import { ensure_personal_channel } from '../../src/services/per_user_channel.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import {
	Hug, HugDelivery, HugEventRow, HugResponse, HubEvent, OrgMember, OrgRole, Realm, RealmMember, StoredArtifact, User,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const OUTSIDER = hub_legacy_uuid(9_999);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const SPEC = {
	title: 'Release name',
	prompt: 'What should this release be called?',
	requested_inputs: [
		{ name: 'release', type: 'text', max_length: 40 },
		{ name: 'contract', type: 'file', required: false, accept: ['application/pdf'] },
	],
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
			expect(hug).toMatchObject({ status: 'open', org_id, realm_id, channels: [REALM_MEMBERS_CHANNEL_NAME], last_seq: 0 });
			expect(hug.expires_at.getTime() - hug.created_at.getTime()).toBe(60 * 60_000);
			const rows = await HugDelivery.findAll({ where: { hug_id }, raw: true });
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.channel === REALM_MEMBERS_CHANNEL_NAME)).toBe(true);
		});

		it('refuses an invalid spec and one without an expiry (422)', async () => {
			await expect(open({ requested_inputs: [{ name: 'x', type: 'select' }] })).rejects.toMatchObject({ status_code: 422 });
			await expect(open({ expires_in_min: undefined })).rejects.toMatchObject({ status_code: 422, message: expect.stringContaining('expires') });
			await expect(open({ expires_in_min: 10_081 })).rejects.toMatchObject({ status_code: 422 });
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

		it("context artifacts must be ready files of the Hug's run", async () => {
			const run_id = `run-${uid()}`;
			const ready = await StoredArtifact.create({
				id: crypto.randomUUID(), run_id, phase: 'draft', name: 'lld.md', description: null, mime_type: 'text/markdown',
				size_bytes: 3, storage_key: 'k', uploaded_by: null, created_at: Date.now(), status: 'ready', source: 'daemon',
				hug_id: null, hug_requested_input: null, sha256: null,
			});
			await expect(open({ context: [{ type: 'artifact', artifact_id: ready.id }] }, { run_id })).resolves.toBeTruthy();
			await expect(open({ context: [{ type: 'artifact', artifact_id: ready.id }] }, { run_id: `run-${uid()}` })).rejects.toMatchObject({ status_code: 422 });
			await StoredArtifact.destroy({ where: { id: ready.id } });
		});
	});

	describe('respond', () => {
		it('a realm member reached through a shared channel answers; the event is stored and delivered until shortly after expiry', async () => {
			const { hug_id } = await open();
			const r = await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'autumn' }, comment: 'ok' });
			expect(r.seq).toBe(1);
			const event = (await HugEventRow.findOne({ where: { hug_id, seq: 1 }, raw: true }))!;
			expect(event.type).toBe('response');
			expect(event.payload).toMatchObject({ response: { values: { release: 'autumn' }, via: [REALM_MEMBERS_CHANNEL_NAME], comment: 'ok' } });
			const [delivery] = await deliveries(hug_id);
			expect(JSON.parse(delivery!.payload)).toMatchObject({ hug_id, seq: 1, type: 'response' });
			const hug = (await Hug.findByPk(hug_id, { raw: true }))!;
			expect(Number(delivery!.deliver_until)).toBe(hug.expires_at.getTime() + 60 * 60 * 1000);
			expect(delivery!.daemon_id).toBe('daemon-1');
		});

		it('refuses someone the Hug did not reach (403), invalid values (422) and unknown inputs', async () => {
			const { hug_id } = await open();
			await expect(HugsService.respond({ hug_id, user_id: OUTSIDER, values: { release: 'x' } })).rejects.toMatchObject({ status_code: 403 });
			await expect(HugsService.respond({ hug_id, user_id: OWNER, values: {} })).rejects.toMatchObject({ status_code: 422, message: 'release: required' });
			await expect(HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'x', extra: 1 } })).rejects.toMatchObject({ status_code: 422 });
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

		it('resubmitting replaces the response: one row, a new seq', async () => {
			const { hug_id } = await open();
			await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'one' } });
			const second = await HugsService.respond({ hug_id, user_id: OWNER, values: { release: 'two' } });
			expect(second.seq).toBe(2);
			const rows = await HugResponse.findAll({ where: { hug_id }, raw: true });
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ values: { release: 'two' }, seq: 2 });
		});

		it("file values must be the responder's pending uploads for this input; they become ready with their metadata", async () => {
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

		it('a person the Hug was addressed to uploads into one of its file inputs; the target carries the input rules', async () => {
			storage.upload.mockClear();
			const { hug_id } = await open();
			const hug = (await Hug.findByPk(hug_id, { raw: true }))!;
			expect(await upload(hug_id, 'contract', { id: OWNER })).toBeUndefined();
			expect(storage.upload).toHaveBeenCalledWith(expect.objectContaining({
				name: 'MSA.pdf', content_length: 4, uploaded_by: OWNER,
				target: { kind: 'hug', run_id: hug.run_id, phase: hug.phase, hug_id, requested_input: 'contract', accept: ['application/pdf'], max_bytes: undefined, pending_count: 0 },
			}));
		});

		it('refuses: not a file input (422), not addressed / no runs.view (403), a daemon (403), a closed Hug (409)', async () => {
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
