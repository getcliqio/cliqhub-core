/**
 * Data Transfer Objects — re-exports + legacy shapes.
 *
 * Agents: response DTOs in `schemas/agents/data.ts`; inbound Zod in
 * `schemas/agents/inputs.ts` (`Agents*Input` — type inferred from schema).
 */

import type { BooleanData, EntityOrBooleanData } from './api_response.js';

export type { BooleanData, EntityOrBooleanData };

export { AgentData } from '../schemas/agents/data.js';
export type { AgentsData } from '../schemas/agents/data.js';
export * from '../schemas/agents/inputs.js';
export { SettingDef, SettingsData, setting_def_schema, settings_data_schema } from '../schemas/settings_schemas.js';

/** @deprecated Use SettingsData. */
export type { AgentSettingsData } from '../schemas/settings_schemas.js';
export { ManifestInput } from '../schemas/common/manifest.js';

// ── Legacy hand-written DTOs (migrate next) ──────────────────────────

export type UserDto = {
    id: string;
    username: string;
    display_name: string;
    email: string;
    role: string;
    suspended_at: string | null;
    suspended_reason: string;
    created_at: string;
};

export type TeamListItemDto = {
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
};

export type DraftDto = {
    id: string;
    title: string;
    team_json: string;
    created_at: string;
    updated_at: string;
};

export type DraftListItemDto = {
    id: string;
    title: string;
    updated_at: string;
};

/** @deprecated Prefer PascalCase `*Dto` names. */
export type UserDTO = UserDto;
/** @deprecated Prefer PascalCase `*Dto` names. */
export type TeamListItemDTO = TeamListItemDto;
/** @deprecated Prefer PascalCase `*Dto` names. */
export type DraftDTO = DraftDto;
/** @deprecated Prefer PascalCase `*Dto` names. */
export type DraftListItemDTO = DraftListItemDto;
