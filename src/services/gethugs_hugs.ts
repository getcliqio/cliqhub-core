/**
 * Asking through getHugs (PLAN-gethugs-step3-asking.md): a Hug of an org switched to getHugs is created there, with
 * cliqhub's partner token, in the realm's workspace. Core keeps its `cliq.hugs` row — under the daemon's id, with
 * `provider = 'gethugs'` and getHugs' id — so the daemon's protocol doesn't change.
 */

import { randomUUID } from 'node:crypto';
import { HugsError, type HugsClient } from '@gethugs/client';
import { Op, QueryTypes, UniqueConstraintError } from 'sequelize';

import { gethugs_config } from '../config/env.js';
import { get_sequelize } from '../db/sequelize.js';
import { ApiError } from '../lib/api_error.js';
import { ApiError as DetailedApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import { Hug, Run, StoredArtifact } from '../models/index.js';
import { ArtifactStorageService } from './artifact_storage.service.js';
import type { HugEnvelope } from '../schemas/hug_types.js';
import { raise_unknown_channel } from '../notifications/unknown_channel.js';
import { gethugs_partner, type GethugsPartner } from './gethugs.service.js';
import { gethugs_mark } from './gethugs_sync.js';
import { gethugs_template_wanted } from './gethugs_templates.js';
import { HugBundlesService } from './hug_bundles.service.js';

const log = get_logger('svc.gethugs_hugs');

/** cliq's built-in "everyone" channels; in getHugs only workspace members answer, so both are `all-workspace`. */
const EVERYONE_CHANNELS = new Set(['all realm members', 'all org members']);
const GETHUGS_EVERYONE = 'all-workspace';
/** How long getHugs' built-in templates are kept per process. */
const BUILTINS_TTL_MS = 10 * 60_000;

export interface GethugsCreateInput {
    hug_id?: string;
    run_id: string;
    daemon_id: string;
    realm_id: string;
    org_id: string;
    phase: string;
    iteration: number;
    spec: HugEnvelope;
    bundle?: Record<string, string>;
    may_upload_bundle?: boolean;
}

interface Template { id: string; name: string; builtin: boolean; current_version: { id: string } | null }

let _builtins: { at: number; by_name: Map<string, string> } | null = null;

/** The getHugs page of a Hug. */
export function gethugs_hug_url(gethugs_id: string): string {
    return `${gethugs_config().app_url}/hugs/${gethugs_id}`;
}

/** Forget the cached built-ins (tests). */
export function reset_gethugs_builtins(): void {
    _builtins = null;
}

async function link(org_id: string, kind: 'org' | 'realm', cliq_id: string): Promise<string | null> {
    const [row] = await get_sequelize().query<{ gethugs_id: string }>(
        'SELECT gethugs_id FROM cliq.gethugs_links WHERE org_id = :org_id AND kind = :kind AND cliq_id = :cliq_id',
        { replacements: { org_id, kind, cliq_id }, type: QueryTypes.SELECT },
    );
    return row?.gethugs_id ?? null;
}

/** Turns a getHugs failure into the error cliqd gets: its refusals as 422, getHugs down as 503, the token as 502. */
function relay_error(err: unknown, what: string): Error {
    if (err instanceof HugsError) {
        if (err.status === 401 || err.status === 403) {
            log.error('gethugs_auth_failed', { what, status: err.status, code: err.code });
            return new ApiError(502, 'CliqHub could not reach getHugs with its credentials', 'gethugs_auth');
        }
        if (err.status === 0 || err.status >= 500 || err.status === 429) {
            log.warn('gethugs_unavailable', { what, status: err.status, code: err.code });
            return ApiError.service_unavailable('getHugs is unavailable — try again', 'gethugs_unavailable');
        }
        return ApiError.unprocessable(err.message, String(err.details?.code ?? err.code));
    }
    return err instanceof Error ? err : new Error(String(err));
}

/** getHugs refused because the template is archived. */
const is_template_archived = (err: unknown): boolean =>
    err instanceof HugsError && (err.details?.code === 'template_archived' || err.code === 'template_archived');

/**
 * A run artifact as a document in the Hug's workspace — uploaded once per workspace (`cliq.gethugs_documents`), so a
 * retried create reuses it.
 */
async function document_for(client: HugsClient, workspace_id: string, artifact_id: string): Promise<string> {
    const [known] = await get_sequelize().query<{ document_id: string }>(
        `SELECT document_id FROM cliq.gethugs_documents WHERE workspace_id = :workspace_id AND artifact_id = :artifact_id AND direction = 'out'`,
        { replacements: { workspace_id, artifact_id }, type: QueryTypes.SELECT },
    );
    if (known) return known.document_id;
    const file = await new ArtifactStorageService().download(artifact_id);
    const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
    const doc = await client.documents.upload(bytes, { name: file.name, content_type: file.mime_type }) as unknown as { document_id: string };
    await get_sequelize().query(
        `INSERT INTO cliq.gethugs_documents (workspace_id, document_id, artifact_id, direction) VALUES (:workspace_id, :document_id, :artifact_id, 'out')
         ON CONFLICT (workspace_id, artifact_id, direction) DO NOTHING`,
        { replacements: { workspace_id, document_id: doc.document_id, artifact_id } },
    );
    log.info('gethugs_document_uploaded', { artifact_id, document_id: doc.document_id });
    return doc.document_id;
}

/**
 * The run files a Hug shows, as getHugs takes them: each attachment (checked to be a file of the run) becomes a document
 * of the workspace, attached with its run file id as its `ref` — the id cliq's params name it by (a `document` context
 * block, a team hug's own fields; PLAN-gethugs-step8-5 D1). Params go to getHugs unchanged.
 */
async function run_files_as_documents(client: HugsClient, workspace_id: string, run_id: string, spec: HugEnvelope): Promise<Array<{ document_id: string; ref: string }>> {
    const ids = [...new Set(spec.attachments.map((a) => a.artifact_id))];
    if (ids.length === 0) return [];
    const found = await StoredArtifact.findAll({ where: { id: { [Op.in]: ids }, run_id }, attributes: ['id'], raw: true });
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length > 0) throw ApiError.unprocessable(`Attachment not found in this run: ${missing.join(', ')}`, 'invalid_hug');
    const attached: Array<{ document_id: string; ref: string }> = [];
    for (const id of ids) attached.push({ document_id: await document_for(client, workspace_id, id), ref: id });
    return attached;
}

/** getHugs' built-in templates by name, read from getHugs (`templates/get`, `builtin: true`) and kept a while. */
async function builtin_templates(partner: GethugsPartner, g_org: string): Promise<Map<string, string>> {
    if (_builtins && Date.now() - _builtins.at < BUILTINS_TTL_MS) return _builtins.by_name;
    const { items } = await partner.site.call<{ items: Template[] }>('templates/get', { org_id: g_org });
    _builtins = { at: Date.now(), by_name: new Map(items.filter((t) => t.builtin).map((t) => [t.name, t.id])) };
    return _builtins.by_name;
}

/**
 * The getHugs template (or exact version) a Hug opens with: a built-in by the hug's name; otherwise the team's hug,
 * installed from its bundle once per org and bundle (`<team>/<hug>`, a new version when the bundle changes).
 *
 * @throws 422 `unknown_hug` — no bundle hash and not one of getHugs' built-ins
 * @throws 409 `BUNDLE_MISSING` — Core doesn't hold the bundle yet and cliqd didn't send it (cliqd resends)
 */
async function template_for(partner: GethugsPartner, input: GethugsCreateInput, g_org: string): Promise<string> {
    const builtins = await builtin_templates(partner, g_org);
    const builtin = builtins.get(input.spec.hug.name);
    if (builtin) return builtin;
    const { name: hug_name, sha256 } = input.spec.hug;
    if (!sha256) {
        throw ApiError.unprocessable(
            `'${hug_name}' isn't one of getHugs' built-in hugs (${[...builtins.keys()].sort().join(', ')}) — a team's own hug is sent with its bundle hash`,
            'unknown_hug',
        );
    }
    const hug = { name: hug_name, sha256 };

    const [mapped] = await get_sequelize().query<{ version_id: string }>(
        'SELECT version_id FROM cliq.gethugs_templates WHERE org_id = :org_id AND sha256 = :sha256',
        { replacements: { org_id: input.org_id, sha256: hug.sha256 }, type: QueryTypes.SELECT },
    );
    if (mapped) return mapped.version_id;

    await HugBundlesService.resolve(hug, { bundle: input.bundle, may_upload: input.may_upload_bundle ?? false, realm_id: input.realm_id });
    const files = await HugBundlesService.read_files(hug.sha256);
    if (!files) throw new DetailedApiError('BUNDLE_MISSING', `CliqHub doesn't have the bundle of hug '${hug.name}' yet — send it`, 409, { sha256: hug.sha256 });

    const run = await Run.findOne({ where: { run_id: input.run_id }, attributes: ['team_label'], raw: true }) as { team_label: string | null } | null;
    const name = `${run?.team_label ?? 'team'}/${hug.name}`;
    try {
        const { items } = await partner.site.call<{ items: Template[] }>('templates/get', { org_id: g_org });
        const existing = items.find((t) => !t.builtin && t.name === name);
        let template_id: string;
        let version_id: string;
        if (existing) {
            // The reconcile owns which version is current (PLAN-gethugs-step8-4-cliqd.md); a run asks with its exact version.
            const added = await partner.site.call<{ version: { id: string } }>('templates/add_version', { org_id: g_org, id: existing.id, files, make_current: false });
            template_id = existing.id;
            version_id = added.version.id;
        } else {
            const made = await partner.site.call<Template>('templates/create', { org_id: g_org, name, files });
            template_id = made.id;
            version_id = made.current_version!.id;
        }
        await get_sequelize().query(
            `INSERT INTO cliq.gethugs_templates (org_id, sha256, name, template_id, version_id) VALUES (:org_id, :sha256, :name, :template_id, :version_id)
             ON CONFLICT (org_id, sha256) DO UPDATE SET template_id = EXCLUDED.template_id, version_id = EXCLUDED.version_id, name = EXCLUDED.name`,
            { replacements: { org_id: input.org_id, sha256: hug.sha256, name, template_id, version_id } },
        );
        log.info('gethugs_template_installed', { org_id: input.org_id, name, version_id });
        return version_id;
    } catch (err) {
        if (err instanceof HugsError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 && err.status !== 429) {
            throw new DetailedApiError('BUNDLE_INVALID', `getHugs refused the bundle of hug '${hug.name}': ${err.message}`, 422, { problems: err.details ?? {} });
        }
        throw relay_error(err, 'templates');
    }
}

/**
 * Channel names as getHugs takes them: cliq's "All realm members" / "All org members" → `all-workspace`; a name that
 * is no channel of the realm or org but an org member's username → that person's email (getHugs names people by
 * email). Anything else as is.
 */
async function channel_names(org_id: string, realm_id: string, names: readonly string[]): Promise<string[]> {
    const out = new Set<string>();
    for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;
        if (EVERYONE_CHANNELS.has(name.toLowerCase())) {
            out.add(GETHUGS_EVERYONE);
            continue;
        }
        const [channel] = await get_sequelize().query<{ id: string }>(
            `SELECT id FROM cliq.notification_channels WHERE name = :name AND user_id IS NULL
               AND (realm_id = :realm_id OR (org_id = :org_id AND realm_id IS NULL)) LIMIT 1`,
            { replacements: { name, realm_id, org_id }, type: QueryTypes.SELECT },
        );
        if (!channel) {
            const [person] = await get_sequelize().query<{ email: string }>(
                `SELECT u.email FROM cliq.users u JOIN cliq.org_members m ON m.user_id = u.id
                 WHERE lower(u.username) = lower(:name) AND m.org_id = :org_id AND m.status = 'active' AND m.deleted_at IS NULL LIMIT 1`,
                { replacements: { name: name.replace(/^@/, ''), org_id }, type: QueryTypes.SELECT },
            );
            if (person) {
                out.add(person.email);
                continue;
            }
        }
        out.add(name);
    }
    return [...out];
}

/**
 * getHugs' `via` (the channels that reached a responder) in the Hug's own cliq channel names: the reverse of
 * {@link channel_names} for this Hug's channels — a person's email back to the name cliq asked them by, `all-workspace`
 * back to the "everyone" channel the Hug named. A name none of its channels maps to is kept as it is.
 */
export async function cliq_via(hug: { org_id: string; realm_id: string; channels: readonly string[] }, via: readonly string[]): Promise<string[]> {
    const back = new Map<string, string[]>();
    for (const name of hug.channels) {
        const [sent] = await channel_names(hug.org_id, hug.realm_id, [name]);
        if (sent) back.set(sent.toLowerCase(), [...(back.get(sent.toLowerCase()) ?? []), name]);
    }
    return [...new Set(via.flatMap((v) => back.get(v.toLowerCase()) ?? [v]))];
}

/**
 * Opens a Hug in getHugs for a switched org and keeps Core's row for it. A retry with the daemon's `hug_id` returns
 * the same Hug (the `Idempotency-Key`, then Core's row).
 *
 * @throws 503 `gethugs_not_ready` — the org or the realm isn't in getHugs yet, or the hug's template is archived while
 *   its team is installed again (marked for the reconcile, which restores it; cliqd retries)
 * @throws 422 `invalid_hug` — an attachment or context file that isn't a ready file of the run
 * @throws 422 (getHugs' code) — getHugs refused it: an unknown channel, a non-member, …
 */
export async function gethugs_create(input: GethugsCreateInput, partner: GethugsPartner = gethugs_partner()): Promise<{ hug_id: string; hug_url: string }> {
    const spec = input.spec;
    const g_org = await link(input.org_id, 'org', input.org_id);
    const workspace = await link(input.org_id, 'realm', input.realm_id);
    if (!g_org || !workspace) {
        await gethugs_mark(input.org_id);
        throw ApiError.service_unavailable('This org is still being set up on getHugs — try again shortly', 'gethugs_not_ready');
    }

    let template: string;
    try {
        template = await template_for(partner, input, g_org);
    } catch (err) {
        throw err instanceof HugsError ? relay_error(err, 'templates/get') : err;
    }
    const channels = await channel_names(input.org_id, input.realm_id, spec.channels ?? []);
    const run = await Run.findOne({ where: { run_id: input.run_id }, attributes: ['team_label', 'run_name'], raw: true }) as { team_label: string | null; run_name: string | null } | null;
    const requester = `${run?.team_label ?? 'cliq'} · run ${input.run_id.slice(0, 8)}`;
    const id = input.hug_id ?? randomUUID();

    const client: HugsClient = partner.in_workspace(g_org, workspace, requester);
    let attachments: Awaited<ReturnType<typeof run_files_as_documents>>;
    try {
        attachments = await run_files_as_documents(client, workspace, input.run_id, spec);
    } catch (err) {
        throw err instanceof HugsError ? relay_error(err, 'documents/upload') : err;
    }
    let made: { id: string; expires_at: number };
    try {
        made = await client.hugs.create({
            ref_id: `cliqhub:run:${input.run_id}`,
            template,
            title: spec.title,
            ...(spec.summary ? { summary: spec.summary } : {}),
            params: spec.params,
            files: spec.files,
            ...(attachments.length ? { attachments } : {}),
            channels,
            context: { org: input.org_id, realm: input.realm_id, team: run?.team_label ?? null, run_id: input.run_id, phase: input.phase, iteration: input.iteration },
            expires_in_min: spec.expires_in_min!,
            ...(spec.reminders ? { reminders: spec.reminders } : {}),
        } as never, { idempotency_key: id }) as unknown as { id: string; expires_at: number };
    } catch (err) {
        const unresolved = err instanceof HugsError ? (err.details?.unresolved as string[] | undefined) : undefined;
        for (const name of unresolved ?? []) {
            await raise_unknown_channel({
                realm_id: input.realm_id, name, source: 'reviewers', for_event: 'hug.opened',
                run_id: input.run_id, phase: input.phase, daemon_id: input.daemon_id,
            });
        }
        // The template was archived while its team wasn't installed, and the team is back: the org's reconcile restores
        // it (marked now), and cliqd retries. A team that's gone keeps getHugs' refusal.
        const sha256 = spec.hug.sha256;
        if (is_template_archived(err) && sha256 && await gethugs_template_wanted(input.org_id, sha256)) {
            await gethugs_mark(input.org_id);
            log.info('gethugs_template_restoring', { org_id: input.org_id, run_id: input.run_id, hug: spec.hug.name });
            throw ApiError.service_unavailable('This hug\'s template is being restored on getHugs — try again shortly', 'gethugs_not_ready');
        }
        throw relay_error(err, 'hugs/create');
    }

    const now = new Date();
    try {
        await Hug.create({
            id,
            run_id: input.run_id,
            phase: input.phase,
            iteration: input.iteration,
            daemon_id: input.daemon_id,
            realm_id: input.realm_id,
            org_id: input.org_id,
            title: spec.title,
            hug_name: spec.hug.name,
            hug_sha256: spec.hug.sha256 ?? null,
            summary: spec.summary ?? null,
            params: spec.params,
            files: spec.files,
            attachments: spec.attachments,
            channels: spec.channels ?? [],
            status: 'open',
            outcome: null,
            expires_at: new Date(made.expires_at),
            last_seq: 0,
            created_at: now,
            closed_at: null,
            gethugs_id: made.id,
            gethugs_workspace_id: workspace,
        });
    } catch (err) {
        // A concurrent retry stored it first: the same Hug (getHugs gave both the same id). Anything else is an error.
        if (!(err instanceof UniqueConstraintError) || !(await Hug.findOne({ where: { id, gethugs_id: made.id }, attributes: ['id'], raw: true }))) throw err;
    }
    log.info('gethugs_hug_opened', { hug_id: id, gethugs_id: made.id, run_id: input.run_id, phase: input.phase });
    // Anything that happened before Core stored the row (the feed skipped it): applied now, once.
    const { gethugs_catch_up } = await import('./gethugs_feed.js');
    await gethugs_catch_up(id, partner);
    return { hug_id: id, hug_url: gethugs_hug_url(made.id) };
}

/** The partner's client in a getHugs Hug's org and workspace, or null when the org's link is gone. */
async function client_for(hug: Pick<Hug, 'org_id' | 'gethugs_workspace_id'>): Promise<HugsClient | null> {
    const g_org = await link(hug.org_id, 'org', hug.org_id);
    return g_org ? gethugs_partner().in_workspace(g_org, hug.gethugs_workspace_id) : null;
}

/**
 * The requester closes a getHugs Hug: getHugs `hugs/close`, and Core's row takes the status getHugs reports. A
 * failure is logged and the row left as it was — the run's end cancels the Hug anyway.
 */
export async function gethugs_close(hug: Hug, outcome: string): Promise<string> {
    const client = await client_for(hug);
    if (!client) return hug.status;
    try {
        const { status } = await client.call<{ status: string }>('hugs/close', { workspace_id: hug.gethugs_workspace_id, org_id: client.org, hug_id: hug.gethugs_id, outcome });
        if (status !== 'open' && hug.status === 'open') {
            await Hug.update({ status: status as Hug['status'], outcome: status === 'closed' ? outcome : hug.outcome, closed_at: new Date() }, { where: { id: hug.id, status: 'open' } });
        }
        log.info('gethugs_hug_closed', { hug_id: hug.id, gethugs_id: hug.gethugs_id, status });
        return status;
    } catch (err) {
        log.warn('gethugs_close_failed', { hug_id: hug.id, error: err instanceof Error ? err.message : String(err) });
        return hug.status;
    }
}

/** The requester's status line, to getHugs (`hugs/update_progress`). Best effort, like Core's own. */
export async function gethugs_progress(hug: Hug, progress: string | null): Promise<void> {
    const client = await client_for(hug);
    if (!client) return;
    try {
        await client.call('hugs/update_progress', { workspace_id: hug.gethugs_workspace_id, org_id: client.org, hug_id: hug.gethugs_id, progress });
    } catch (err) {
        log.warn('gethugs_progress_failed', { hug_id: hug.id, error: err instanceof Error ? err.message : String(err) });
    }
}

/**
 * A run ended: its open getHugs Hugs are cancelled with one `hugs/cancel` by the run's `ref_id` per workspace (safe to
 * repeat), and Core's rows marked cancelled. Best effort: a failure is logged; getHugs' expiry ends them anyway.
 *
 * @returns how many of Core's rows were cancelled
 */
export async function gethugs_cancel_run(run_id: string, hugs: Hug[]): Promise<number> {
    const by_workspace = new Map<string, Hug>();
    for (const h of hugs) if (h.gethugs_workspace_id && !by_workspace.has(h.gethugs_workspace_id)) by_workspace.set(h.gethugs_workspace_id, h);
    for (const [workspace_id, sample] of by_workspace) {
        const client = await client_for(sample);
        if (!client) continue;
        try {
            const { cancelled } = await client.call<{ cancelled: string[] }>('hugs/cancel', { workspace_id, org_id: client.org, ref_id: `cliqhub:run:${run_id}`, reason: 'The run ended' });
            log.info('gethugs_run_hugs_cancelled', { run_id, workspace_id, cancelled: cancelled.length });
        } catch (err) {
            log.warn('gethugs_cancel_failed', { run_id, workspace_id, error: err instanceof Error ? err.message : String(err) });
            return 0;
        }
    }
    // As Core's own Hugs at a run's end: each ends `cancelled` and its daemon is told. getHugs' own `hug.cancelled`
    // then finds it ended (PLAN-gethugs-step4-answers.md) and doesn't tell it twice.
    const { HugsService } = await import('./hugs.service.js');
    let count = 0;
    for (const h of hugs) {
        const ended = await get_sequelize().transaction(async (t) => {
            const [n] = await Hug.update({ status: 'cancelled', closed_at: new Date() }, { where: { id: h.id, status: 'open' }, transaction: t });
            if (n === 0) return false;
            await HugsService.relay_event(h, 'cancelled', { reason: 'The run ended' }, t);
            return true;
        });
        if (ended) count += 1;
    }
    return count;
}
