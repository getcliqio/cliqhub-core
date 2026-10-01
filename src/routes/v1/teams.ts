/**
 * Teams routes — catalog CRUD, versioning, publish/unpublish, install/uninstall, download, rename, and builder build.
 *
 * POST   /v1/teams/get
 * POST   /v1/teams/get_by_id
 * POST   /v1/teams/get_versions
 * POST   /v1/teams/get_phases
 * POST   /v1/teams/create
 * POST   /v1/teams/update
 * POST   /v1/teams/publish
 * POST   /v1/teams/unpublish
 * POST   /v1/teams/download
 * POST   /v1/teams/delete
 * POST   /v1/teams/delete_version
 * POST   /v1/teams/rename
 * POST   /v1/teams/install
 * POST   /v1/teams/uninstall
 * POST   /v1/teams/build
 */
import type { Router } from 'express';
import type { Container } from '../../container.js';
import { no_store } from '../../middleware/no_store.js';

/** Catalog + build + install/uninstall — single `/v1/teams/*` plane. */
export function register_teams_routes(
    router: Router,
    container: Container,
): void {
    const { teams_controller, config } = container;

    router.post('/teams/get',            no_store, teams_controller.wrap(teams_controller.get));
    router.post('/teams/get_by_id',      no_store, teams_controller.wrap(teams_controller.get_by_id));
    router.post('/teams/get_versions',   no_store, teams_controller.wrap(teams_controller.get_versions));
    router.post('/teams/get_phases',     no_store, teams_controller.wrap(teams_controller.get_phases));
    router.post('/teams/create', teams_controller.wrap(teams_controller.create));
    router.post('/teams/update', teams_controller.wrap(teams_controller.update));
    router.post('/teams/publish', teams_controller.wrap(teams_controller.publish));
    router.post('/teams/unpublish', teams_controller.wrap(teams_controller.unpublish));
    router.post('/teams/download',                 teams_controller.wrap(teams_controller.download));
    router.post('/teams/delete', teams_controller.wrap(teams_controller.delete_team));
    router.post('/teams/delete_version', teams_controller.wrap(teams_controller.delete_version));
    router.post('/teams/rename', teams_controller.wrap(teams_controller.rename));
    router.post('/teams/install', teams_controller.wrap(teams_controller.install));
    router.post('/teams/uninstall', teams_controller.wrap(teams_controller.uninstall));

    router.post('/teams/build', teams_controller.wrap(teams_controller.build));
}
