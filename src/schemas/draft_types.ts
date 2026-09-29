import { z } from 'zod';

export const drafts_get_by_id_schema = z.object({
    id: z.string().uuid({ message: 'id must be a uuid' }),
});

export const drafts_new_schema = z.object({
    title: z.string().optional(),
    team_json: z.string().min(1, 'team_json is required'),
});

export const drafts_update_schema = z.object({
    id: z.string().uuid({ message: 'id must be a uuid' }),
    title: z.string().optional(),
    team_json: z.string().min(1, 'team_json is required'),
});

export const drafts_delete_schema = z.object({
    id: z.string().uuid({ message: 'id must be a uuid' }),
});


/**
 * Canonical wire shape for a draft list item (used in paginated lists).
 * Replaces DraftListItemDto / DraftListItemVo.
 */
export const DraftListItemData = z.object({
    id: z.string().uuid()
        .describe('Draft UUID'),
    title: z.string()
        .describe('Draft title'),
    updated_at: z.string()
        .describe('ISO timestamp of last update'),
});

export type DraftListItemData = z.infer<typeof DraftListItemData>;

/**
 * Canonical wire shape for a full draft (get_by_id).
 * Replaces DraftDto / DraftVo.
 */
export const DraftDetailData = z.object({
    id: z.string().uuid()
        .describe('Draft UUID'),
    user_id: z.string().uuid()
        .describe('UUID of the owning user'),
    title: z.string()
        .describe('Draft title'),
    team_json: z.string()
        .describe('Serialized team definition JSON'),
    created_at: z.string()
        .describe('ISO timestamp of draft creation'),
    updated_at: z.string()
        .describe('ISO timestamp of last update'),
});

export type DraftDetailData = z.infer<typeof DraftDetailData>;


// ── Internal persistence shapes ─────────────────────────────────────────────

export type DraftVo = {
    id: string;
    user_id: string;
    title: string;
    team_json: string;
    created_at: string;
    updated_at: string;
};

export type DraftListItemVo = {
    id: string;
    title: string;
    updated_at: string;
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

/** @deprecated Use PascalCase `*Vo` names. */
export type DraftVO = DraftVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type DraftListItemVO = DraftListItemVo;
/** @deprecated Prefer PascalCase `*Dto` names. */
export type DraftDTO = DraftDto;
/** @deprecated Prefer PascalCase `*Dto` names. */
export type DraftListItemDTO = DraftListItemDto;
