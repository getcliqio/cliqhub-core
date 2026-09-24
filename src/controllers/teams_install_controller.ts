import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { TeamService } from '../services/teams_install_service.js';
import { DispatchService } from '../services/dispatch.service.js';
import { RealmService } from '../services/realm.service.js';
import { Team, Scope } from '../models/index.js';
import { ApiError } from '../lib/api_error.js';
import { authorize_scope } from '../middleware/core_auth.js';

const get_schema = z.object({
    scope_id: z.string().optional(),
    /**
     * When present and `global` is false, restricts the result to teams
     * owned by this daemon (Design Z per-daemon list). When absent or
     * when `global` is true, the query returns every team across
     * daemons. Nullable because the CLI serializes `undefined` as
     * `null` when no daemon is registered yet.
     */
    daemon_id: z.string().nullable().optional(),
    global: z.boolean().optional(),
});

const get_by_slug_schema = z.object({
    scope_id: z.string(),
    slug: z.string(),
    /**
     * Restrict lookup to this daemon (Design Z). Nullable so callers
     * can transmit "unknown / cross-daemon" as an explicit `null`. When
     * absent or null the first row across daemons is returned — used
     * sparingly (e.g. for cross-daemon routing). Nearly all callers
     * want the daemon they're running on.
     */
    daemon_id: z.string().nullable().optional(),
});

const get_by_id_schema = z.object({
    id: z.string(),
});

const create_schema = z.object({
    scope_id: z.string(),
    slug: z.string(),
    version: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    manifest: z.unknown(),
    dockerfile: z.unknown().optional().nullable(),
    dependencies: z.unknown().optional().nullable(),
    /**
     * Owning daemon (Design Z). The CLI reads this from
     * `~/.cliqrc/settings.json`. Nullable so legacy clients still
     * function, but new clients always send it.
     */
    daemon_id: z.string().nullable().optional(),
});

const update_schema = z.object({
    scope_id: z.string(),
    slug: z.string(),
    version: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    manifest: z.unknown().optional(),
    dockerfile: z.unknown().optional().nullable(),
    dependencies: z.unknown().optional().nullable(),
});

const remove_schema = z.object({
    scope_id: z.string(),
    slug: z.string(),
});

const count_by_scope_schema = z.object({
    scope_id: z.string(),
});

/**
 * Daemon → Hub team upsert. The daemon's outbox drives this when a team
 * is installed/updated locally. `scope_slug` is the required key since
 * daemon and Hub have independent scope UUIDs; Hub auto-creates the
 * scope row if absent.
 */
const upsert_from_daemon_schema = z.object({
    id: z.string(),
    scope_slug: z.string(),
    slug: z.string(),
    version: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    manifest: z.string(),
    dockerfile: z.string().nullable().optional(),
    dependencies: z.string().nullable().optional(),
    daemon_id: z.string().nullable().optional(),
    tx_id: z.string().optional(),
});

const remove_from_daemon_schema = z.object({
    team_id: z.string().optional(),
    scope_slug: z.string(),
    slug: z.string(),
    daemon_id: z.string().nullable().optional(),
    tx_id: z.string().optional(),
});

/** Fleet install — exactly one of daemon_ids or realm_id. */
const install_schema = z.object({
    team_id: z.string(),
    daemon_ids: z.array(z.string().min(1)).optional(),
    realm_id: z.string().optional(),
    agent_settings: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    force: z.boolean().optional(),
    version: z.string().optional(),
}).refine((v) => {
    const has_daemons = (v.daemon_ids?.length ?? 0) > 0;
    const has_realm = Boolean(v.realm_id);
    return has_daemons !== has_realm;
}, {
    message: 'Provide exactly one of daemon_ids or realm_id',
});

/** Fleet uninstall — exactly one of daemon_id(s) or realm_id. */
const uninstall_schema = z.object({
    scope: z.string().min(1),
    slug: z.string().min(1),
    daemon_id: z.string().min(1).optional(),
    daemon_ids: z.array(z.string().min(1)).optional(),
    realm_id: z.string().min(1).optional(),
}).refine((v) => {
    const ids = [
        ...(v.daemon_id ? [v.daemon_id] : []),
        ...(v.daemon_ids ?? []),
    ];
    const has_daemons = ids.length > 0;
    const has_realm = Boolean(v.realm_id);
    return has_daemons !== has_realm;
}, {
    message: 'Provide exactly one of daemon_id/daemon_ids or realm_id',
});

export class TeamController {
    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { scope_id, daemon_id, global } = get_schema.parse(req.body);
            if (scope_id) {
                authorize_scope(req, scope_id);
            }
            const scope_filter = scope_id ?? req.user?.scope_ids;
            // Default is per-daemon (Design Z). `global: true` bypasses
            // that filter to return every team across daemons for the
            // caller's accessible scopes — used by `cliq team list --global`
            // and by routing logic. `daemon_id: null` also bypasses the
            // filter (equivalent semantic to omitting the field).
            const daemon_filter = !global && daemon_id ? daemon_id : undefined;
            const teams = await TeamService.list(scope_filter, { daemon_id: daemon_filter });
            res.json({ ok: true, teams });
        } catch (err) { next(err); }
    }

    static async get_by_slug(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { scope_id, slug, daemon_id } = get_by_slug_schema.parse(req.body);
            // Design Z: existing endpoint stayed 404-on-miss for
            // backwards compat with callers that expect a boolean-y
            // return. To let install-time duplicate checks distinguish
            // "not installed here" from "not installed anywhere",
            // we return null instead of throwing when the team is
            // simply missing.
            const team = await TeamService.find(scope_id, slug, { daemon_id: daemon_id ?? undefined });
            res.json({ ok: true, team });
        } catch (err) { next(err); }
    }

    static async get_by_id(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id } = get_by_id_schema.parse(req.body);
            const team = await TeamService.get_by_id(id);
            res.json({ ok: true, team });
        } catch (err) { next(err); }
    }

    static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = create_schema.parse(req.body);
            const team = await TeamService.create(
                data.scope_id, data.slug,
                data.version ?? null, data.description ?? null,
                data.manifest as string,
                {
                    dockerfile: (data.dockerfile as string) ?? null,
                    dependencies: (data.dependencies as string) ?? null,
                    daemon_id: data.daemon_id ?? null,
                },
            );
            res.json({ ok: true, team });
        } catch (err) { next(err); }
    }

    static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = update_schema.parse(req.body);
            const team = await TeamService.update(data.scope_id, data.slug, {
                manifest: data.manifest as string | undefined,
                version: data.version ?? undefined,
                description: data.description ?? undefined,
                dockerfile: (data.dockerfile as string) ?? undefined,
                dependencies: (data.dependencies as string) ?? undefined,
            });
            res.json({ ok: true, team });
        } catch (err) { next(err); }
    }

    static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { scope_id, slug } = remove_schema.parse(req.body);
            const removed = await TeamService.remove(scope_id, slug);
            res.json({ ok: true, removed });
        } catch (err) { next(err); }
    }

    static async count_by_scope(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { scope_id } = count_by_scope_schema.parse(req.body);
            const count = await TeamService.count_by_scope(scope_id);
            res.json({ ok: true, count });
        } catch (err) { next(err); }
    }

    /**
     * Daemon-facing team upsert. Wire endpoint `POST /v1/teams/upsert`.
     * Idempotent via `tx_id` (inbound_dedup middleware) plus `Team.upsert`.
     */
    static async upsert_from_daemon(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = upsert_from_daemon_schema.parse(req.body);
            const { team, created } = await TeamService.upsert_from_daemon({
                id: data.id,
                scope_slug: data.scope_slug,
                slug: data.slug,
                version: data.version ?? null,
                description: data.description ?? null,
                manifest: data.manifest,
                dockerfile: data.dockerfile ?? null,
                dependencies: data.dependencies ?? null,
                daemon_id: data.daemon_id ?? null,
            });
            res.json({ ok: true, team, created });
        } catch (err) { next(err); }
    }

    /**
     * Daemon-facing team remove. Wire endpoint `POST /v1/teams/remove`.
     * Idempotent — returns `removed: false` when nothing matched.
     */
    static async remove_from_daemon(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = remove_from_daemon_schema.parse(req.body);
            const removed = await TeamService.remove_from_daemon({
                team_id: data.team_id,
                scope_slug: data.scope_slug,
                slug: data.slug,
                daemon_id: data.daemon_id ?? null,
            });
            res.json({ ok: true, removed });
        } catch (err) { next(err); }
    }

    // ── Slice 4: fleet install / uninstall (former /dispatch/install|uninstall) ──

    /** POST /v1/teams/install — fan-out install (daemon_ids XOR realm_id). */
    static async install(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = install_schema.parse(req.body);
            const result = await DispatchService.install_via_queue({
                ...data,
                org_ids: req.user?.org_ids ?? [],
                user_id: req.user?.user_id ?? '',
                scope_ids: req.user?.scope_ids ?? [],
            });
            res.json({ ok: true, ...result });
        } catch (err) {
            next(err);
        }
    }

    /** POST /v1/teams/uninstall — purge Hub cache then fan-out uninstall. */
    static async uninstall(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = uninstall_schema.parse(req.body);
            const daemon_ids = [
                ...(data.daemon_id ? [data.daemon_id] : []),
                ...(data.daemon_ids ?? []),
            ];

            await TeamController._purge_team_cache(
                data.scope, data.slug, data.realm_id, daemon_ids,
            );

            const result = await DispatchService.uninstall_via_queue({
                scope: data.scope,
                slug: data.slug,
                realm_id: data.realm_id,
                daemon_ids: daemon_ids.length > 0 ? daemon_ids : undefined,
                user_id: req.user?.user_id ?? '',
                org_ids: req.user?.org_ids ?? [],
            });

            res.json({
                ok: true,
                dispatched: result.results.some((r) => r.ok),
                ...result,
            });
        } catch (err) {
            next(err);
        }
    }

    /** Delete cliq.teams rows for a scope/slug across targeted daemons. */
    private static async _purge_team_cache(
        scope_slug: string,
        team_slug: string,
        realm_id?: string,
        daemon_ids?: string[],
    ): Promise<void> {
        const scope_row = await Scope.findOne({ where: { slug: scope_slug }, attributes: ['id'] });
        if (!scope_row) return;

        const where: Record<string, unknown> = { scope_id: scope_row.id, slug: team_slug };

        if (daemon_ids && daemon_ids.length > 0) {
            where.daemon_id = { [Op.in]: daemon_ids };
        } else if (realm_id) {
            const realm_daemon_ids = await RealmService.list_daemon_ids_in_realm(realm_id);
            if (realm_daemon_ids.length === 0) return;
            where.daemon_id = { [Op.in]: realm_daemon_ids };
        }

        await Team.destroy({ where } as any);
    }
}
