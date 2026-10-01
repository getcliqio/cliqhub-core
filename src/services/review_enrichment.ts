/**
 * Shared joins for HUG review list/detail — team, run name, realm, artifacts.
 */

import { Op } from 'sequelize';

import { get_logger } from '../lib/log.js';
import type { DaemonTeam } from '../models/daemon_team.model.js';
import { RealmRepository } from '../repositories/realm_repository.js';
import { RunRepository } from '../repositories/run_repository.js';
import { RunArtifactRepository } from '../repositories/run_artifact_repository.js';
import { DaemonTeamRepository } from '../repositories/daemon_team_repository.js';
import { ScopeRepository } from '../repositories/scope_repository.js';

const log = get_logger('svc.review_enrichment');

const _realm_repo_re = new RealmRepository();
const _run_repo_re = new RunRepository();
const _run_artifact_repo = new RunArtifactRepository();
const _dt_repo_re = new DaemonTeamRepository();
const _scope_repo_re = new ScopeRepository();
import { org_slug_by_ids } from './realm.service.js';

export interface ReviewRealmInfo {
	realm_id: string;
	realm_name: string | null;
	realm_slug: string | null;
	org_slug: string | null;
}

export interface ReviewRunInfo {
	run_id: string;
	run_name: string | null;
	team: string | null;
}

export interface ReviewArtifactInfo {
	id: number;
	phase: string;
	kind: string;
	name: string;
	mime_type: string | null;
	content: string;
	content_preview: string;
	sequence: number | null;
}

const PREVIEW_CHARS = 4_000;

function team_label(team: DaemonTeam, scope_slug: string | undefined): string {
	if (scope_slug) return `@${scope_slug}/${team.slug}`;
	return team.slug || String(team.id);
}

function payload_team(payload: Record<string, unknown> | null | undefined): string | null {
	if (!payload) return null;
	if (typeof payload.team === 'string' && payload.team.trim()) return payload.team.trim();
	return null;
}

export async function load_realm_info_map(
	realm_ids: string[],
): Promise<Map<string, ReviewRealmInfo>> {
	log.debug('load_realm_info_map', {});
	const unique = [...new Set(realm_ids.filter(Boolean))];
	const map = new Map<string, ReviewRealmInfo>();
	if (unique.length === 0) return map;

	const rows = await _realm_repo_re.find_all_q({
		where: { id: { [Op.in]: unique } },
		attributes: ['id', 'name', 'slug', 'org_id'],
	});

	// Bulk-resolve org slugs for the realm org_ids.
	const org_ids = [...new Set(rows.map((r) => r.org_id).filter(Boolean))] as string[];
	const org_slug_map = org_ids.length > 0
		? await org_slug_by_ids(org_ids)
		: new Map<string, string>();

	for (const row of rows) {
		map.set(row.id, {
			realm_id: row.id,
			realm_name: row.name?.trim() || null,
			realm_slug: row.slug?.trim() || null,
			org_slug: row.org_id ? (org_slug_map.get(row.org_id) ?? null) : null,
		});
	}
	return map;
}

export async function load_run_info_map(run_ids: string[]): Promise<Map<string, ReviewRunInfo>> {
	log.debug('load_run_info_map', {});
	const unique = [...new Set(run_ids.filter(Boolean))];
	const map = new Map<string, ReviewRunInfo>();
	if (unique.length === 0) return map;

	const runs = await _run_repo_re.find_all_q({
		where: { run_id: { [Op.in]: unique } },
		attributes: ['run_id', 'run_name', 'team_id'],
	});
	const team_ids = [...new Set(runs.map((r) => r.team_id).filter(Boolean))];
	const teams = team_ids.length === 0
		? []
		: await _dt_repo_re.find_all_q({
			where: { id: { [Op.in]: team_ids } },
		});

	const scope_ids = [...new Set(teams.map((t) => t.scope_id).filter(Boolean))];
	const scopes = scope_ids.length === 0
		? []
		: await _scope_repo_re.find_all_q({ where: { id: { [Op.in]: scope_ids } }, attributes: ['id', 'slug'] });
	const scope_slug_by_id = new Map(scopes.map((s) => [s.id, s.slug]));

	const team_by_id = new Map(
		teams.map((t) => [String(t.id), team_label(t, scope_slug_by_id.get(t.scope_id))]),
	);

	for (const run of runs) {
		map.set(run.run_id, {
			run_id: run.run_id,
			run_name: run.run_name?.trim() || null,
			team: run.team_id ? (team_by_id.get(String(run.team_id)) ?? null) : null,
		});
	}
	return map;
}

export async function load_artifact_counts(run_ids: string[]): Promise<Map<string, number>> {
	log.debug('load_artifact_counts', {});
	const unique = [...new Set(run_ids.filter(Boolean))];
	const map = new Map<string, number>();
	if (unique.length === 0) return map;

	const rows = await _run_artifact_repo.find_all_q({
		where: { run_id: { [Op.in]: unique } },
		attributes: ['run_id'],
	});
	for (const row of rows) {
		map.set(row.run_id, (map.get(row.run_id) ?? 0) + 1);
	}
	return map;
}

export async function load_artifacts_for_run(run_id: string): Promise<ReviewArtifactInfo[]> {
	log.debug('load_artifacts_for_run', { run_id });
	if (!run_id) return [];
	const rows = await _run_artifact_repo.find_all_q({
		where: { run_id },
		order: [['id', 'ASC']],
	});
	return rows.map((row) => {
		const content = row.content ?? '';
		const preview = content.length > PREVIEW_CHARS
			? `${content.slice(0, PREVIEW_CHARS)}\n…`
			: content;
		return {
			id: Number(row.id),
			phase: row.phase,
			kind: row.kind,
			name: row.name,
			mime_type: row.mime_type,
			content,
			content_preview: preview,
			sequence: row.sequence ?? null,
		};
	});
}

export function resolve_team(
	payload: Record<string, unknown> | null | undefined,
	run_info: ReviewRunInfo | undefined,
): string | null {
	return payload_team(payload) ?? run_info?.team ?? null;
}
