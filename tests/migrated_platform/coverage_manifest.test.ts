import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const coverage_map: Record<string, string> = {
    'e2e/access_matrix.e2e.test.ts': 'tests/migrated_platform/access.service.test.ts',
    'e2e/agents.e2e.test.ts': 'tests/migrated_platform/agent.service.test.ts',
    'e2e/daemons.e2e.test.ts': 'tests/migrated_platform/daemon.service.test.ts',
    'e2e/dashboard.e2e.test.ts': 'tests/integration/core_api_smoke.test.ts',
    'e2e/dispatch.e2e.test.ts': 'tests/migrated_platform/dispatch.service.install.test.ts',
    'e2e/dispatch_poll.e2e.test.ts': 'tests/unit/dispatch.service.test.ts',
    'e2e/events.e2e.test.ts': 'tests/migrated_platform/events.e2e.test.ts',
    'e2e/notifications.e2e.test.ts': 'tests/migrated_platform/notification.service.test.ts',
    'e2e/org_dispatch_keys.e2e.test.ts': 'tests/integration/core_api_control_plane.test.ts',
    'e2e/realms.e2e.test.ts': 'tests/migrated_platform/realm.service.test.ts',
    'e2e/runs.e2e.test.ts': 'tests/migrated_platform/run.service.test.ts',
    'e2e/scopes.e2e.test.ts': 'tests/migrated_platform/scope.service.test.ts',
    'e2e/settings.e2e.test.ts': 'tests/migrated_platform/settings.service.test.ts',
    'e2e/sync.e2e.test.ts': 'tests/unit/dispatch.service.test.ts',
    'e2e/system.e2e.test.ts': 'tests/integration/core_api_smoke.test.ts',
    'e2e/teams.e2e.test.ts': 'tests/migrated_platform/team.service.test.ts',
    'e2e/workspaces.e2e.test.ts': 'tests/migrated_platform/workspace.service.test.ts',
    'spec/access.service.test.ts': 'tests/migrated_platform/access.service.test.ts',
    'spec/agent.service.test.ts': 'tests/migrated_platform/agent.service.test.ts',
    'spec/api_error.test.ts': 'tests/unit/middleware/error_handler.test.ts',
    'spec/auth.middleware.test.ts': 'tests/unit/core_api/require_auth.test.ts',
    'spec/config.test.ts': 'tests/unit/config/env.test.ts',
    'spec/daemon.service.test.ts': 'tests/migrated_platform/daemon.service.test.ts',
    'spec/database.test.ts': 'tests/unit/db/control_plane_store.test.ts',
    'spec/dispatch.service.auth.test.ts': 'tests/unit/auth/access.test.ts',
    'spec/dispatch.service.errors.test.ts': 'tests/migrated_platform/dispatch.service.install.test.ts',
    'spec/dispatch.service.install.test.ts': 'tests/migrated_platform/dispatch.service.install.test.ts',
    'spec/dispatch.service.resolve.test.ts': 'tests/migrated_platform/dispatch.service.install.test.ts',
    'spec/dispatch_jwt.test.ts': 'tests/unit/auth/jwt.test.ts',
    'spec/events_submit.test.ts': 'tests/unit/core_api/events_submit.test.ts',
    'spec/events_types.test.ts': 'tests/unit/core_api/events_types.test.ts',
    'spec/jwt.test.ts': 'tests/unit/auth/jwt.test.ts',
    'spec/notification.service.test.ts': 'tests/migrated_platform/notification.service.test.ts',
    'spec/org_dispatch_key.service.test.ts': 'tests/integration/core_api_control_plane.test.ts',
    'spec/realm.service.test.ts': 'tests/migrated_platform/realm.service.test.ts',
    'spec/realm_schema.test.ts': 'tests/integration/schema_coexistence.test.ts',
    'spec/run.service.test.ts': 'tests/migrated_platform/run.service.test.ts',
    'spec/scope.service.test.ts': 'tests/migrated_platform/scope.service.test.ts',
    'spec/seed.test.ts': 'tests/unit/db/control_plane_seed.test.ts',
    'spec/settings.service.test.ts': 'tests/migrated_platform/settings.service.test.ts',
    'spec/sync.service.test.ts': 'tests/unit/dispatch.service.test.ts',
    'spec/team.service.test.ts': 'tests/migrated_platform/team.service.test.ts',
    'spec/workspace.service.test.ts': 'tests/migrated_platform/workspace.service.test.ts',
    'unit/grants.test.ts': 'tests/unit/auth/grants.test.ts',
};

describe('platform test coverage manifest', () => {
    it('maps every former platform test to an existing Hub coverage file', () => {
        expect(Object.keys(coverage_map)).toHaveLength(44);

        for (const [platform_file, hub_file] of Object.entries(coverage_map)) {
            expect(
                existsSync(resolve(process.cwd(), hub_file)),
                `${platform_file} maps to missing ${hub_file}`,
            ).toBe(true);
        }
    });
});
