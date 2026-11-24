/**
 * An in-memory getHugs for the reconcile tests: the calls the reconcile makes, with the getHugs rules it depends on
 * (a reference already used returns that record; deleting a channel or workspace archives it; in-app only on personal
 * channels; Slack only through an incoming-webhook URL; a workspace channel names only its members). Plugged in
 * through `GethugsPartner`'s fetch.
 */

type Ext = { source: string; id: string } | null;
interface Org { id: string; name: string; status: 'active' | 'suspended'; version: number; external: Ext }
interface User { id: string; org_id: string; email: string; name: string | null; type: 'person'; status: 'invited' | 'active' | 'deactivated'; role_id: string; external: Ext }
interface Workspace { id: string; org_id: string; name: string; archived_at: number | null; external: Ext; members: Map<string, string> }
interface Channel { id: string; org_id: string; workspace_id: string | null; personal_user_id: string | null; name: string; enabled: boolean; archived_at: number | null; external: Ext; version: number }
interface Dest { id: string; channel_id: string; type: string; config: Record<string, unknown>; target_channel_id: string | null }
interface Template { id: string; org_id: string | null; name: string; builtin: boolean; versions: Array<{ id: string; sha: string; files?: Record<string, string> }>; current: string | null; archived_at: number | null }
export interface FakeHug { id: string; org_id: string; workspace_id: string; ref_id: string | null; requester: string | null; template: string; title: string; channels: string[]; context: Record<string, unknown>; status: string; outcome: string | null; progress: string | null; expires_at: number; idempotency_key: string | null; body: Record<string, any>; last_seq: number; created_at?: number; events: Array<{ hug_id: string; seq: number; type: 'response' | 'expired' | 'cancelled'; payload: Record<string, unknown> }> }
/** One event of the partner feed (as getHugs' `events/get` gives it). */
export interface FeedEvent { id: string; type: string; seq: number | null; hug: { id: string; ref_id: string | null; status: string }; [k: string]: unknown }

const SLACK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

class Refused extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

export class FakeGethugs {
    orgs: Org[] = [];
    users: User[] = [];
    roles: Array<{ id: string; org_id: string; slug: string }> = [];
    workspaces: Workspace[] = [];
    channels: Channel[] = [];
    dests: Dest[] = [];
    /** The built-ins every org sees (as getHugs ships them), and the orgs' own templates. */
    templates: Template[] = [
        { id: 'tpl_approval', org_id: null, name: 'approval', builtin: true, versions: [], current: null, archived_at: null },
        { id: 'tpl_form', org_id: null, name: 'form', builtin: true, versions: [], current: null, archived_at: null },
        { id: 'tpl_ack', org_id: null, name: 'ack', builtin: true, versions: [], current: null, archived_at: null },
    ];
    hugs: FakeHug[] = [];
    /** Documents (uploaded files): run files a Hug shows, or files someone sent in an answer. */
    documents: Array<{ document_id: string; workspace_id: string; name: string; content_type: string; bytes: Uint8Array; hug_id: string | null; slot: string | null }> = [];
    /** The partner feed, oldest first; a cursor is the index after the last event given. */
    feed: FeedEvent[] = [];
    /** Cursors before this index are refused as expired (events are kept 7 days). */
    feed_kept_from = 0;
    /** Called on every new Hug, before `hugs/create` answers (a test answers it "before Core stores its row"). */
    on_create: ((h: FakeHug) => void) | null = null;
    /** When set, every call answers this status (getHugs down: 503; the token refused: 401). */
    fail_with: number | null = null;
    /** Every call, as `<path>` — reads included. */
    calls: string[] = [];
    /** Invitation emails getHugs would have sent. */
    invites: string[] = [];
    private n = 0;
    /** Unique across fakes (Core's rows from earlier tests keep the ids they were given). */
    private readonly run = Math.random().toString(36).slice(2, 8);
    private id(prefix: string) { return `${prefix}_${this.run}${++this.n}`; }

    /** The `fetch` to give `GethugsPartner`. */
    /** The real `fetch`, for anything that isn't this fake (object storage, …) once a test stubs the global. */
    private readonly real_fetch = globalThis.fetch;

    readonly fetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.host !== 'gethugs.test') return this.real_fetch(input, init);
        const path = url.pathname.replace(/^.*\/v1\//, '');
        if (path === 'documents/upload' || path === 'documents/download') {
            this.calls.push(path);
            if (this.fail_with) return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'down' } }), { status: this.fail_with, headers: { 'content-type': 'application/json' } });
            if (path === 'documents/upload') {
                const q = url.searchParams;
                const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
                const doc = { document_id: this.id('doc'), workspace_id: q.get('workspace_id')!, name: q.get('name')!, content_type: new Headers(init?.headers).get('content-type') ?? 'application/octet-stream', bytes, hug_id: q.get('hug_id'), slot: q.get('slot') };
                this.documents.push(doc);
                return new Response(JSON.stringify({ data: { document_id: doc.document_id, workspace_id: doc.workspace_id, name: doc.name, size: bytes.length, content_type: doc.content_type, sha256: 'x', status: 'ready' } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            const b = JSON.parse(String(init?.body ?? '{}')) as { document_id: string; workspace_id: string };
            const doc = this.documents.find((d) => d.document_id === b.document_id && d.workspace_id === b.workspace_id);
            if (!doc) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Document not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
            return new Response(doc.bytes, { status: 200, headers: { 'content-type': doc.content_type } });
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
        this.calls.push(path);
        if (this.fail_with) {
            return new Response(JSON.stringify({ error: { code: this.fail_with === 401 ? 'unauthorized' : 'unavailable', message: 'down' } }), { status: this.fail_with, headers: { 'content-type': 'application/json' } });
        }
        try {
            const data = this.handle(path, body, new Headers(init?.headers).get('idempotency-key'));
            return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
        } catch (err) {
            if (!(err instanceof Refused)) throw err;
            return new Response(JSON.stringify({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }), { status: err.status, headers: { 'content-type': 'application/json' } });
        }
    };

    /** Writes only (no reads). */
    writes(): string[] {
        return this.calls.filter((c) => !/\/get($|_)/.test(c));
    }

    /** A Hug's event: in its own list (with the next seq) and on the feed (`extra` is the feed's own fields). */
    private hug_event(h: FakeHug, type: 'response' | 'expired' | 'cancelled' | null, feed_type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
        let seq: number | null = null;
        if (type) {
            seq = ++h.last_seq;
            h.events.push({ hug_id: h.id, seq, type, payload });
        }
        this.feed.push({ id: this.id('evt'), type: feed_type, seq, at: Date.now(), org: { id: h.org_id }, workspace: { id: h.workspace_id }, hug: { id: h.id, ref_id: h.ref_id, status: h.status }, ...extra });
    }

    /** A file someone attaches to an answer (getHugs keeps it as a document of the Hug's slot). */
    answer_file(hug_id: string, slot: string, name: string, text: string) {
        const h = this.hugs.find((x) => x.id === hug_id)!;
        const bytes = new TextEncoder().encode(text);
        const doc = { document_id: this.id('doc'), workspace_id: h.workspace_id, name, content_type: 'text/plain', bytes, hug_id, slot };
        this.documents.push(doc);
        return { document_id: doc.document_id, name, size: bytes.length, content_type: 'text/plain', sha256: 's'.repeat(64) };
    }

    /** Someone answers (or changes their answer) in getHugs. */
    respond(hug_id: string, user_id: string, values: Record<string, unknown>, summary = 'Done') {
        const h = this.hugs.find((x) => x.id === hug_id)!;
        const u = this.users.find((x) => x.id === user_id)!;
        const changed = h.events.some((e) => e.type === 'response' && (e.payload.response as { responder: { user_id: string } }).responder.user_id === user_id);
        const response = { response_id: this.id('rsp'), responder: { user_id, name: u.name ?? u.email }, via: h.channels, values, summary, responded_at: Date.now() };
        this.hug_event(h, 'response', 'hug.responded', { response }, { response: { ...response, responder: { ...response.responder, external: u.external }, changed } });
    }

    /** A Hug expires in getHugs. */
    expire(hug_id: string) {
        const h = this.hugs.find((x) => x.id === hug_id)!;
        h.status = 'expired';
        this.hug_event(h, 'expired', 'hug.expired', {});
    }

    org_by_ref(id: string) { return this.orgs.find((o) => o.external?.id === id); }
    user_by_ref(org_id: string, id: string) { return this.users.find((u) => u.org_id === org_id && u.external?.id === id); }
    workspace_by_ref(org_id: string, id: string) { return this.workspaces.find((w) => w.org_id === org_id && w.external?.id === id); }
    channel_by_ref(org_id: string, id: string) { return this.channels.find((c) => c.org_id === org_id && c.external?.id === id); }
    role_slug(role_id: string) { return this.roles.find((r) => r.id === role_id)?.slug; }

    private ext(b: Record<string, any>, prefix = ''): Ext {
        const source = b[`${prefix}external_source`], id = b[`${prefix}external_id`];
        if ((source === undefined) !== (id === undefined)) throw new Refused(400, 'invalid_request', 'both reference fields');
        return source ? { source, id } : null;
    }
    private page<T>(items: T[]) { return { items, next_cursor: null }; }
    private user_out(u: User) { const r = this.roles.find((x) => x.id === u.role_id)!; return { ...u, role: { id: r.id, slug: r.slug, name: r.slug } }; }
    private dest_out(d: Dest) {
        const t = d.target_channel_id ? this.channels.find((c) => c.id === d.target_channel_id)! : null;
        const config = d.type === 'slack' ? { url_hint: `hooks.slack.com/…${String(d.config.url).slice(-4)}` } : d.config;
        return { id: d.id, channel_id: d.channel_id, type: d.type, config, target: t ? { id: t.id, name: t.name, personal_user_id: t.personal_user_id } : null, enabled: true };
    }
    private other_owner(u: User) { return this.users.some((x) => x.org_id === u.org_id && x.id !== u.id && x.status !== 'deactivated' && this.role_slug(x.role_id) === 'owner'); }
    private add_person(org_id: string, email: string, name: string | null, role_slug: string, external: Ext) {
        const existing = this.users.find((u) => u.org_id === org_id && u.email === email.toLowerCase());
        if (existing) throw new Refused(409, 'conflict', 'A person with this email is already in the org');
        const role = this.roles.find((r) => r.org_id === org_id && r.slug === role_slug)!;
        const u: User = { id: this.id('usr'), org_id, email: email.toLowerCase(), name, type: 'person', status: 'invited', role_id: role.id, external };
        this.users.push(u);
        this.channels.push({ id: this.id('ch'), org_id, workspace_id: null, personal_user_id: u.id, name: `@${u.email}`, enabled: true, archived_at: null, external: null, version: 1 });
        return u;
    }

    private template_out(t: Template) {
        const v = t.versions.find((x) => x.id === t.current);
        return {
            id: t.id, name: t.name, builtin: t.builtin, archived_at: t.archived_at,
            current_version: v ? { id: v.id, sha256: v.sha } : t.builtin ? { id: `tpv_${t.name}`, sha256: '' } : null,
        };
    }

    /** As getHugs resolves a Hug's channel names in a workspace: an email is a person (a workspace member), else a channel. */
    private resolve_names(org_id: string, workspace_id: string, names: string[]) {
        const unresolved: string[] = [];
        const not_members: string[] = [];
        const ws = this.workspaces.find((w) => w.id === workspace_id)!;
        for (const raw of names) {
            const name = raw.trim().toLowerCase();
            if (name.includes('@')) {
                const u = this.users.find((x) => x.org_id === org_id && x.email === name && x.status !== 'deactivated');
                if (!u) unresolved.push(name);
                else if (!ws.members.has(u.id)) not_members.push(name);
                continue;
            }
            const found = this.channels.some((c) => c.org_id === org_id && c.archived_at === null && c.personal_user_id === null && c.name.toLowerCase() === name
                && (c.workspace_id === workspace_id || c.workspace_id === null));
            if (!found && name !== 'all-workspace') unresolved.push(name);
        }
        return { unresolved, not_members };
    }

    private handle(path: string, b: Record<string, any>, idempotency_key: string | null = null): unknown {
        switch (path) {
            case 'templates/get':
                return { items: this.templates.filter((t) => (t.org_id === null || t.org_id === b.org_id) && (b.include_archived || !t.archived_at)).map((t) => this.template_out(t)) };
            case 'templates/create': {
                if (this.templates.some((t) => t.org_id === b.org_id && !t.archived_at && t.name.toLowerCase() === String(b.name).toLowerCase())) throw new Refused(409, 'conflict', 'A template with this name exists');
                if (b.files?.['bad.txt']) throw new Refused(400, 'invalid_request', 'The bundle breaks the rules');
                const v = { id: this.id('tpv'), sha: JSON.stringify(b.files), files: b.files };
                const t: Template = { id: this.id('tpl'), org_id: b.org_id, name: b.name, builtin: false, versions: [v], current: v.id, archived_at: null };
                this.templates.push(t);
                return this.template_out(t);
            }
            case 'templates/add_version': {
                const t = this.templates.find((x) => x.id === b.id)!;
                if (t.archived_at) throw new Refused(409, 'template_archived', 'The template is archived');
                if (b.files?.['bad.txt']) throw new Refused(400, 'invalid_request', 'The bundle breaks the rules');
                const sha = JSON.stringify(b.files);
                const same = t.versions.find((v) => v.sha === sha);
                const version = same ?? { id: this.id('tpv'), sha, files: b.files };
                if (!same) t.versions.push(version);
                if (b.make_current !== false) t.current = version.id;
                return { template: this.template_out(t), version: { id: version.id, sha256: version.sha }, created: !same };
            }
            case 'templates/update': {
                const t = this.templates.find((x) => x.id === b.id && x.org_id === b.org_id);
                if (!t) throw new Refused(404, 'not_found', 'Template not found');
                if (b.restore) {
                    if (this.templates.some((x) => x !== t && x.org_id === t.org_id && !x.archived_at && x.name.toLowerCase() === t.name.toLowerCase())) throw new Refused(409, 'conflict', 'A template with this name exists');
                    t.archived_at = null;
                }
                if (b.current_version_id) {
                    if (!t.versions.some((v) => v.id === b.current_version_id)) throw new Refused(400, 'invalid_request', 'Not a version of this template');
                    t.current = b.current_version_id;
                }
                return this.template_out(t);
            }
            case 'templates/delete': {
                const t = this.templates.find((x) => x.id === b.id && x.org_id === b.org_id);
                if (!t) throw new Refused(404, 'not_found', 'Template not found');
                if (t.builtin) throw new Refused(409, 'builtin', 'A built-in template');
                t.archived_at ??= Date.now();
                return this.template_out(t);
            }
            case 'hugs/create': {
                if (idempotency_key) {
                    const again = this.hugs.find((h) => h.org_id === b.org_id && h.idempotency_key === idempotency_key);
                    if (again) return again;
                }
                const ws = this.workspaces.find((w) => w.id === b.workspace_id && w.org_id === b.org_id);
                if (!ws) throw new Refused(404, 'not_found', 'Workspace not found');
                for (const a of b.attachments ?? []) {
                    if (!this.documents.some((d) => d.document_id === a.document_id && d.workspace_id === b.workspace_id)) throw new Refused(400, 'invalid_request', `Unknown document ${a.document_id}`);
                }
                const { unresolved, not_members } = this.resolve_names(b.org_id, b.workspace_id, b.channels);
                if (unresolved.length) throw new Refused(400, 'invalid_request', `Unknown channel ${unresolved.map((c) => `'${c}'`).join(', ')}`, { unresolved });
                if (not_members.length) throw new Refused(400, 'invalid_request', `${not_members.join(', ')} isn't a member of this workspace`, { code: 'not_a_member' });
                const h: FakeHug = {
                    id: this.id('hug'), org_id: b.org_id, workspace_id: b.workspace_id, ref_id: b.ref_id ?? null, requester: b.requester ?? null,
                    template: b.template, title: b.title, channels: b.channels, context: b.context ?? {}, status: 'open', outcome: null, progress: null,
                    expires_at: Date.now() + b.expires_in_min * 60_000, idempotency_key, body: b, last_seq: 0, events: [], created_at: Date.now() + this.n,
                };
                this.hugs.push(h);
                this.hug_event(h, null, 'hug.opened', {});
                if (this.on_create) this.on_create(h);
                return h;
            }
            case 'hugs/get': {
                // Only a partner's view of one person (partner-focus.md §1): their unanswered Hugs across the org — open,
                // in a workspace they're in (as the fake's Hugs reach every member), not answered by them.
                if (b.user_id === undefined || !b.unanswered) throw new Refused(400, 'invalid_request', 'fake getHugs: hugs/get lists one person’s unanswered Hugs only');
                const u = this.users.find((x) => x.id === b.user_id && x.org_id === b.org_id && x.status !== 'deactivated');
                if (!u) throw new Refused(404, 'not_found', 'User not found');
                const answered = (h: FakeHug) => h.events.some((e) => e.type === 'response' && (e.payload.response as { responder: { user_id: string } }).responder.user_id === u.id);
                const list = this.hugs
                    .filter((h) => h.org_id === b.org_id && h.status === 'open' && h.expires_at > Date.now() && !answered(h)
                        && this.workspaces.some((w) => w.id === h.workspace_id && w.members.has(u.id)))
                    .sort((x, y) => (y.created_at ?? 0) - (x.created_at ?? 0));
                const items = list.slice(0, b.limit ?? 50).map((h) => ({ id: h.id, title: h.title, workspace_id: h.workspace_id, status: h.status, created_at: h.created_at ?? 0, expires_at: h.expires_at }));
                return { items, next_cursor: null, ...(b.with_total ? { total: list.length } : {}) };
            }
            case 'hugs/close': {
                const h = this.hugs.find((x) => x.id === b.hug_id && x.workspace_id === b.workspace_id);
                if (!h) throw new Refused(404, 'not_found', 'Hug not found');
                if (h.status === 'open') {
                    Object.assign(h, { status: 'closed', outcome: b.outcome });
                    this.hug_event(h, null, 'hug.closed', {}, { outcome: b.outcome });
                }
                return { status: h.status };
            }
            case 'hugs/update_progress': {
                const h = this.hugs.find((x) => x.id === b.hug_id && x.workspace_id === b.workspace_id)!;
                h.progress = b.progress;
                return h;
            }
            case 'hugs/cancel': {
                const open = this.hugs.filter((h) => h.workspace_id === b.workspace_id && h.status === 'open' && (b.ref_id ? h.ref_id === b.ref_id : h.id === b.hug_id));
                for (const h of open) {
                    Object.assign(h, { status: 'cancelled', outcome: b.reason ?? null });
                    this.hug_event(h, 'cancelled', 'hug.cancelled', b.reason ? { reason: b.reason } : {}, { reason: b.reason ?? null });
                }
                return { cancelled: open.map((h) => h.id) };
            }
            case 'hugs/get_events': {
                const events = b.cursors.flatMap((c: { hug_id: string; after_seq: number }) =>
                    (this.hugs.find((h) => h.id === c.hug_id && h.workspace_id === b.workspace_id)?.events ?? []).filter((e) => e.seq > c.after_seq));
                const hugs = b.cursors.map((c: { hug_id: string }) => this.hugs.find((h) => h.id === c.hug_id)).filter(Boolean)
                    .map((h: FakeHug) => ({ hug_id: h.id, status: h.status, last_seq: h.last_seq }));
                return { events, hugs, has_more: false };
            }
            case 'events/get':
            case 'events/wait': {
                if (b.cursor === undefined) return { events: [], cursor: String(this.feed.length), has_more: false };
                const from = Number(b.cursor);
                if (from < this.feed_kept_from) throw new Refused(409, 'conflict', 'The cursor has expired', { code: 'cursor_expired' });
                const events = this.feed.slice(from, from + 100);
                return { events, cursor: String(from + events.length), has_more: from + events.length < this.feed.length };
            }
            case 'site/get_orgs':
                return this.page(this.orgs.filter((o) => !b.external_id || (o.external?.source === b.external_source && o.external?.id === b.external_id)));
            case 'site/create_org': {
                const external = this.ext(b);
                const found = external && this.org_by_ref(external.id);
                if (found) {
                    const ws = this.workspaces.find((w) => w.org_id === found.id)!;
                    return { org: found, workspace_id: ws.id, owner_id: this.users.find((u) => u.org_id === found.id && this.role_slug(u.role_id) === 'owner')!.id };
                }
                const org: Org = { id: this.id('org'), name: b.name, status: 'active', version: 1, external };
                this.orgs.push(org);
                for (const slug of ['owner', 'admin', 'member']) this.roles.push({ id: this.id('role'), org_id: org.id, slug });
                const owner = this.add_person(org.id, b.owner_email, b.owner_name ?? null, 'owner', this.ext(b, 'owner_'));
                const ws: Workspace = { id: this.id('ws'), org_id: org.id, name: b.workspace_name ?? b.name, archived_at: null, external: this.ext(b, 'workspace_'), members: new Map([[owner.id, 'admin']]) };
                this.workspaces.push(ws);
                if (b.send_invite !== false) this.invites.push(owner.email);
                return { org, workspace_id: ws.id, owner_id: owner.id };
            }
            case 'site/update_org': {
                const o = this.orgs.find((x) => x.id === b.org_id)!;
                if (o.version !== b.version) throw new Refused(409, 'version_conflict', 'stale');
                Object.assign(o, { name: b.name ?? o.name, version: o.version + 1 });
                return o;
            }
            case 'site/suspend_org': { const o = this.orgs.find((x) => x.id === b.org_id)!; o.status = 'suspended'; o.version++; return o; }
            case 'site/restore_org': { const o = this.orgs.find((x) => x.id === b.org_id)!; o.status = 'active'; o.version++; return o; }
            case 'roles/get': return { items: this.roles.filter((r) => r.org_id === b.org_id), catalogue: [] };
            case 'users/get':
                return this.page(this.users.filter((u) => u.org_id === b.org_id && (!b.external_id || u.external?.id === b.external_id)).map((u) => this.user_out(u)));
            case 'users/create': {
                const external = this.ext(b);
                const found = external && this.user_by_ref(b.org_id, external.id);
                if (found) return this.user_out(found);
                const role = b.role_id ? this.role_slug(b.role_id)! : 'member';
                const u = this.add_person(b.org_id, b.email, b.name ?? null, role, external);
                if (b.send_invite !== false) this.invites.push(u.email);
                return this.user_out(u);
            }
            case 'users/update': {
                const u = this.users.find((x) => x.id === b.user_id && x.org_id === b.org_id)!;
                if (b.email && this.users.some((x) => x.org_id === u.org_id && x.id !== u.id && x.email === b.email.toLowerCase())) throw new Refused(409, 'conflict', 'email_taken');
                if (b.role_id && this.role_slug(u.role_id) === 'owner' && this.role_slug(b.role_id) !== 'owner' && !this.other_owner(u)) throw new Refused(409, 'conflict', 'The org needs another Owner');
                Object.assign(u, { ...(b.email ? { email: b.email.toLowerCase() } : {}), ...(b.name !== undefined ? { name: b.name } : {}), ...(b.role_id ? { role_id: b.role_id } : {}) });
                return this.user_out(u);
            }
            case 'users/deactivate': {
                const u = this.users.find((x) => x.id === b.user_id)!;
                if (this.role_slug(u.role_id) === 'owner' && !this.other_owner(u)) throw new Refused(409, 'conflict', 'The org needs another Owner');
                u.status = 'deactivated';
                for (const w of this.workspaces) w.members.delete(u.id);
                return this.user_out(u);
            }
            case 'users/reactivate': { const u = this.users.find((x) => x.id === b.user_id)!; u.status = 'invited'; return this.user_out(u); }
            case 'workspaces/get':
                return this.page(this.workspaces.filter((w) => w.org_id === b.org_id && w.archived_at === null).map(({ members: _m, ...w }) => w));
            case 'workspaces/create': {
                const external = this.ext(b);
                const found = external && this.workspace_by_ref(b.org_id, external.id);
                if (found) { const { members: _m, ...w } = found; return w; }
                const w: Workspace = { id: this.id('ws'), org_id: b.org_id, name: b.name, archived_at: null, external, members: new Map() };
                this.workspaces.push(w);
                return { ...w, members: undefined };
            }
            case 'workspaces/update': { const w = this.workspaces.find((x) => x.id === b.workspace_id)!; w.name = b.name ?? w.name; return { ...w, members: undefined }; }
            case 'workspaces/delete': { const w = this.workspaces.find((x) => x.id === b.workspace_id)!; w.archived_at = Date.now(); return { deleted: true }; }
            case 'workspaces/get_members': {
                const w = this.workspaces.find((x) => x.id === b.workspace_id)!;
                return { items: [...w.members].map(([user_id, role]) => ({ user_id, role, email: '', name: null, status: 'active' })) };
            }
            case 'workspaces/add_members': {
                const w = this.workspaces.find((x) => x.id === b.workspace_id)!;
                for (const m of b.members) {
                    const u = this.users.find((x) => x.id === m.user_id);
                    if (!u || u.status === 'deactivated') throw new Refused(404, 'not_found', 'User not found');
                    w.members.set(m.user_id, m.role);
                }
                return { added: b.members.length };
            }
            case 'workspaces/remove_members': {
                const w = this.workspaces.find((x) => x.id === b.workspace_id)!;
                for (const id of b.user_ids) w.members.delete(id);
                return { removed: b.user_ids.length };
            }
            case 'channels/get': {
                const list = this.channels.filter((c) => c.org_id === b.org_id && c.archived_at === null && c.personal_user_id === null
                    && (c.workspace_id === null || c.workspace_id === b.workspace_id));
                return this.page(list.map((c) => ({ ...c, scope: c.personal_user_id ? 'personal' : c.workspace_id ? 'workspace' : 'org', builtin: false })));
            }
            case 'channels/create': {
                const external = this.ext(b);
                const found = external && this.channel_by_ref(b.org_id, external.id);
                if (found) return { ...found, scope: found.workspace_id ? 'workspace' : 'org', destinations: [] };
                if (this.channels.some((c) => c.org_id === b.org_id && c.archived_at === null && c.workspace_id === (b.workspace_id ?? null) && c.personal_user_id === null && c.name === b.name)) {
                    throw new Refused(409, 'conflict', 'A channel with this name exists');
                }
                const c: Channel = { id: this.id('ch'), org_id: b.org_id, workspace_id: b.workspace_id ?? null, personal_user_id: null, name: b.name, enabled: true, archived_at: null, external, version: 1 };
                this.channels.push(c);
                return { ...c, scope: c.workspace_id ? 'workspace' : 'org', destinations: [] };
            }
            case 'channels/update': {
                const c = this.channels.find((x) => x.id === b.channel_id)!;
                Object.assign(c, { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), version: c.version + 1 });
                return { ...c, scope: c.workspace_id ? 'workspace' : 'org' };
            }
            case 'channels/delete': { const c = this.channels.find((x) => x.id === b.channel_id)!; c.archived_at = Date.now(); return { deleted: true }; }
            case 'destinations/get': return { items: this.dests.filter((d) => d.channel_id === b.channel_id).map((d) => this.dest_out(d)) };
            case 'destinations/delete': { this.dests = this.dests.filter((d) => d.id !== b.destination_id); return { deleted: true }; }
            case 'destinations/create': {
                const channel = this.channels.find((c) => c.id === b.channel_id)!;
                const d = b.destination as Record<string, any>;
                let config: Record<string, unknown> = {};
                let target: string | null = null;
                if (d.type === 'in_app') throw new Refused(400, 'invalid_request', 'in_app is only for personal channels');
                if (d.type === 'slack') { if (!SLACK.test(d.url)) throw new Refused(400, 'invalid_request', 'A Slack incoming-webhook URL'); config = { url: d.url }; }
                if (d.type === 'webhook') config = { url: d.url };
                if (d.type === 'email') config = { address: d.address };
                if (d.type === 'channel') {
                    if (d.user_id) {
                        const personal = this.channels.find((c) => c.personal_user_id === d.user_id);
                        if (!personal) throw new Refused(404, 'not_found', 'User not found');
                        if (channel.workspace_id && !this.workspaces.find((w) => w.id === channel.workspace_id)!.members.has(d.user_id)) throw new Refused(400, 'invalid_request', 'not_a_member');
                        target = personal.id;
                    } else {
                        target = d.channel_id;
                    }
                }
                const row: Dest = { id: this.id('dst'), channel_id: channel.id, type: d.type, config, target_channel_id: target };
                this.dests.push(row);
                return this.dest_out(row);
            }
            default:
                throw new Error(`fake getHugs: no ${path}`);
        }
    }
}
