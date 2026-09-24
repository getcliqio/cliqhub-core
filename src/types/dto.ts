// Data Transfer Objects — API response contracts.
// Grows per slice as controllers are added.

export interface UserDTO {
    id: string;
    username: string;
    display_name: string;
    email: string;
    role: string;
    suspended_at: string | null;
    suspended_reason: string;
    created_at: string;
}

export interface TeamListItemDTO {
    id?: string;
    name: string;
    scope: string | null;
    description: string;
    author: string | null;
    latest_version: string;
    install_count: number;
    tags: string[];
    listed: boolean;
    visibility?: string;
    status?: 'draft' | 'published';
}

export interface DraftDTO {
    id: string;
    title: string;
    team_json: string;
    created_at: string;
    updated_at: string;
}

export interface DraftListItemDTO {
    id: string;
    title: string;
    updated_at: string;
}
