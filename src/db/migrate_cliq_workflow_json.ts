/**
 * One-shot data migrate: rebuild team_versions.workflow_json (and empty roles /
 * readme / agents) from the published package for ALL scopes.
 *
 * Workflow = top-level `phases` array (ordered). Nested `workflow:` is ignored.
 *
 * Idempotent for already-filled workflow (skips when phases.length > 0 unless --force).
 *
 * Usage:
 *   railway run --service cliqhub-backend npx tsx src/db/migrate_cliq_workflow_json.ts
 *   railway run --service cliqhub-backend npx tsx src/db/migrate_cliq_workflow_json.ts --force
 */

import pg from 'pg';
import { extract_package, workflow_from_team_yml } from '../services/package_parser.js';
import { create_package_storage, package_key, type StorageConfig } from '../storage/package_storage.js';

function storage_config_from_env(): StorageConfig {
	return {
		packages_path: process.env.PACKAGES_PATH || './data/packages',
		storage_backend: (process.env.STORAGE_BACKEND as 'local' | 'r2') || 'local',
		s3_endpoint: process.env.S3_ENDPOINT || '',
		s3_bucket: process.env.S3_BUCKET || '',
		s3_access_key_id: process.env.S3_ACCESS_KEY_ID || '',
		s3_secret_access_key: process.env.S3_SECRET_ACCESS_KEY || '',
	};
}

async function main(): Promise<void> {
	const force = process.argv.includes('--force');
	const database_url = process.env.DATABASE_URL;
	if (!database_url) throw new Error('DATABASE_URL required');

	const client = new pg.Client({ connectionString: database_url });
	await client.connect();
	const storage = create_package_storage(storage_config_from_env());

	const { rows } = await client.query<{
		version_id: number;
		name: string;
		scope: string | null;
		version: string;
		workflow_json: string;
		roles_json: string | null;
		readme: string | null;
		agents_json: string | null;
	}>(`
		SELECT v.id AS version_id, t.name, t.scope, v.version,
			v.workflow_json, v.roles_json, v.readme, v.agents_json
		FROM teams t
		JOIN team_versions v ON v.team_id = t.id
		ORDER BY t.scope NULLS FIRST, t.name, v.version
	`);

	let updated = 0;
	let skipped = 0;
	let missing_pkg = 0;
	let empty_yml = 0;

	for (const row of rows) {
		let existing_phases: unknown[] = [];
		try {
			const parsed = JSON.parse(row.workflow_json || '{}') as { phases?: unknown[] };
			existing_phases = Array.isArray(parsed.phases) ? parsed.phases : [];
		} catch { /* empty */ }

		let existing_roles: unknown[] = [];
		try {
			const parsed = JSON.parse(row.roles_json || '[]') as unknown[];
			existing_roles = Array.isArray(parsed) ? parsed : [];
		} catch { /* empty */ }

		const need_workflow = force || existing_phases.length === 0;
		const need_roles = existing_roles.length === 0;
		const need_readme = !(row.readme && row.readme.trim());
		let need_agents = false;
		try {
			const agents = JSON.parse(row.agents_json || '{}') as Record<string, unknown>;
			need_agents = Object.keys(agents).length === 0;
		} catch {
			need_agents = true;
		}

		if (!need_workflow && !need_roles && !need_readme && !need_agents) {
			skipped += 1;
			continue;
		}

		const key = package_key(row.name, row.version);
		let buf: Buffer | null = null;
		try {
			buf = await storage.read(key);
		} catch (err) {
			console.error(`  FAIL read ${key}:`, err instanceof Error ? err.message : err);
			missing_pkg += 1;
			continue;
		}
		if (!buf) {
			console.error(`  MISS package ${row.scope ?? '_'}/${row.name}@${row.version}`);
			missing_pkg += 1;
			continue;
		}

		const { team_yml, roles, readme } = await extract_package(buf);
		const workflow = workflow_from_team_yml(team_yml);
		if (need_workflow && workflow.phases.length === 0) {
			console.error(`  EMPTY phases in yml for ${row.scope ?? '_'}/${row.name}@${row.version}`);
			empty_yml += 1;
			if (!need_roles && !need_readme && !need_agents) continue;
		}

		const sets: string[] = [];
		const vals: unknown[] = [];
		let idx = 1;

		if (need_workflow && workflow.phases.length > 0) {
			sets.push(`workflow_json = $${idx++}`);
			vals.push(JSON.stringify(workflow));
		}
		if (need_roles && roles.length > 0) {
			const sorted = [...roles].sort((a, b) => a.name.localeCompare(b.name));
			sets.push(`roles_json = $${idx++}`);
			vals.push(JSON.stringify(sorted.map((r) => ({ name: r.name, content_md: r.content_md }))));
		}
		if (need_readme && readme.trim()) {
			sets.push(`readme = $${idx++}`);
			vals.push(readme);
		}
		if (need_agents && team_yml?.agents && Object.keys(team_yml.agents).length > 0) {
			sets.push(`agents_json = $${idx++}`);
			vals.push(JSON.stringify(team_yml.agents));
		}

		if (sets.length === 0) {
			if (need_workflow) empty_yml += 1;
			continue;
		}

		vals.push(row.version_id);
		await client.query(
			`UPDATE team_versions SET ${sets.join(', ')} WHERE id = $${idx}`,
			vals,
		);
		console.log(
			`  OK ${row.scope ?? '_'}/${row.name}@${row.version} `
			+ `phases=${workflow.phases.length} roles=${roles.length} `
			+ `readme=${readme.trim() ? 'yes' : 'no'}`,
		);
		updated += 1;
	}

	await client.end();
	console.log(JSON.stringify({ updated, skipped, missing_pkg, empty_yml, total: rows.length }));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
