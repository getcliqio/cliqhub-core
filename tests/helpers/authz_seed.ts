/**
 * Authorization matrix seed — two orgs, their realms, every kind of caller and
 * one record of each kind, on a live Postgres.
 *
 *   Acme (owner Olivia)            Beta (owner Ben)
 *     realm A1: Omar operator,       realm B1
 *               Mia viewer
 *     realm A2 (nobody added)
 *   Adam = Acme org admin, Nora = Acme member in no realm, Sam = site admin.
 *   Daemon tokens: dA (A1, minted by Omar), dB (B1, minted by Ben),
 *   sdA (A1, minted by Sam — must NOT act as a site admin).
 *
 * Everything carries a per-run stamp and is removed by `cleanup()`.
 */

import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';
import { randomUUID } from 'node:crypto';

import {
    AccountInvite, CustomEvent, Daemon, HubEvent, NotificationChannel, NotificationRule,
    Org, OrgMember, OrgRole, Realm, RealmInvite, RealmMember, Review, Run, StoredArtifact,
    Team, User, Workspace,
} from '../../src/models/index.js';
import { RealmService } from '../../src/services/realm.service.js';
import { get_sequelize } from '../../src/db/sequelize.js';

export const CALLERS = ['anon', 'sam', 'olivia', 'adam', 'omar', 'mia', 'nora', 'ben', 'dA', 'dB', 'sdA'] as const;
export type Caller = (typeof CALLERS)[number];

export interface Seed {
    stamp: string;
    token: Record<Exclude<Caller, 'anon'>, string>;
    user: Record<'sam' | 'olivia' | 'adam' | 'omar' | 'mia' | 'nora' | 'ben', string>;
    acme: string;
    beta: string;
    A1: string;
    A2: string;
    B1: string;
    run_a1: string;
    run_b1: string;
    review_a1: string;
    artifact_a1: string;
    event_a1: string;
    custom_event_a1: string;
    daemon_a1: string;
    workspace_a1: string;
    channel_a1: string;
    channel_acme: string;
    rule_a1: string;
    rule_acme: string;
    invite_acme: string;
    team_public: string;
    team_private: string;
    /** Sign up one more user (removed by cleanup). */
    signup(label: string): Promise<{ id: string; token: string; org_id: string; username: string; email: string }>;
    /** Remove this username too on cleanup (users created by the test itself). */
    track(username: string): void;
    cleanup(): Promise<void>;
}

const password = 'password123';

export async function seed_authz(app: Express): Promise<Seed> {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const usernames: string[] = [];
    const now = Date.now();

    async function signup(label: string) {
        const username = `az${label}${stamp}`.slice(0, 32).toLowerCase();
        usernames.push(username);
        const res = await request(app).post('/internal/auth/signup')
            .send({ username, email: `${username}@authz.test`, password });
        if (res.status !== 200) throw new Error(`signup ${label}: ${res.status} ${JSON.stringify(res.body)}`);
        const m = await OrgMember.findOne({ where: { user_id: res.body.data.user.id }, attributes: ['org_id'], raw: true });
        return { id: String(res.body.data.user.id), token: String(res.body.data.token), org_id: String(m!.org_id), username, email: `${username}@authz.test` };
    }

    const sam = await signup('sam');
    const olivia = await signup('olivia');
    const adam = await signup('adam');
    const omar = await signup('omar');
    const mia = await signup('mia');
    const nora = await signup('nora');
    const ben = await signup('ben');
    await User.update({ role: 'admin' }, { where: { id: sam.id } });

    // Acme = Olivia's org, Beta = Ben's org. Make sure owners hold the system owner role.
    const acme = olivia.org_id;
    const beta = ben.org_id;
    const role_id = async (org_id: string, slug: string) => {
        const r = await OrgRole.findOne({ where: { org_id, slug }, attributes: ['id'], raw: true });
        if (!r) throw new Error(`org ${org_id} has no role ${slug}`);
        return String(r.id);
    };
    for (const [org_id, owner] of [[acme, olivia.id], [beta, ben.id]] as const) {
        // Signup already does this (legacy role 'admin' + owner role_id); keep it explicit.
        await OrgMember.update({ role_id: await role_id(org_id, 'owner') }, { where: { org_id, user_id: owner } });
    }
    const add_org_member = async (user_id: string, slug: string) =>
        OrgMember.create({ org_id: acme, user_id, role: slug, role_id: await role_id(acme, slug) } as never);
    await add_org_member(adam.id, 'admin');
    await add_org_member(omar.id, 'operator');
    await add_org_member(mia.id, 'member');
    await add_org_member(nora.id, 'member');

    const bearer = (t: string) => `Bearer ${t}`;
    async function create_realm(token: string, org_id: string, slug: string) {
        const res = await request(app).post('/v1/realms/create').set('Authorization', bearer(token))
            .send({ org_id, slug, name: slug });
        if (res.status !== 200) throw new Error(`realm ${slug}: ${res.status} ${JSON.stringify(res.body)}`);
        return String(res.body.realm.id);
    }
    const A1 = await create_realm(olivia.token, acme, `a1${stamp}`);
    const A2 = await create_realm(olivia.token, acme, `a2${stamp}`);
    const B1 = await create_realm(ben.token, beta, `b1${stamp}`);

    // Realm roles. Olivia is added by realms/create as its creator; take her out so
    // her access to A1 comes only from being the org owner.
    await RealmMember.destroy({ where: { realm_id: { [Op.in]: [A1, A2] }, member_type: 'user', member_id: olivia.id } });
    await Realm.update({ owner_user_id: sam.id }, { where: { id: { [Op.in]: [A1, A2] } } });
    const add_realm_member = (realm_id: string, member_id: string, role: 'admin' | 'operator' | 'member') =>
        RealmMember.create({ id: randomUUID(), realm_id, member_type: 'user', member_id, role, created_at: now } as never);
    await add_realm_member(A1, omar.id, 'operator');
    await add_realm_member(A1, mia.id, 'member');
    await add_realm_member(A1, sam.id, 'member');

    // Daemon tokens.
    const dA = (await RealmService.create_token(A1, omar.id, `authz-dA-${stamp}`)).token;
    const dB = (await RealmService.create_token(B1, ben.id, `authz-dB-${stamp}`)).token;
    const sdA = (await RealmService.create_token(A1, sam.id, `authz-sdA-${stamp}`)).token;

    // Records.
    const daemon_a1 = `azd${stamp}`;
    await Daemon.create({ id: daemon_a1, api_key_hash: 'x', created_at: now, last_registered_at: now } as never);
    await RealmMember.create({ id: randomUUID(), realm_id: A1, member_type: 'daemon', member_id: daemon_a1, role: 'operator', created_at: now } as never);
    const workspace_a1 = `azw${stamp}`;
    await Workspace.create({ id: workspace_a1, path: `/tmp/${workspace_a1}`, daemon_id: daemon_a1, created_at: now, updated_at: now } as never);

    const mk_run = async (realm_id: string, org_id: string) => {
        const run_id = `azr${randomUUID().slice(0, 8)}${stamp}`;
        await Run.create({ run_id, workspace_id: workspace_a1, team_id: 'authz-team', started_at: now, realm_id, org_id, state: 'running' } as never);
        return run_id;
    };
    const run_a1 = await mk_run(A1, acme);
    const run_b1 = await mk_run(B1, beta);

    const review_a1 = `azrv${stamp}`;
    await Review.create({ id: review_a1, run_id: run_a1, realm_id: A1, org_id: acme, payload: {}, status: 'pending', timeout_at: new Date(now + 3_600_000) } as never);
    const artifact_a1 = randomUUID();
    await StoredArtifact.create({ id: artifact_a1, run_id: run_a1, phase: 'p', name: 'a.txt', mime_type: 'text/plain', size_bytes: 1, storage_key: `authz/${stamp}`, created_at: now } as never);
    const event_a1 = `aze${stamp}`;
    await HubEvent.create({ id: event_a1, type: 'run.completed', occurred_at: new Date(now).toISOString(), realm_id: A1, org_id: acme, payload_json: '{}', created_at: now } as never);
    const custom_event_a1 = randomUUID();
    await CustomEvent.create({ id: custom_event_a1, event_type: `custom.az${stamp}`, source: 'declared', realm_id: A1, created_at: now } as never);
    const channel_a1 = `azc1${stamp}`;
    const channel_acme = `azc2${stamp}`;
    await NotificationChannel.create({ id: channel_a1, name: 'a1', realm_id: A1, enabled: 1, created_at: now, updated_at: now } as never);
    await NotificationChannel.create({ id: channel_acme, name: 'acme', org_id: acme, enabled: 1, created_at: now, updated_at: now } as never);
    const rule_a1 = randomUUID();
    const rule_acme = randomUUID();
    await NotificationRule.create({ id: rule_a1, realm_id: A1, event: 'run.completed', channel_id: channel_a1, priority: 0, created_at: now, updated_at: now } as never);
    await NotificationRule.create({ id: rule_acme, org_id: acme, event: 'run.completed', channel_id: channel_acme, priority: 0, created_at: now, updated_at: now } as never);
    const invite_acme = randomUUID();
    await AccountInvite.create({ id: invite_acme, org_id: acme, email: `x${stamp}@authz.test`, invited_by: olivia.id, token_hash: `h${stamp}`, role: 'member', status: 'pending', expires_at: new Date(now + 86_400_000) } as never);

    const team_public = randomUUID();
    const team_private = randomUUID();
    await Team.create({ id: team_public, name: `azpub${stamp}`, scope: 'cliq', visibility: 'public', listed: 1, author_id: ben.id } as never);
    await Team.create({ id: team_private, name: `azpriv${stamp}`, scope: null, visibility: 'private', listed: 0, author_id: mia.id } as never);

    async function cleanup(): Promise<void> {
        const users = await User.findAll({ where: { username: { [Op.in]: usernames } }, attributes: ['id'], raw: true });
        const ids = users.map((u) => String(u.id));
        const realm_ids = [A1, A2, B1];
        await Team.destroy({ where: { id: { [Op.in]: [team_public, team_private] } } });
        await AccountInvite.destroy({ where: { org_id: { [Op.in]: [acme, beta] } } });
        await RealmInvite.destroy({ where: { realm_id: { [Op.in]: realm_ids } } });
        await NotificationRule.destroy({ where: { id: { [Op.in]: [rule_a1, rule_acme] } } });
        await NotificationChannel.destroy({ where: { id: { [Op.in]: [channel_a1, channel_acme] } } });
        await CustomEvent.destroy({ where: { id: custom_event_a1 } });
        await HubEvent.destroy({ where: { id: event_a1 } });
        await StoredArtifact.destroy({ where: { id: artifact_a1 } });
        await Review.destroy({ where: { id: review_a1 } });
        await Run.destroy({ where: { run_id: { [Op.in]: [run_a1, run_b1] } } });
        await Workspace.destroy({ where: { id: workspace_a1 } });
        await Daemon.destroy({ where: { id: daemon_a1 } });
        const personal = await Realm.findAll({ where: { owner_user_id: { [Op.in]: ids } }, attributes: ['id'], raw: true });
        const all_realms = [...realm_ids, ...personal.map((r) => String(r.id))];
        await RealmMember.destroy({ where: { realm_id: { [Op.in]: all_realms } } });
        await User.update({ default_realm_id: null } as never, { where: { id: { [Op.in]: ids } } });
        await Realm.destroy({ where: { id: { [Op.in]: all_realms } } });
        const sq = get_sequelize();
        await sq.query('DELETE FROM tokens WHERE user_id IN (:ids)', { replacements: { ids } });
        const orgs = await OrgMember.findAll({ where: { user_id: { [Op.in]: ids } }, attributes: ['org_id'], raw: true });
        const org_ids = [...new Set(orgs.map((o) => String(o.org_id)))];
        await OrgMember.destroy({ where: { org_id: { [Op.in]: org_ids } } });
        await OrgRole.destroy({ where: { org_id: { [Op.in]: org_ids } } }).catch(() => {});
        await Org.update({ default_scope_id: null } as never, { where: { id: { [Op.in]: org_ids } } }).catch(() => {});
        await sq.query('DELETE FROM scope_members WHERE user_id IN (:ids)', { replacements: { ids } }).catch(() => {});
        await sq.query('DELETE FROM scopes WHERE owner_id IN (:ids) OR org_id IN (:org_ids)', { replacements: { ids, org_ids } }).catch(() => {});
        await Org.destroy({ where: { id: { [Op.in]: org_ids } } }).catch(() => {});
        await User.destroy({ where: { id: { [Op.in]: ids } } }).catch(() => {});
    }

    return {
        stamp,
        token: { sam: sam.token, olivia: olivia.token, adam: adam.token, omar: omar.token, mia: mia.token, nora: nora.token, ben: ben.token, dA, dB, sdA },
        user: { sam: sam.id, olivia: olivia.id, adam: adam.id, omar: omar.id, mia: mia.id, nora: nora.id, ben: ben.id },
        acme, beta, A1, A2, B1,
        run_a1, run_b1, review_a1, artifact_a1, event_a1, custom_event_a1, daemon_a1, workspace_a1,
        channel_a1, channel_acme, rule_a1, rule_acme, invite_acme, team_public, team_private,
        signup, track: (u: string) => { usernames.push(u); },
        cleanup,
    };
}
