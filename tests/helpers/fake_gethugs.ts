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

const SLACK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

class Refused extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export class FakeGethugs {
    orgs: Org[] = [];
    users: User[] = [];
    roles: Array<{ id: string; org_id: string; slug: string }> = [];
    workspaces: Workspace[] = [];
    channels: Channel[] = [];
    dests: Dest[] = [];
    /** Every call, as `<path>` — reads included. */
    calls: string[] = [];
    /** Invitation emails getHugs would have sent. */
    invites: string[] = [];
    private n = 0;
    private id(prefix: string) { return `${prefix}_${++this.n}`; }

    /** The `fetch` to give `GethugsPartner`. */
    readonly fetch: typeof fetch = async (input, init) => {
        const path = String(input).replace(/^.*\/v1\//, '').replace(/\?.*$/, '');
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
        this.calls.push(path);
        try {
            const data = this.handle(path, body);
            return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
        } catch (err) {
            if (!(err instanceof Refused)) throw err;
            return new Response(JSON.stringify({ error: { code: err.code, message: err.message } }), { status: err.status, headers: { 'content-type': 'application/json' } });
        }
    };

    /** Writes only (no reads). */
    writes(): string[] {
        return this.calls.filter((c) => !/\/get($|_)/.test(c));
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

    private handle(path: string, b: Record<string, any>): unknown {
        switch (path) {
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
