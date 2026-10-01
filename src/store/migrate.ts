import type { Sequelize } from 'sequelize';

/**
 * Create schema (postgres) and sync store models.
 * `sync()` does not ALTER existing tables — apply additive column
 * upgrades after sync so older daemon.db files boot.
 */
export async function migrate_store(sequelize: Sequelize): Promise<void> {
	if (sequelize.getDialect() === 'postgres') {
		await sequelize.query('CREATE SCHEMA IF NOT EXISTS cliq');
	}
	await sequelize.sync();
	await ensure_daemon_permissions_column(sequelize);
	await ensure_daemon_name_column(sequelize);
	await ensure_run_context_columns(sequelize);
	await ensure_run_realm_id_column(sequelize);
	await ensure_run_phase_sequence_column(sequelize);
	await ensure_run_lease_expires_at_column(sequelize);
	await ensure_workspace_team_config_snapshot_column(sequelize);
	await ensure_run_hierarchy_columns(sequelize);
	await ensure_run_iteration_key_column(sequelize);
	await migrate_run_leaf_integer_pks_to_uuid(sequelize);
}

/**
 * Hard-cut: team_run_events / run_logs / run_artifacts PKs must be UUID.
 * No child FKs reference these ids. Existing int rows are reminted.
 */
async function migrate_run_leaf_integer_pks_to_uuid(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		await sqlite_rebuild_int_pk_as_uuid(sequelize, 'team_run_events', [
			'id', 'run_id', 'event_type', 'phase', 'agent', 'payload_json', 'created_at',
		]);
		await sqlite_rebuild_int_pk_as_uuid(sequelize, 'run_logs', [
			'id', 'run_id', 'chunk', 'created_at',
		]);
		await sqlite_rebuild_int_pk_as_uuid(sequelize, 'run_artifacts', [
			'id', 'run_id', 'phase', 'kind', 'name', 'content', 'mime_type',
			'target_phase', 'sequence', 'created_at',
		]);
		return;
	}

	if (dialect === 'postgres') {
		for (const table of ['team_run_events', 'run_logs', 'run_artifacts']) {
			await postgres_convert_int_pk_to_uuid(sequelize, 'cliq', table);
		}
	}
}

async function sqlite_pk_is_integer(sequelize: Sequelize, table: string): Promise<boolean> {
	if (!(await sqlite_table_exists(sequelize, table))) return false;
	const result = await sequelize.query(`PRAGMA table_info('${table}')`);
	const rows = Array.isArray(result) ? result[0] : result;
	if (!Array.isArray(rows)) return false;
	const pk = rows.find((r) => (r as { name?: string; pk?: number }).name === 'id'
		&& Number((r as { pk?: number }).pk) > 0);
	if (!pk) return false;
	const type = String((pk as { type?: string }).type || '').toUpperCase();
	return type.includes('INT') && !type.includes('CHAR') && !type.includes('TEXT');
}

async function sqlite_table_exists(sequelize: Sequelize, table: string): Promise<boolean> {
	const result = await sequelize.query(
		`SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
		{ replacements: [table] },
	);
	const rows = Array.isArray(result) ? result[0] : result;
	return Array.isArray(rows) && rows.length > 0;
}

async function sqlite_rebuild_int_pk_as_uuid(
	sequelize: Sequelize,
	table: string,
	columns: string[],
): Promise<void> {
	if (!(await sqlite_pk_is_integer(sequelize, table))) return;

	const new_table = `${table}__uuid`;
	const col_list = columns.join(', ');
	const select_cols = columns.map((c) => (
		c === 'id'
			? `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))`
			: c
	)).join(', ');

	await sequelize.query(`DROP TABLE IF EXISTS ${new_table}`);
	/* Create via sync shape: copy schema from existing then rewrite PK. */
	await sequelize.query(`CREATE TABLE ${new_table} AS SELECT ${select_cols} AS ${col_list.split(', ').join(', ')} FROM ${table} WHERE 0`);
	/* AS SELECT WHERE 0 can leave id as INT affinity — rebuild explicitly. */
	await sequelize.query(`DROP TABLE IF EXISTS ${new_table}`);

	if (table === 'team_run_events') {
		await sequelize.query(`
			CREATE TABLE ${new_table} (
				id TEXT PRIMARY KEY NOT NULL,
				run_id TEXT NOT NULL,
				event_type TEXT NOT NULL,
				phase TEXT,
				agent TEXT,
				payload_json TEXT,
				created_at BIGINT NOT NULL
			)
		`);
		await sequelize.query(`
			INSERT INTO ${new_table} (id, run_id, event_type, phase, agent, payload_json, created_at)
			SELECT
				lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
					substr(lower(hex(randomblob(2))), 2) || '-' ||
					substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
					lower(hex(randomblob(6))),
				run_id, event_type, phase, agent, payload_json, created_at
			FROM ${table}
		`);
	} else if (table === 'run_logs') {
		await sequelize.query(`
			CREATE TABLE ${new_table} (
				id TEXT PRIMARY KEY NOT NULL,
				run_id TEXT NOT NULL,
				chunk TEXT NOT NULL,
				created_at BIGINT NOT NULL
			)
		`);
		await sequelize.query(`
			INSERT INTO ${new_table} (id, run_id, chunk, created_at)
			SELECT
				lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
					substr(lower(hex(randomblob(2))), 2) || '-' ||
					substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
					lower(hex(randomblob(6))),
				run_id, chunk, created_at
			FROM ${table}
		`);
	} else if (table === 'run_artifacts') {
		await sequelize.query(`
			CREATE TABLE ${new_table} (
				id TEXT PRIMARY KEY NOT NULL,
				run_id TEXT NOT NULL,
				phase TEXT NOT NULL,
				kind TEXT NOT NULL,
				name TEXT NOT NULL,
				content TEXT NOT NULL,
				mime_type TEXT,
				target_phase TEXT,
				sequence INTEGER,
				created_at BIGINT NOT NULL
			)
		`);
		await sequelize.query(`
			INSERT INTO ${new_table} (id, run_id, phase, kind, name, content, mime_type, target_phase, sequence, created_at)
			SELECT
				lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
					substr(lower(hex(randomblob(2))), 2) || '-' ||
					substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
					lower(hex(randomblob(6))),
				run_id, phase, kind, name, content, mime_type, target_phase, sequence, created_at
			FROM ${table}
		`);
	} else {
		return;
	}

	await sequelize.query(`DROP TABLE ${table}`);
	await sequelize.query(`ALTER TABLE ${new_table} RENAME TO ${table}`);
	void col_list;
	void select_cols;
}

async function postgres_convert_int_pk_to_uuid(
	sequelize: Sequelize,
	schema: string,
	table: string,
	column = 'id',
): Promise<void> {
	const [rows] = await sequelize.query(
		`SELECT data_type FROM information_schema.columns
		 WHERE table_schema = '${schema.replace(/'/g, "''")}'
		   AND table_name = '${table.replace(/'/g, "''")}'
		   AND column_name = '${column.replace(/'/g, "''")}'`,
	);
	const dt = (rows as Array<{ data_type: string }>)[0]?.data_type;
	if (!dt) return;
	if (dt === 'uuid') {
		// Already converted — do not re-ALTER on every boot (AccessExclusiveLock).
		return;
	}
	if (dt !== 'integer' && dt !== 'bigint') return;

	await sequelize.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

	await sequelize.query(`
		DO $$
		DECLARE seq regclass;
		BEGIN
			SELECT pg_get_serial_sequence('${schema}.${table}', '${column}') INTO seq;
			IF seq IS NOT NULL THEN
				EXECUTE format(
					'ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT',
					'${schema}', '${table}', '${column}'
				);
				EXECUTE format('DROP SEQUENCE IF EXISTS %s CASCADE', seq);
			END IF;
		END $$;
	`);

	const new_col = `${column}_uuid`;
	await sequelize.query(`
		ALTER TABLE "${schema}"."${table}"
		ADD COLUMN IF NOT EXISTS "${new_col}" UUID
	`);
	await sequelize.query(`
		UPDATE "${schema}"."${table}"
		SET "${new_col}" = gen_random_uuid()
		WHERE "${new_col}" IS NULL
	`);
	await sequelize.query(`
		ALTER TABLE "${schema}"."${table}"
		ALTER COLUMN "${new_col}" SET NOT NULL
	`);
	await sequelize.query(`
		ALTER TABLE "${schema}"."${table}"
		ALTER COLUMN "${new_col}" SET DEFAULT gen_random_uuid()
	`);

	const [pks] = await sequelize.query(
		`SELECT tc.constraint_name
		 FROM information_schema.table_constraints tc
		 WHERE tc.constraint_type = 'PRIMARY KEY'
		   AND tc.table_schema = '${schema.replace(/'/g, "''")}'
		   AND tc.table_name = '${table.replace(/'/g, "''")}'`,
	);
	for (const pk of pks as Array<{ constraint_name: string }>) {
		await sequelize.query(`
			ALTER TABLE "${schema}"."${table}"
			DROP CONSTRAINT IF EXISTS "${pk.constraint_name}"
		`);
	}

	await sequelize.query(`ALTER TABLE "${schema}"."${table}" DROP COLUMN "${column}"`);
	await sequelize.query(`ALTER TABLE "${schema}"."${table}" RENAME COLUMN "${new_col}" TO "${column}"`);
	await sequelize.query(`ALTER TABLE "${schema}"."${table}" ADD PRIMARY KEY ("${column}")`);
}

/**
 * Additive: team_runs.lease_expires_at — Hub action lease (epoch ms).
 * See DESIGN-control-message-reliability Phase 3.
 */
async function ensure_run_lease_expires_at_column(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		if (!await sqlite_has_column(sequelize, 'team_runs', 'lease_expires_at')) {
			await sequelize.query(`ALTER TABLE team_runs ADD COLUMN lease_expires_at INTEGER`);
		}
		return;
	}

	if (dialect === 'postgres') {
		await sequelize.query(
			`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "lease_expires_at" BIGINT`,
		);
		await sequelize.query(
			`CREATE INDEX IF NOT EXISTS "team_runs_lease_expires_at_idx"
			 ON cliq."team_runs" ("lease_expires_at")
			 WHERE "lease_expires_at" IS NOT NULL AND "state" IN ('running', 'awaiting_input')`,
		);
	}
}

/**
 * Additive: team_run_phases.sequence — workflow order from create_many.
 * Do not backfill from timestamps; those disagree with YAML order.
 */
async function ensure_run_phase_sequence_column(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		if (!await sqlite_has_column(sequelize, 'team_run_phases', 'sequence')) {
			await sequelize.query(
				`ALTER TABLE team_run_phases ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0`,
			);
		}
		return;
	}

	if (dialect === 'postgres') {
		await sequelize.query(
			`ALTER TABLE cliq."team_run_phases" ADD COLUMN IF NOT EXISTS "sequence" INTEGER NOT NULL DEFAULT 0`,
		);
	}
}

/**
 * Additive: team_runs.realm_id — the realm a run was created for.
 *
 * Historical rows are backfilled via realm_members whenever we can trace
 * daemon_id back to a single realm. Runs whose daemon has already been
 * NULL'd stay null and rely on the daemon-hop fallback in list_recent.
 */
async function ensure_run_realm_id_column(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		if (!await sqlite_has_column(sequelize, 'team_runs', 'realm_id')) {
			await sequelize.query(`ALTER TABLE team_runs ADD COLUMN realm_id TEXT`);
		}
		return;
	}

	if (dialect === 'postgres') {
		await sequelize.query(
			`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "realm_id" TEXT`,
		);
		await sequelize.query(
			`CREATE INDEX IF NOT EXISTS "team_runs_realm_id_idx"
			 ON cliq."team_runs" ("realm_id") WHERE "realm_id" IS NOT NULL`,
		);
	}
}

/** Additive: daemons.permissions (JSON object, default {}). */
async function ensure_daemon_permissions_column(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		if (await sqlite_has_column(sequelize, 'daemons', 'permissions')) return;
		await sequelize.query(
			`ALTER TABLE daemons ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}'`,
		);
		return;
	}

	if (dialect === 'postgres') {
		await sequelize.query(
			`ALTER TABLE cliq.daemons ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb`,
		);
	}
}

/** Additive: daemons.name (optional display label from cliqd --name). */
async function ensure_daemon_name_column(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		if (await sqlite_has_column(sequelize, 'daemons', 'name')) return;
		await sequelize.query(`ALTER TABLE daemons ADD COLUMN name TEXT`);
		return;
	}

	if (dialect === 'postgres') {
		await sequelize.query(
			`ALTER TABLE cliq.daemons ADD COLUMN IF NOT EXISTS name TEXT`,
		);
	}
}

/** Additive: team_runs.external_id + team_runs.context_labels for run_context support. */
async function ensure_run_context_columns(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		if (!await sqlite_has_column(sequelize, 'team_runs', 'external_id')) {
			await sequelize.query(`ALTER TABLE team_runs ADD COLUMN external_id TEXT`);
		}
		if (!await sqlite_has_column(sequelize, 'team_runs', 'context_labels')) {
			await sequelize.query(`ALTER TABLE team_runs ADD COLUMN context_labels TEXT`);
		}
		return;
	}

	if (dialect === 'postgres') {
		await sequelize.query(
			`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "external_id" TEXT`,
		);
		await sequelize.query(
			`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "context_labels" JSONB`,
		);
		await sequelize.query(
			`CREATE UNIQUE INDEX IF NOT EXISTS "team_runs_external_id_uniq"
			 ON cliq."team_runs" ("external_id") WHERE "external_id" IS NOT NULL`,
		);
	}
}

/**
 * Additive: workspace_teams.config_snapshot — assembly-time DaemonConfig snapshot (JSON text).
 */
async function ensure_workspace_team_config_snapshot_column(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		if (await sqlite_has_column(sequelize, 'workspace_teams', 'config_snapshot')) return;
		await sequelize.query(`ALTER TABLE workspace_teams ADD COLUMN config_snapshot TEXT`);
		return;
	}

	if (dialect === 'postgres') {
		await sequelize.query(
			`ALTER TABLE cliq."workspace_teams" ADD COLUMN IF NOT EXISTS "config_snapshot" TEXT`,
		);
	}
}

/**
 * Additive: team_runs.root_run_id, call_path, call_depth —
 * hierarchical run identification for nested team calls.
 *
 * Backfill: existing root runs (parent_run_id IS NULL) get
 * root_run_id = run_id, call_path = '[]', call_depth = 0.
 */
async function ensure_run_hierarchy_columns(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		if (!await sqlite_has_column(sequelize, 'team_runs', 'root_run_id')) {
			await sequelize.query(`ALTER TABLE team_runs ADD COLUMN root_run_id TEXT`);
			/* Backfill root runs. */
			await sequelize.query(
				`UPDATE team_runs SET root_run_id = run_id WHERE parent_run_id IS NULL AND root_run_id IS NULL`,
			);
		}
		if (!await sqlite_has_column(sequelize, 'team_runs', 'call_path')) {
			await sequelize.query(`ALTER TABLE team_runs ADD COLUMN call_path TEXT DEFAULT '[]'`);
		}
		if (!await sqlite_has_column(sequelize, 'team_runs', 'call_depth')) {
			await sequelize.query(`ALTER TABLE team_runs ADD COLUMN call_depth INTEGER NOT NULL DEFAULT 0`);
		}
		return;
	}

	if (dialect === 'postgres') {
		await sequelize.query(
			`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "root_run_id" TEXT`,
		);
		await sequelize.query(
			`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "call_path" TEXT DEFAULT '[]'`,
		);
		await sequelize.query(
			`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "call_depth" INTEGER NOT NULL DEFAULT 0`,
		);
		/* Backfill root runs. */
		await sequelize.query(
			`UPDATE cliq."team_runs" SET root_run_id = run_id WHERE parent_run_id IS NULL AND root_run_id IS NULL`,
		);
		/* Index for tree queries. */
		await sequelize.query(
			`CREATE INDEX IF NOT EXISTS "team_runs_root_run_id_idx"
			 ON cliq."team_runs" ("root_run_id") WHERE "root_run_id" IS NOT NULL`,
		);
	}
}

/**
 * Additive: team_runs.iteration_key — map phase iteration identifier.
 * Null for non-map runs. Set to the resolved key string for each map iteration.
 */
async function ensure_run_iteration_key_column(sequelize: Sequelize): Promise<void> {
	const dialect = sequelize.getDialect();
	if (dialect === 'sqlite') {
		if (await sqlite_has_column(sequelize, 'team_runs', 'iteration_key')) return;
		await sequelize.query(`ALTER TABLE team_runs ADD COLUMN iteration_key TEXT`);
		return;
	}

	if (dialect === 'postgres') {
		await sequelize.query(
			`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "iteration_key" TEXT`,
		);
	}
}

async function sqlite_has_column(
	sequelize: Sequelize,
	table: string,
	column: string,
): Promise<boolean> {
	const result = await sequelize.query(`PRAGMA table_info('${table}')`);
	const rows = Array.isArray(result) ? result[0] : result;
	if (!Array.isArray(rows)) return false;
	return rows.some((r) => (r as { name?: string }).name === column);
}
