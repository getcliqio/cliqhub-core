import pg from 'pg';

/**
 * Creates a connection pool to the shared Postgres database.
 * The sync service uses raw pg (no ORM) for its own tables.
 */
export function create_pool(database_url: string): pg.Pool {
    const pool = new pg.Pool({
        connectionString: database_url,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl: should_use_ssl(database_url) ? { rejectUnauthorized: false } : undefined,
    });

    pool.on('error', (err) => {
        console.error('[Sync] Unexpected pool error:', err.message);
    });

    return pool;
}

function should_use_ssl(url: string): boolean {
    return url.includes('sslmode=require')
        || url.includes('.railway.app')
        || url.includes('.neon.')
        || url.includes('.supabase.');
}
