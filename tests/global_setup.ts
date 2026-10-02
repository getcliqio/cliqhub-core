import { ensure_test_database, test_database_url } from './test_database.js';

export default async function global_setup(): Promise<void> {
    await ensure_test_database(test_database_url);
}
