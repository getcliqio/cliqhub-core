/**
 * Full Hub HTTP app against live Postgres (registry + control-plane).
 * Mirrors production boot: control-plane store first, then create_container + create_app.
 */

import type { Express } from 'express';

import { create_app } from '../../../src/app.js';
import { create_container, type Container } from '../../../src/container.js';
import type { EnvConfig } from '../../../src/config/env.js';
import {
    close_control_plane_store,
    init_control_plane_store,
} from '../../../src/db/control_plane_store.js';
import { close_sequelize } from '../../../src/db/sequelize.js';
import { database_url } from './control_plane_store.js';
import { test_config } from '../../helpers/test_container.js';
import { test_packages_path } from './version_files.js';

export type Live_hub = {
    app: Express;
    container: Container;
    config: EnvConfig;
};

export function live_hub_config(): EnvConfig {
    return {
        ...test_config(),
        database_url,
        jwt_secret: 'test-secret',
        // The same file storage as every other test on this database: the app's container sets the content
        // reader's storage, and a version's files must be where the version was written (PLAN-team-bundle S1.4b).
        packages_path: test_packages_path,
    };
}

export async function open_live_hub_app(): Promise<Live_hub> {
    await close_control_plane_store();
    await close_sequelize();
    await init_control_plane_store(database_url);
    const config = live_hub_config();
    const container = await create_container(config);
    const app = create_app(container);
    return { app, container, config };
}

export async function close_live_hub_app(): Promise<void> {
    await close_control_plane_store();
    await close_sequelize();
}
