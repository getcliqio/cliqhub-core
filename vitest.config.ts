import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert_not_dev_database, test_database_url } from './tests/test_database.js';

const here = path.dirname(fileURLToPath(import.meta.url));

assert_not_dev_database(test_database_url);

export default defineConfig({
    test: {
        globals: true,
        root: '.',
        include: ['tests/**/*.test.ts'],
        fileParallelism: false,
        globalSetup: ['./tests/global_setup.ts'],
        // Every DB-backed test reads one of these; both point at the dedicated test database.
        env: {
            DATABASE_URL: test_database_url,
            CLIQHUB_TEST_DATABASE_URL: test_database_url,
        },
        // Resolve supertest et al. from sibling BFF when backend node_modules is incomplete.
        server: {
            deps: {
                moduleDirectories: [
                    'node_modules',
                    path.resolve(here, '../bff/node_modules'),
                ],
            },
        },
        // Control-plane migrate + schema migrations routinely take 30–60s on local Postgres.
        hookTimeout: 300_000,
        testTimeout: 180_000,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
                'src/server.ts',
                'src/container.ts',
                'src/app.ts',
                'src/db/**',
                'src/types/dto.ts',
                'src/types/vo.ts',
                // Control-plane is exercised by integration smoke, not unit coverage.
                'src/core_api/**',
            ],
        },
    },
    resolve: {
        alias: {
            // Prefer local installs; fall back via NODE_PATH in scripts when needed.
        },
    },
});
