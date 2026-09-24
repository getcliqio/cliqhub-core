import { Sequelize } from 'sequelize';

let _sequelize: Sequelize | null = null;

/**
 * Whether the connection should negotiate TLS.
 *
 * Local hosts and Railway's private network (*.railway.internal) speak plain
 * TCP. Managed providers / Railway public proxy URLs require SSL (often with
 * a self-signed chain — verification is relaxed).
 *
 * Shared with the control-plane (`cliq` schema) store connection so both
 * Sequelize instances on the same DATABASE_URL use identical TLS policy.
 */
export function should_use_ssl(database_url: string): boolean {
    if (database_url.includes('localhost')) {
        return false;
    }
    if (database_url.includes('127.0.0.1')) {
        return false;
    }
    if (database_url.includes('.railway.internal')) {
        return false;
    }
    return true;
}

export function init_sequelize(database_url: string): Sequelize {
    const ssl_enabled = should_use_ssl(database_url);
    _sequelize = new Sequelize(database_url, {
        dialect: 'postgres',
        logging: process.env.SEQUELIZE_LOG === '1' ? console.log : false,
        define: {
            timestamps: false,
            underscored: true,
            freezeTableName: true,
        },
        // Managed Postgres (Railway et al.) silently drops idle TCP
        // connections after ~5 min. Without these guards the pool re-hands
        // out a dead socket, the query never resolves, and every worker
        // that awaits it (command_outbox delivery, dispatch, sweepers)
        // freezes for several minutes until connections are rebuilt.
        //
        // Layered defenses (belt + braces):
        //   1. Evict idle clients BEFORE the provider kills them.
        //   2. TCP keepalive so a half-open socket is detected fast.
        //   3. statement/query timeouts so a hung query errors out
        //      instead of pinning the worker indefinitely.
        //   4. Short acquire timeout so callers fail fast on pool
        //      exhaustion rather than blocking the event loop.
        pool: {
            max: 10,
            min: 0,
            acquire: 30_000,
            idle: 30_000,
            evict: 5_000,
        },
        dialectOptions: {
            ...(ssl_enabled ? { ssl: { require: true, rejectUnauthorized: false } } : {}),
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000,
            statement_timeout: 30_000,
            query_timeout: 30_000,
        },
    });
    return _sequelize;
}

export function get_sequelize(): Sequelize {
    if (!_sequelize) throw new Error('Sequelize not initialized — call init_sequelize first');
    return _sequelize;
}

export async function close_sequelize(): Promise<void> {
    if (_sequelize) {
        await _sequelize.close();
        _sequelize = null;
    }
}
