/**
 * connect_store — thin shim kept for backward compatibility.
 *
 * Previously this opened a separate Sequelize connection for the
 * control-plane store (daemons, runs, realms). Now that registry and
 * store models share a single Sequelize instance (both connect to the
 * same DATABASE_URL), this module just wraps `init_sequelize` so
 * existing callers in `control_plane_store.ts` and tests don't need
 * immediate changes.
 */

import { Sequelize } from 'sequelize';
import { init_store_models } from '../models/index.js';
import { init_sequelize } from '../db/sequelize.js';

export type ConnectStoreOptions = {
    readonly dialect: 'postgres';
    readonly db_url: string;
    readonly ssl?: boolean;
};

export type StoreConnection = {
    readonly sequelize: Sequelize;
    close(): Promise<void>;
};

export async function connect_store(opts: ConnectStoreOptions): Promise<StoreConnection> {
    const sequelize = init_sequelize(opts.db_url);
    init_store_models(sequelize);
    await sequelize.authenticate();
    return {
        sequelize,
        async close() {
            await sequelize.close();
        },
    };
}
