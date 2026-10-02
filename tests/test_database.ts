import pg from 'pg';

/** The dev database seeded by scripts/seed_admin.mjs. Tests wipe whole tables, so they must never use it. */
const DEV_DATABASE_NAME = 'cliqhub';

export const test_database_url =
    process.env.CLIQHUB_TEST_DATABASE_URL
    ?? 'postgresql://cliqhub:cliqhub@localhost:5432/cliqhub_test';

function database_name(url: string): string {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

export function assert_not_dev_database(url: string): void {
    if (database_name(url) !== DEV_DATABASE_NAME) return;
    throw new Error(
        `Refusing to run tests against the dev database "${DEV_DATABASE_NAME}" — tests truncate tables. `
        + 'Set CLIQHUB_TEST_DATABASE_URL to a dedicated database (default cliqhub_test).',
    );
}

/** Create the test database when it does not exist yet (needs CREATEDB on the role). */
export async function ensure_test_database(url: string): Promise<void> {
    assert_not_dev_database(url);
    const name = database_name(url);
    const admin_url = new URL(url);
    admin_url.pathname = '/postgres';
    const client = new pg.Client({ connectionString: admin_url.toString() });
    try {
        await client.connect();
    } catch {
        return;
    }
    try {
        const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        if (found.rowCount === 0) {
            await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
        }
    } finally {
        await client.end();
    }
}
