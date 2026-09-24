import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { TeamsService } from '../services/teams_service.js';
import type { BuilderService } from '../services/builder_service.js';
import { ApiError } from '../errors/api_error.js';
import {
    teams_get_schema, teams_get_by_id_schema,
    teams_get_versions_schema,
    teams_get_phases_schema,
    teams_create_schema, teams_update_schema,
    publish_schema, unpublish_schema, download_schema,
    delete_team_schema, delete_version_schema,
    rename_schema,
} from '../schemas/teams_schemas.js';
import { teams_build_schema } from '../schemas/builder_schemas.js';
import { to_team_list_item_dto } from '../types/mappers.js';

export class TeamsController extends BaseController {
    constructor(
        private _teams_service: TeamsService,
        private _builder_service?: BuilderService,
    ) {
        super();
    }

    get = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(teams_get_schema, req);

        /** Live installed teams on a daemon (hard-cut from /v1/daemons/teams/get). */
        if (body.daemon_id) {
            if (!req.auth?.user) {
                throw new ApiError('unauthorized', 'Authentication required', 401);
            }
            const { live_teams_from_daemon } = await import(
                '../services/daemon_live_inventory.service.js'
            );
            const result = await live_teams_from_daemon(
                body.daemon_id,
                String(req.auth.user.id),
            );
            this.ok(res, result);
            return;
        }

        /** Realm roster mode — control-plane coverage (hard-cut from /v1/realms/teams/get). */
        if (body.realm_id) {
            if (!req.auth?.user) {
                throw new ApiError('unauthorized', 'Authentication required', 401);
            }
            const { RealmService } = await import('../services/realm.service.js');
            const result = await RealmService.list_team_coverage(
                {
                    realm_id: body.realm_id,
                    query: body.query,
                    origin: body.origin,
                    coverage: body.coverage,
                    sort_by: body.sort_by,
                    sort_dir: body.sort_dir,
                    limit: body.limit,
                    offset: body.offset,
                },
                String(req.auth.user.id),
            );
            this.ok(res, {
                ...result,
                offset: body.offset ?? 0,
                limit: body.limit ?? 50,
            });
            return;
        }

        const result = await this._teams_service.get(req.auth, body);
        if ('scopes' in result && result.tag_map) {
            const tag_map = result.tag_map as Map<string, string[]>;
            const scopes = (result.scopes as any[]).map((sg) => ({
                ...sg,
                teams: (sg.teams as any[]).map((t) => to_team_list_item_dto(t, tag_map.get(t.id) || [])),
            }));
            this.ok(res, { scopes });
            return;
        }
        if ('teams' in result && 'tag_map' in result && result.tag_map) {
            const tag_map = result.tag_map as Map<string, string[]>;
            const teams = (result.teams as any[]).map(t => to_team_list_item_dto(t, tag_map.get(t.id) || []));
            this.ok(res, { teams, total: (result as any).total, limit: (result as any).limit, offset: (result as any).offset });
            return;
        }
        this.ok(res, result);
    });

    get_by_id = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(teams_get_by_id_schema, req);
        const result = await this._teams_service.get_by_id(req.auth, body);
        this.ok(res, result);
    });

    get_versions = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(teams_get_versions_schema, req);
        const result = await this._teams_service.get_versions(req.auth, body);
        this.ok(res, result);
    });

    get_phases = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(teams_get_phases_schema, req);
        const result = await this._teams_service.get_phases(req.auth, body);
        this.ok(res, result);
    });

    create = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(teams_create_schema, req);
        const result = await this._teams_service.create(req.auth, body);
        this.ok(res, result);
    });

    update = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(teams_update_schema, req);
        const result = await this._teams_service.update(req.auth, body);
        this.ok(res, result);
    });

    publish = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(publish_schema, req);
        const result = await this._teams_service.publish(req.auth, body);
        this.ok(res, result);
    });

    unpublish = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(unpublish_schema, req);
        const result = await this._teams_service.unpublish(req.auth, body);
        this.ok(res, result);
    });

    download = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(download_schema, req);
        const result = await this._teams_service.download(req.auth, body);
        this.ok(res, result);
    });

    delete_team = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(delete_team_schema, req);
        const result = await this._teams_service.delete_team(req.auth, body);
        this.ok(res, result);
    });

    delete_version = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(delete_version_schema, req);
        const result = await this._teams_service.delete_version(req.auth, body);
        this.ok(res, result);
    });

    rename = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(rename_schema, req);
        const result = await this._teams_service.rename_team(req.auth, body);
        this.ok(res, result);
    });

    // ─── Single build resource: POST /v1/teams/build { action } ────

    private _require_builder(): BuilderService {
        if (!this._builder_service) {
            throw new ApiError('internal', 'Builder service not configured', 500);
        }
        return this._builder_service;
    }

    build = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(teams_build_schema, req);
        const builder = this._require_builder();

        switch (body.action) {
            case 'generate': {
                const result = builder.start_generate(req.auth, { intent: body.intent! });
                this.ok(res, result);
                return;
            }
            case 'status': {
                const result = builder.get_generate_job(body.job_id!);
                this.ok(res, result);
                return;
            }
            case 'improve_role': {
                const result = await builder.improve_role(req.auth, {
                    role_name: body.role_name!,
                    role_content: body.role_content!,
                    team_name: body.team_name ?? '',
                    team_description: body.team_description ?? '',
                    phases: (body.phases as string[] | undefined) ?? [],
                    instruction: body.instruction,
                });
                this.ok(res, result);
                return;
            }
            case 'suggest': {
                const result = await builder.suggest(req.auth, {
                    team_name: body.team_name!,
                    description: body.description ?? '',
                    phases: body.phases ?? [],
                    roles: body.roles ?? [],
                });
                this.ok(res, result);
                return;
            }
            case 'validate': {
                const result = builder.validate(req.auth, { team: body.team });
                this.ok(res, result);
                return;
            }
            case 'chat': {
                const result = await builder.chat(req.auth, {
                    team: body.team,
                    message: body.message!,
                    history: body.history,
                });
                this.ok(res, result);
                return;
            }
        }
    });
}
