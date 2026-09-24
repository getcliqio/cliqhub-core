// VO → DTO mappers.
// Grows per slice as types are added.

import type { UserVO, DraftVO, DraftListItemVO } from './vo.js';
import type { UserDTO, TeamListItemDTO, DraftDTO, DraftListItemDTO } from './dto.js';

export function to_user_dto(user: UserVO): UserDTO {
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
): TeamListItemDTO {
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

export function to_draft_dto(row: DraftVO): DraftDTO {
    return {
        id: row.id,
        title: row.title,
        team_json: row.team_json,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

export function to_draft_list_item_dto(row: DraftListItemVO): DraftListItemDTO {
    return {
        id: row.id,
        title: row.title,
        updated_at: row.updated_at,
    };
}
