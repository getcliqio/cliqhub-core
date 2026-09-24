/**
 * VO → DTO mappers.
 */

import type { UserVo, DraftVo, DraftListItemVo } from './vo.js';
import type { UserDto, TeamListItemDto, DraftDto, DraftListItemDto } from './dto.js';
import type { AgentData } from '../schemas/agents_schemas.js';
import type { AgentCatalog } from '../models/agent_catalog.model.js';

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
    },
    tags: string[],
): TeamListItemDto {
    const visibility = row.visibility || 'public';
    return {
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
