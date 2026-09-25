/**
 * Parity harness: every route formerly served by cliq-platform/bff must exist
 * on Hub backend (`src/routes/` per-resource files).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend_root = path.resolve(here, '../../..');
const routes_dir = path.join(backend_root, 'src/routes');

/** Former cliq-platform/bff /v1 surface (method + path). */
const PLATFORM_BFF_ROUTES: Array<{ method: 'GET' | 'POST'; path: string }> = [
	{ method: 'GET', path: '/health' },
	{ method: 'POST', path: '/daemons/register' },
	{ method: 'POST', path: '/daemons/heartbeat' },
	{ method: 'POST', path: '/system/seed' },
	{ method: 'POST', path: '/daemons/deregister' },
	{ method: 'POST', path: '/daemons/get' },
	{ method: 'POST', path: '/daemons/get_by_id' },
	{ method: 'POST', path: '/daemons/ack_command' },
	{ method: 'POST', path: '/teams/install' },
	{ method: 'POST', path: '/teams/uninstall' },
	{ method: 'POST', path: '/auth/get_dispatch_public_key' },
	{ method: 'POST', path: '/auth/rotate_dispatch_key' },
	{ method: 'POST', path: '/runs/enqueue' },
	{ method: 'POST', path: '/runs/claim' },
	{ method: 'POST', path: '/runs/cancel' },
	{ method: 'POST', path: '/runs/resume' },
	{ method: 'POST', path: '/runs/supply_inputs' },
	// Phase 4 / AG-1b: get_details (was get_by_id); catalog is get/get_details/register/deregister.
	{ method: 'POST', path: '/agents/get' },
	{ method: 'POST', path: '/agents/get_details' },
	{ method: 'POST', path: '/agents/register' },
	{ method: 'POST', path: '/agents/deregister' },
	{ method: 'POST', path: '/agents/get_settings' },
	{ method: 'POST', path: '/agents/update_settings' },
	{ method: 'POST', path: '/workspaces/get' },
	{ method: 'POST', path: '/workspaces/get_by_id' },
	{ method: 'POST', path: '/workspaces/remove' },
	{ method: 'POST', path: '/runs/get' },
	{ method: 'POST', path: '/runs/get_by_id' },
	{ method: 'POST', path: '/runs/create' },
	{ method: 'POST', path: '/runs/complete' },
	{ method: 'POST', path: '/runs/report_activity' },
	{ method: 'POST', path: '/runs/append_logs' },
	{ method: 'POST', path: '/runs/get_logs' },
	{ method: 'POST', path: '/runs/report_telemetry' },
	{ method: 'POST', path: '/runs/get_telemetry' },
	{ method: 'POST', path: '/runs/get_status' },
	{ method: 'POST', path: '/runs/update_status' },
	{ method: 'POST', path: '/runs/artifacts/create' },
	{ method: 'POST', path: '/control/scopes/get' },
	{ method: 'POST', path: '/control/scopes/get_by_id' },
	{ method: 'POST', path: '/control/scopes/get_by_slug' },
	{ method: 'POST', path: '/control/scopes/get_default' },
	{ method: 'POST', path: '/control/scopes/set_default' },
	{ method: 'POST', path: '/control/scopes/add' },
	{ method: 'POST', path: '/control/scopes/remove' },
	{ method: 'POST', path: '/control/scopes/resolve' },
	{ method: 'POST', path: '/settings/get' },
	{ method: 'POST', path: '/settings/get_by_key' },
	{ method: 'POST', path: '/settings/set' },
	{ method: 'POST', path: '/settings/remove' },
	{ method: 'POST', path: '/events/submit' },
	{ method: 'POST', path: '/events/get_by_id' },
	{ method: 'POST', path: '/events/types/list' },
	{ method: 'POST', path: '/reviews/get' },
	{ method: 'POST', path: '/notification_channels/get' },
	{ method: 'POST', path: '/notification_channels/create' },
	{ method: 'POST', path: '/notification_channels/update' },
	{ method: 'POST', path: '/notification_channels/remove' },
	{ method: 'POST', path: '/notification_channels/test' },
	{ method: 'POST', path: '/notifications/get' },
	{ method: 'POST', path: '/orgs/get_notification_rules' },
	{ method: 'POST', path: '/orgs/set_notification_rule' },
	{ method: 'POST', path: '/orgs/remove_notification_rule' },
	{ method: 'POST', path: '/realms/get_notification_rules' },
	{ method: 'POST', path: '/realms/set_notification_rule' },
	{ method: 'POST', path: '/realms/remove_notification_rule' },
	{ method: 'POST', path: '/auth/generate_token' },
	{ method: 'POST', path: '/auth/get_tokens' },
	{ method: 'POST', path: '/auth/revoke_token' },
	{ method: 'POST', path: '/auth/rotate_token' },
	// Realm hard-cut (no get_by_slug / grant / revoke / members/* / team-list)
	{ method: 'POST', path: '/realms/create' },
	{ method: 'POST', path: '/realms/get' },
	{ method: 'POST', path: '/realms/get_by_id' },
	{ method: 'POST', path: '/realms/update' },
	{ method: 'POST', path: '/realms/delete' },
	{ method: 'POST', path: '/realms/get_members' },
	{ method: 'POST', path: '/realms/add_member' },
	{ method: 'POST', path: '/realms/remove_member' },
	{ method: 'POST', path: '/realms/add_team' },
	{ method: 'POST', path: '/realms/remove_team' },
	{ method: 'POST', path: '/realms/a2a' },
];

function extract_registered_paths(src: string): Set<string> {
	const paths = new Set<string>();
	for (const match of src.matchAll(
		/\.(?:get|post)\(\s*['"`](\/[A-Za-z0-9_./-]+)['"`]/g,
	)) {
		const raw = match[1];
		paths.add(raw);
		// Absolute `/v1/...` mounts also count as relative `/...`
		if (raw.startsWith('/v1/')) paths.add(raw.slice(3));
	}
	return paths;
}

function collect_routes_sources(dir: string): string {
	const parts: string[] = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			parts.push(collect_routes_sources(full));
			continue;
		}
		if (ent.name.endsWith('.ts')) {
			parts.push(fs.readFileSync(full, 'utf8'));
		}
	}
	return parts.join('\n');
}

describe('platform BFF → Hub route inventory', () => {
	it('registers every former platform BFF path on Hub backend', () => {
		const routes_src = collect_routes_sources(routes_dir);
		const registered = extract_registered_paths(routes_src);

		const missing = PLATFORM_BFF_ROUTES
			.filter((r) => !registered.has(r.path))
			.map((r) => `${r.method} ${r.path}`);

		expect(missing, `Missing Hub routes:\n${missing.join('\n')}`).toEqual([]);
	});
});
