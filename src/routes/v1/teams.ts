import type { Router, RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { no_store } from '../../middleware/no_store.js';
import { create_builder_auth } from '../../middleware/builder_auth.js';

/** Catalog + build + install/uninstall — single `/v1/teams/*` plane. */
export function register_teams_routes(
    router: Router,
    auth: RequestHandler,
    container: Container,
): void {
    const { teams_controller, config } = container;

    router.post('/teams/get',            no_store, teams_controller.wrap(teams_controller.get));
    router.post('/teams/get_by_id',      no_store, teams_controller.wrap(teams_controller.get_by_id));
    router.post('/teams/get_versions',   no_store, teams_controller.wrap(teams_controller.get_versions));
    router.post('/teams/get_phases',     no_store, teams_controller.wrap(teams_controller.get_phases));
    router.post('/teams/create',         auth,     teams_controller.wrap(teams_controller.create));
    router.post('/teams/update',         auth,     teams_controller.wrap(teams_controller.update));
    router.post('/teams/publish',        auth,     teams_controller.wrap(teams_controller.publish));
    router.post('/teams/unpublish',      auth,     teams_controller.wrap(teams_controller.unpublish));
    router.post('/teams/download',                 teams_controller.wrap(teams_controller.download));
    router.post('/teams/delete',         auth,     teams_controller.wrap(teams_controller.delete_team));
    router.post('/teams/delete_version', auth,     teams_controller.wrap(teams_controller.delete_version));
    router.post('/teams/rename',         auth,     teams_controller.wrap(teams_controller.rename));
    router.post('/teams/install',        auth,     teams_controller.wrap(teams_controller.install));
    router.post('/teams/uninstall',      auth,     teams_controller.wrap(teams_controller.uninstall));

    const builder_auth = create_builder_auth(config.jwt_secret, config.allowed_origins);
    router.post('/teams/build', builder_auth, teams_controller.wrap(teams_controller.build));
}
