import { create_test_app } from '../../helpers/test_container.js';
import { SequelizeAccessStore } from '../../../src/auth/route_policy/store.js';

/** DB-backed test app: the route policy reads the same Postgres rows as the handlers. */
export function create_migrated_test_app() {
    return create_test_app({ route_policy: new SequelizeAccessStore() });
}
