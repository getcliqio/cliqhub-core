/**
 * VO → DTO mappers for the Hub API wire layer.
 *
 * Each function projects an internal value object or Sequelize row onto the
 * public response shape. No business logic — pure structural transformation.
 */

import type { UserVo, UserDto } from '../schemas/user_types.js';
import type { DraftVo, DraftListItemVo, DraftDto, DraftListItemDto } from '../schemas/draft_types.js';
import type { TeamListItemDto } from '../schemas/team_types.js';
import type { AgentData } from '../schemas/agent_types.js';
import type { RunData } from '../schemas/run_types.js';
import type { AgentCatalog } from '../models/agent_catalog.model.js';
import type { Run } from '../models/index.js';

export function to_user_dto(user: UserVo): UserDto {
    return {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        email: user.email,
        role: user.role,
        suspended_at: user.suspended_at,
        suspended_reason: user.suspended_reason,
        created_at: user.created_at,
    };
}

export function to_team_list_item_dto(
    row: {
        id?: string;
        name: string;
        scope: string | null;
        description: string;
        author: string | null;
        latest_version: string | null;
        install_count: number;
        listed?: number;
        visibility?: string;
        /** Site-admin listing only. */
        version_count?: number;
        /** Site-admin listing only. */
        author_id?: string | null;
    },
    tags: string[],
): TeamListItemDto {
    const visibility = row.visibility || 'public';
    return {
        ...(row.version_count !== undefined ? { version_count: Number(row.version_count) } : {}),
        ...(row.author_id !== undefined ? { author_id: row.author_id } : {}),
        id: row.id,
        name: row.name,
        scope: row.scope,
        description: row.description,
        author: row.author,
        latest_version: row.latest_version || '0.0.0',
        install_count: row.install_count,
        tags,
        listed: row.listed !== undefined ? !!row.listed : true,
        visibility,
        status: visibility === 'draft' ? 'draft' : 'published',
    };
}

export function to_draft_dto(row: DraftVo): DraftDto {
    return {
        id: row.id,
        title: row.title,
        team_json: row.team_json,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

export function to_draft_list_item_dto(row: DraftListItemVo): DraftListItemDto {
    return {
        id: row.id,
        title: row.title,
        updated_at: row.updated_at,
    };
}

function ts_ms(value: Date | string | number): number {
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();
    return new Date(value).getTime();
}

/** Project an AgentCatalog row to AgentData. */
export function to_agent_data(row: InstanceType<typeof AgentCatalog>, include_manifest: boolean): AgentData {
    const base: AgentData = {
        id: row.id,
        name: row.name,
        version: row.version ?? null,
        description: row.description ?? null,
        agent_type: row.agent_type,
        is_system: row.is_system,
        created_at: ts_ms(row.created_at),
        updated_at: ts_ms(row.updated_at),
    };
    if (!include_manifest) return base;
    return { ...base, manifest: row.manifest };
}

function coerce_ms(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    return null;
}

/**
 * Project an enriched run plain object (or Sequelize Run) to wire RunData.
 * Accepts `_enrich_run` output or `run.toJSON()` (+ optional detail fields).
 */
export function to_run_data(
    row: InstanceType<typeof Run> | Record<string, unknown>,
    detail?: Partial<Pick<RunData, 'pending_control' | 'force_terminate' | 'state_lost_at' | 'team_version_id'>>,
): RunData {
    const plain_raw = typeof (row as InstanceType<typeof Run>).toJSON === 'function'
        ? (row as InstanceType<typeof Run>).toJSON()
        : row;
    const plain = plain_raw as unknown as Record<string, unknown>;

    const started = coerce_ms(plain.started_at) ?? 0;
    const completed = coerce_ms(plain.completed_at);
    const lease = coerce_ms(plain.lease_expires_at);
    const last_updated = coerce_ms(plain.last_updated_at) ?? completed ?? started;

    const data: RunData = {
        run_id: String(plain.run_id ?? ''),
        workspace_id: String(plain.workspace_id ?? ''),
        team_id: String(plain.team_id ?? ''),
        daemon_id: plain.daemon_id == null ? null : String(plain.daemon_id),
        realm_id: plain.realm_id == null ? null : String(plain.realm_id),
        parent_run_id: plain.parent_run_id == null ? null : String(plain.parent_run_id),
        parent_phase: plain.parent_phase == null ? null : String(plain.parent_phase),
        root_run_id: plain.root_run_id == null ? null : String(plain.root_run_id),
        call_path: plain.call_path == null ? null : String(plain.call_path),
        call_depth: typeof plain.call_depth === 'number' ? plain.call_depth : Number(plain.call_depth ?? 0),
        iteration_key: plain.iteration_key == null ? null : String(plain.iteration_key),
        run_name: plain.run_name == null ? null : String(plain.run_name),
        state: String(plain.state ?? 'running'),
        inputs: plain.inputs ?? null,
        error: plain.error == null ? null : String(plain.error),
        execution_type: String(plain.execution_type ?? 'local'),
        current_pid: plain.current_pid == null ? null : Number(plain.current_pid),
        current_phase: plain.current_phase == null ? null : String(plain.current_phase),
        external_id: plain.external_id == null ? null : String(plain.external_id),
        context_labels: plain.context_labels ?? null,
        lease_expires_at: lease,
        started_at: started,
        completed_at: completed,
        team_label: plain.team_label == null ? null : String(plain.team_label),
        workspace_name: plain.workspace_name == null ? null : String(plain.workspace_name),
        workspace_dir: plain.workspace_dir == null ? null : String(plain.workspace_dir),
        last_updated_at: last_updated,
    };

    if (detail?.pending_control !== undefined) data.pending_control = detail.pending_control;
    if (detail?.force_terminate !== undefined) data.force_terminate = detail.force_terminate;
    if (detail?.state_lost_at !== undefined) data.state_lost_at = detail.state_lost_at;
    if (detail?.team_version_id !== undefined) data.team_version_id = detail.team_version_id;

    return data;
}
